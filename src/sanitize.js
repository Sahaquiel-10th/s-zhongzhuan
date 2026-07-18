export function maskResponseModel(payload, route) {
  if (!payload || typeof payload !== 'object') return payload;
  if ('model' in payload) payload.model = route.public_model_id;
  if (payload.response && typeof payload.response === 'object' && 'model' in payload.response) {
    payload.response.model = route.public_model_id;
  }
  return payload;
}

export function rewriteSseLine(line, route) {
  if (!line.startsWith('data: ') || line.includes('[DONE]')) return { line, usagePayload: null };
  try {
    const payload = maskResponseModel(JSON.parse(line.slice(6)), route);
    const hasUsage = payload.usage || payload.message?.usage || payload.response?.usage;
    return { line: `data: ${JSON.stringify(payload)}`, usagePayload: hasUsage ? payload : null };
  } catch {
    return { line, usagePayload: null };
  }
}
