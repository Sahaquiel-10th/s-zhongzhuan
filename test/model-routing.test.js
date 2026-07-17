import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsBoundModelRequest } from '../src/model-routing.js';

const fableRoute = {
  public_model_id: 'fable5',
  upstream_model_id: 'claude-fable-5',
  protocol: 'anthropic',
};

test('bound Anthropic routes accept their public and upstream model IDs', () => {
  assert.equal(acceptsBoundModelRequest(fableRoute, 'fable5'), true);
  assert.equal(acceptsBoundModelRequest(fableRoute, 'claude-fable-5'), true);
});

test('bound Anthropic routes accept Claude Code built-in aliases', () => {
  for (const model of ['fable', 'fable[1m]', 'fable5[1m]', 'sonnet', 'sonnet[1m]', 'opus', 'opusplan', 'haiku', 'default']) {
    assert.equal(acceptsBoundModelRequest(fableRoute, model), true, model);
  }
});

test('bound Anthropic routes accept CC Switch display and request model pairs', () => {
  for (const model of ['fable5 · fable5', 'fable5 · fable5[1m]', 'sonnet · fable5', 'default · fable5']) {
    assert.equal(acceptsBoundModelRequest(fableRoute, model), true, model);
  }
});

test('bound routes still reject empty, arbitrary, and cross-protocol model names', () => {
  assert.equal(acceptsBoundModelRequest(fableRoute, ''), false);
  assert.equal(acceptsBoundModelRequest(fableRoute, 'not-a-real-model'), false);
  assert.equal(acceptsBoundModelRequest(fableRoute, 'fable5 · not-a-real-model'), false);
  assert.equal(acceptsBoundModelRequest(fableRoute, 'fable5 · fable5 · fable5'), false);
  assert.equal(acceptsBoundModelRequest({ ...fableRoute, protocol: 'openai' }, 'fable[1m]'), false);
  assert.equal(acceptsBoundModelRequest({ ...fableRoute, protocol: 'openai' }, 'fable5 · fable5'), false);
});
