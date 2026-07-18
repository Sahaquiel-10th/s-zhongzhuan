import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBilling, estimateTokens, mergeUsage, normalizeUsage, pricingDisplay, reservationCost } from '../src/billing.js';
import { maskResponseModel, rewriteSseLine } from '../src/sanitize.js';

test('estimateTokens always returns a positive integer', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('123456'), 2);
});

test('calculateBilling uses independent customer power prices and reference prices', () => {
  const billing = calculateBilling({
    usage: { inputTokens: 1_000_000, cacheCreationInputTokens: 100_000, cacheReadInputTokens: 200_000, outputTokens: 100_000 },
    route: {
      customer_input_power_per_million: 2.4,
      customer_cached_input_power_per_million: 0.3,
      customer_output_power_per_million: 12,
      reference_input_power_per_million: 3,
      reference_cached_input_power_per_million: 0.3,
      reference_output_power_per_million: 15,
    },
  });
  assert.equal(billing.referenceCostMicros, 4_860_000);
  assert.equal(billing.chargedCostMicros, 3_900_000);
  assert.equal(billing.inputFactor, 0.8);
  assert.equal(billing.outputFactor, 0.8);
});

test('cached input tokens are copied from supplier usage', () => {
  const usage = normalizeUsage({
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
  }, {}, {});
  assert.equal(usage.cachedInputTokens, 600);
  assert.equal(usage.cacheReadInputTokens, 600);
  assert.equal(usage.inputTokens, 400);
});

test('Anthropic cache creation is stored independently and billed as ordinary input', () => {
  const usage = normalizeUsage({
    usage: {
      input_tokens: 25,
      output_tokens: 4368,
      cache_creation_input_tokens: 3171,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 171 },
    },
  }, {}, {});
  assert.deepEqual(usage, {
    inputTokens: 25,
    outputTokens: 4368,
    cacheCreationInputTokens: 3171,
    cacheReadInputTokens: 0,
    cacheCreationEphemeral5mInputTokens: 3000,
    cacheCreationEphemeral1hInputTokens: 171,
    cachedInputTokens: 0,
  });
  const route = {
    customer_input_power_per_million: 2,
    customer_cached_input_power_per_million: 0.2,
    customer_output_power_per_million: 10,
    reference_input_power_per_million: 3,
    reference_cached_input_power_per_million: 0.3,
    reference_output_power_per_million: 15,
  };
  const billing = calculateBilling({ usage, route });
  assert.equal(billing.chargedCostMicros, 50_072);
  assert.equal(billing.referenceCostMicros, 75_108);
  assert.equal(pricingDisplay({ usage, billing }).tokenText, '7,564 tokens');
});

test('new Anthropic cache creation breakdown is used when the total is absent', () => {
  const usage = normalizeUsage({
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
    },
  }, {}, {});
  assert.equal(usage.cacheCreationInputTokens, 70);
});

test('streaming Anthropic usage merges message_start and message_delta', () => {
  let usage = mergeUsage({}, { message: { usage: { input_tokens: 25, cache_creation_input_tokens: 3171 } } });
  usage = mergeUsage(usage, { usage: { output_tokens: 4368 } });
  const normalized = normalizeUsage({ usage }, {}, {});
  assert.equal(normalized.inputTokens, 25);
  assert.equal(normalized.cacheCreationInputTokens, 3171);
  assert.equal(normalized.outputTokens, 4368);
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
