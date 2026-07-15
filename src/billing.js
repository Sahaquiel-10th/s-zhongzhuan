import { config } from './config.js';

export const MICROS_PER_CNY = 1_000_000;

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

export function validateDiscount(value) {
  const discount = Number(value);
  if (!Number.isFinite(discount) || discount <= 0 || discount > 1) {
    throw new Error('客户折扣必须大于 0 且不超过 1');
  }
  return Math.round(discount * 100) / 100;
}

export function calculateBilling({ usage, route }) {
  const inputPrice = Number(route.official_input_cny_per_million);
  const cachedInputPrice = Number(route.official_cached_input_cny_per_million);
  const outputPrice = Number(route.official_output_cny_per_million);
  const discount = validateDiscount(route.customer_discount);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const officialCostCny = (
    (uncachedInputTokens / 1_000_000) * inputPrice
    + (usage.cachedInputTokens / 1_000_000) * cachedInputPrice
    + (usage.outputTokens / 1_000_000) * outputPrice
  );
  const officialCostMicros = Math.max(1, Math.ceil(officialCostCny * MICROS_PER_CNY));
  const chargedCostMicros = Math.max(1, Math.ceil(officialCostMicros * discount));
  return { officialCostCny, officialCostMicros, chargedCostMicros, discount };
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
    officialText: `官网价 ¥${(billing.officialCostMicros / MICROS_PER_CNY).toFixed(6)}`,
    discountText: `${(billing.discount * 10).toFixed(1)} 折`,
    chargedText: `实扣 ¥${(billing.chargedCostMicros / MICROS_PER_CNY).toFixed(6)}`,
  };
}
