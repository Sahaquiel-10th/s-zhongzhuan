const CLAUDE_CODE_MODEL_ALIAS = /^(?:default|fable(?:-?5)?|sonnet|opus|opusplan|haiku)(?:\[1m\])?$/i;

function acceptsSingleModelName(route, model) {
  if (model === route.public_model_id || model === route.upstream_model_id) return true;
  return route.protocol === 'anthropic' && CLAUDE_CODE_MODEL_ALIAS.test(model);
}

export function acceptsBoundModelRequest(route, requestedModel) {
  if (typeof requestedModel !== 'string' || !requestedModel.trim()) return false;

  const parts = requestedModel.trim().split(/\s*·\s*/).filter(Boolean);
  if (!parts.length || parts.length > 2) return false;
  if (parts.length === 2 && route.protocol !== 'anthropic') return false;

  return parts.every((model) => acceptsSingleModelName(route, model));
}
