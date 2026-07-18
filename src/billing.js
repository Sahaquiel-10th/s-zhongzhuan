import { config } from './config.js';

export const MICROS_PER_POWER = 1_000_000;

function powerToMicros(value) {
  return Math.max(1, Math.ceil((value * MICROS_PER_POWER) - 1e-7));
}

function displayFactor(customer, reference) {
  return reference > 0 ? Math.round((customer / reference) * 1_000_000) / 1_000_000 : null;
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil((cjk * 1.2) + (other / 4)));
}

function usageObject(payload) {
  return payload?.usage || payload?.message?.usage || payload?.response?.usage || {};
}

function tokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : null;
}

function mergeUsageValue(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeUsageValue(merged[key] || {}, value);
    } else if (Number.isFinite(Number(value))) {
      // Streaming suppliers can repeat cumulative usage. Keeping the largest value
      // combines Anthropic's message_start/message_delta events without double-counting.
      merged[key] = Math.max(Number(merged[key]) || 0, Number(value));
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function mergeUsage(current, payload) {
  return mergeUsageValue(current || {}, usageObject(payload));
}

export function normalizeUsage(payload, requestBody, responseBody) {
  const usage = usageObject(payload);
  const reportedInputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const reportedOutputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  const cacheReadInputTokens = tokenCount(
    usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? 0,
  ) || 0;
  const cacheCreationEphemeral5mInputTokens = tokenCount(usage.cache_creation?.ephemeral_5m_input_tokens) || 0;
  const cacheCreationEphemeral1hInputTokens = tokenCount(usage.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const cacheCreationInputTokens = tokenCount(usage.cache_creation_input_tokens)
    ?? (cacheCreationEphemeral5mInputTokens + cacheCreationEphemeral1hInputTokens);
  const rawInputTokens = reportedInputTokens
    ?? estimateTokens(requestBody.messages ?? requestBody.input ?? requestBody);
  // OpenAI prompt/input token totals include cache reads; Anthropic's input_tokens,
  // cache_creation_input_tokens and cache_read_input_tokens are independent counters.
  const inputIncludesCacheRead = usage.prompt_tokens !== undefined
    || usage.prompt_tokens_details?.cached_tokens !== undefined
    || usage.input_tokens_details?.cached_tokens !== undefined;
  const inputTokens = inputIncludesCacheRead
    ? Math.max(0, rawInputTokens - cacheReadInputTokens)
    : rawInputTokens;
  const outputTokens = reportedOutputTokens
    ?? estimateTokens(responseBody?.choices ?? responseBody?.output ?? responseBody?.content ?? responseBody);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheCreationEphemeral5mInputTokens,
    cacheCreationEphemeral1hInputTokens,
    // Backward-compatible name used by existing API consumers.
    cachedInputTokens: cacheReadInputTokens,
  };
}

export function calculateBilling({ usage, route }) {
  const inputPrice = Number(route.customer_input_power_per_million);
  const cachedInputPrice = Number(route.customer_cached_input_power_per_million);
  const outputPrice = Number(route.customer_output_power_per_million);
  const referenceInputPrice = Number(route.reference_input_power_per_million);
  const referenceCachedInputPrice = Number(route.reference_cached_input_power_per_million);
  const referenceOutputPrice = Number(route.reference_output_power_per_million);
  const cacheCreationInputTokens = Number(usage.cacheCreationInputTokens) || 0;
  const cacheReadInputTokens = Number(usage.cacheReadInputTokens ?? usage.cachedInputTokens) || 0;
  const writeInputTokens = usage.inputTokens + cacheCreationInputTokens;
  const chargedPower = (
    (writeInputTokens / 1_000_000) * inputPrice
    + (cacheReadInputTokens / 1_000_000) * cachedInputPrice
    + (usage.outputTokens / 1_000_000) * outputPrice
  );
  const referencePower = (
    (writeInputTokens / 1_000_000) * referenceInputPrice
    + (cacheReadInputTokens / 1_000_000) * referenceCachedInputPrice
    + (usage.outputTokens / 1_000_000) * referenceOutputPrice
  );
  const referenceCostMicros = powerToMicros(referencePower);
  const chargedCostMicros = powerToMicros(chargedPower);
  const factor = referenceCostMicros > 0 ? chargedCostMicros / referenceCostMicros : 1;
  return {
    referencePower,
    chargedPower,
    referenceCostMicros,
    chargedCostMicros,
    factor,
    inputFactor: displayFactor(inputPrice, referenceInputPrice),
    cachedInputFactor: displayFactor(cachedInputPrice, referenceCachedInputPrice),
    outputFactor: displayFactor(outputPrice, referenceOutputPrice),
  };
}

export function reservationCost(route, body) {
  const inputTokens = Math.ceil(estimateTokens(body.messages ?? body.input ?? body) * 1.2);
  const outputTokens = Number(body.max_tokens ?? body.max_output_tokens) || config.reservationOutputTokens;
  return calculateBilling({
    usage: { inputTokens, cachedInputTokens: 0, billableInputTokens: inputTokens, outputTokens },
    route,
  }).chargedCostMicros;
}

export function pricingDisplay({ usage, billing }) {
  const totalTokens = usage.inputTokens
    + (Number(usage.cacheCreationInputTokens) || 0)
    + (Number(usage.cacheReadInputTokens ?? usage.cachedInputTokens) || 0)
    + usage.outputTokens;
  return {
    tokenText: `${totalTokens.toLocaleString('zh-CN')} tokens`,
    referenceText: `官方参考 ${(billing.referenceCostMicros / MICROS_PER_POWER).toFixed(6)} 电力`,
    factorText: `综合 ×${billing.factor.toFixed(2)}`,
    chargedText: `实扣 ${(billing.chargedCostMicros / MICROS_PER_POWER).toFixed(6)} 电力`,
  };
}
