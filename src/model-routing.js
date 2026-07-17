const CLAUDE_CODE_MODEL_ALIAS = /^(?:default|fable(?:-?5)?|sonnet|opus|opusplan|haiku)(?:\[1m\])?$/i;

export function acceptsBoundModelRequest(route, requestedModel) {
  if (typeof requestedModel !== 'string' || !requestedModel.trim()) return false;

  const model = requestedModel.trim();
  if (model === route.public_model_id || model === route.upstream_model_id) return true;

  return route.protocol === 'anthropic' && CLAUDE_CODE_MODEL_ALIAS.test(model);
}
