import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBilling, estimateTokens, normalizeUsage, reservationCost, validateDiscount } from '../src/billing.js';
import { maskResponseModel, rewriteSseLine } from '../src/sanitize.js';

test('estimateTokens always returns a positive integer', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('123456'), 2);
});

test('calculateBilling applies model token prices and customer discount', () => {
  const billing = calculateBilling({
    usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 },
    route: {
      official_input_cny_per_million: 35,
      official_cached_input_cny_per_million: 3.5,
      official_output_cny_per_million: 210,
      customer_discount: 0.8,
    },
  });
  assert.equal(billing.officialCostMicros, 49_700_000);
  assert.equal(billing.chargedCostMicros, 39_760_000);
});

test('validateDiscount accepts a normal discount and rejects markup', () => {
  assert.equal(validateDiscount(0.8), 0.8);
  assert.throws(() => validateDiscount(1.2));
});

test('cached input tokens are copied from supplier usage', () => {
  const usage = normalizeUsage({
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
  }, {}, {});
  assert.equal(usage.cachedInputTokens, 600);
});

test('reservation includes requested maximum output tokens', () => {
  const route = {
    official_input_cny_per_million: 35,
    official_cached_input_cny_per_million: 3.5,
    official_output_cny_per_million: 210,
    customer_discount: 0.8,
  };
  const low = reservationCost(route, { messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 });
  const high = reservationCost(route, { messages: [{ role: 'user', content: 'hello' }], max_tokens: 1000 });
  assert.ok(high > low);
});

test('customer responses never expose the upstream model id', () => {
  const route = { public_model_id: 'customer-model' };
  const payload = maskResponseModel({ model: 'private-upstream-model', choices: [] }, route);
  assert.equal(payload.model, 'customer-model');

  const event = rewriteSseLine('data: {"model":"private-upstream-model","choices":[]}', route);
  assert.equal(JSON.parse(event.line.slice(6)).model, 'customer-model');
});
