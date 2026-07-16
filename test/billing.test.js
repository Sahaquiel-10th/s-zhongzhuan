import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBilling, estimateTokens, normalizeUsage, reservationCost } from '../src/billing.js';
import { maskResponseModel, rewriteSseLine } from '../src/sanitize.js';

test('estimateTokens always returns a positive integer', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('123456'), 2);
});

test('calculateBilling uses independent customer power prices and reference prices', () => {
  const billing = calculateBilling({
    usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 },
    route: {
      customer_input_power_per_million: 2.4,
      customer_cached_input_power_per_million: 0.3,
      customer_output_power_per_million: 12,
      reference_input_power_per_million: 3,
      reference_cached_input_power_per_million: 0.3,
      reference_output_power_per_million: 15,
    },
  });
  assert.equal(billing.referenceCostMicros, 3_960_000);
  assert.equal(billing.chargedCostMicros, 3_180_000);
  assert.equal(billing.inputFactor, 0.8);
  assert.equal(billing.outputFactor, 0.8);
});

test('cached input tokens are copied from supplier usage', () => {
  const usage = normalizeUsage({
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
  }, {}, {});
  assert.equal(usage.cachedInputTokens, 600);
});

test('reservation includes requested maximum output tokens', () => {
  const route = {
    customer_input_power_per_million: 2.4,
    customer_cached_input_power_per_million: 0.3,
    customer_output_power_per_million: 12,
    reference_input_power_per_million: 3,
    reference_cached_input_power_per_million: 0.3,
    reference_output_power_per_million: 15,
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
