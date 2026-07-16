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
  return payload?.usage || payload?.response?.usage || {};
}

export function normalizeUsage(payload, requestBody, responseBody) {
  const usage = usageObject(payload);
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens)
    || estimateTokens(requestBody.messages ?? requestBody.input ?? requestBody);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens)
    || estimateTokens(responseBody?.choices ?? responseBody?.output ?? responseBody?.content ?? responseBody);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Number(
    usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? 0,
  )));
  return { inputTokens, outputTokens, cachedInputTokens };
}

export function calculateBilling({ usage, route }) {
  const inputPrice = Number(route.customer_input_power_per_million);
  const cachedInputPrice = Number(route.customer_cached_input_power_per_million);
  const outputPrice = Number(route.customer_output_power_per_million);
  const referenceInputPrice = Number(route.reference_input_power_per_million);
  const referenceCachedInputPrice = Number(route.reference_cached_input_power_per_million);
  const referenceOutputPrice = Number(route.reference_output_power_per_million);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const chargedPower = (
    (uncachedInputTokens / 1_000_000) * inputPrice
    + (usage.cachedInputTokens / 1_000_000) * cachedInputPrice
    + (usage.outputTokens / 1_000_000) * outputPrice
  );
  const referencePower = (
    (uncachedInputTokens / 1_000_000) * referenceInputPrice
    + (usage.cachedInputTokens / 1_000_000) * referenceCachedInputPrice
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
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return {
    tokenText: `${totalTokens.toLocaleString('zh-CN')} tokens`,
    referenceText: `官方参考 ${(billing.referenceCostMicros / MICROS_PER_POWER).toFixed(6)} 电力`,
    factorText: `综合 ×${billing.factor.toFixed(2)}`,
    chargedText: `实扣 ${(billing.chargedCostMicros / MICROS_PER_POWER).toFixed(6)} 电力`,
  };
}
