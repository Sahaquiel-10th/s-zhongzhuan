import { randomUUID } from 'node:crypto';
import express from 'express';
import { pool, transaction } from './db.js';
import { decryptSecret } from './crypto.js';
import { calculateBilling, normalizeUsage, pricingDisplay, reservationCost } from './billing.js';
import { requireCustomerApiKey } from './auth.js';
import { maskResponseModel, rewriteSseLine } from './sanitize.js';

export const proxyRouter = express.Router();

async function findRoute(principal, publicModelId) {
  const { rows } = await pool.query(
    `SELECT r.*, c.base_url, c.api_key_encrypted, c.protocol
       FROM model_routes r
       JOIN upstream_credentials c ON c.id = r.credential_id
      WHERE r.tenant_id = $1 AND r.public_model_id = $2 AND r.active = true AND c.active = true
        AND (($3 = 'self_service' AND r.service_mode = 'self_service')
          OR ($3 = 'managed' AND r.service_mode = 'managed'))
        AND ($4 IS NULL OR r.id = $4)`,
    [principal.tenant_id, publicModelId, principal.access_mode, principal.allowed_route_id],
  );
  return rows[0];
}

function routePricing(route) {
  const ratio = (customer, reference) => Number(reference) > 0 ? Number(customer) / Number(reference) : null;
  return {
    model: route.public_model_id,
    displayName: route.display_name,
    serviceMode: route.service_mode,
    protocol: route.protocol,
    endpoint: route.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
    pricingVersion: Number(route.pricing_version),
    pricingLabel: route.pricing_label,
    effectiveAt: route.pricing_updated_at,
    unit: 'power',
    perMillionTokens: {
      customer: {
        input: Number(route.customer_input_power_per_million),
        cachedInput: Number(route.customer_cached_input_power_per_million),
        output: Number(route.customer_output_power_per_million),
      },
      officialReference: {
        input: Number(route.reference_input_power_per_million),
        cachedInput: Number(route.reference_cached_input_power_per_million),
        output: Number(route.reference_output_power_per_million),
      },
      displayFactor: {
        input: ratio(route.customer_input_power_per_million, route.reference_input_power_per_million),
        cachedInput: ratio(route.customer_cached_input_power_per_million, route.reference_cached_input_power_per_million),
        output: ratio(route.customer_output_power_per_million, route.reference_output_power_per_million),
      },
    },
  };
}

function setPricingHeaders(res, route) {
  const pricing = routePricing(route);
  res.set('x-s-pricing-version', String(route.pricing_version));
  res.set('x-s-service-mode', route.service_mode);
  res.set('x-s-price-unit', 'power-per-million-tokens');
  res.set('x-s-input-price', String(route.customer_input_power_per_million));
  res.set('x-s-cached-input-price', String(route.customer_cached_input_power_per_million));
  res.set('x-s-output-price', String(route.customer_output_power_per_million));
  res.set('x-s-official-input-price', String(route.reference_input_power_per_million));
  res.set('x-s-official-cached-input-price', String(route.reference_cached_input_power_per_million));
  res.set('x-s-official-output-price', String(route.reference_output_power_per_million));
  if (pricing.perMillionTokens.displayFactor.input !== null) res.set('x-s-input-factor', String(pricing.perMillionTokens.displayFactor.input));
  if (pricing.perMillionTokens.displayFactor.cachedInput !== null) res.set('x-s-cached-input-factor', String(pricing.perMillionTokens.displayFactor.cachedInput));
  if (pricing.perMillionTokens.displayFactor.output !== null) res.set('x-s-output-factor', String(pricing.perMillionTokens.displayFactor.output));
}

async function reserveBalance(tenantId, amount) {
  const { rows } = await pool.query(
    `UPDATE tenants
        SET reserved_micros = reserved_micros + $2
      WHERE id = $1 AND active = true AND balance_micros - reserved_micros >= $2
      RETURNING balance_micros, reserved_micros`,
    [tenantId, amount],
  );
  return Boolean(rows[0]);
}

async function releaseReservation(tenantId, amount) {
  await pool.query(
    'UPDATE tenants SET reserved_micros = GREATEST(0, reserved_micros - $2) WHERE id = $1',
    [tenantId, amount],
  );
}

async function settleRequest({ principal, route, reservation, usage, requestId }) {
  const billing = calculateBilling({ usage, route });
  const display = pricingDisplay({ usage, billing });
  const cost = billing.chargedCostMicros;

  await transaction(async (client) => {
    const account = await client.query('SELECT balance_micros FROM tenants WHERE id = $1', [principal.tenant_id]);
    const balanceBefore = Number(account.rows[0].balance_micros);
    const balanceAfter = Math.max(0, balanceBefore - cost);
    const tenantResult = await client.query(
      `UPDATE tenants
          SET reserved_micros = GREATEST(0, reserved_micros - $2),
              balance_micros = $3
        WHERE id = $1
        RETURNING balance_micros`,
      [principal.tenant_id, reservation, balanceAfter],
    );
    await client.query(
      `INSERT INTO usage_logs
        (tenant_id, api_key_id, model_id, input_tokens, output_tokens, cached_input_tokens,
        official_cost_micros, charged_cost_micros, customer_discount,
         official_input_price, official_cached_input_price, official_output_price,
         metadata_json, status, request_id, service_mode, pricing_version_snapshot, pricing_label_snapshot,
         customer_input_power_price, customer_cached_input_power_price, customer_output_power_price,
         reference_input_power_price, reference_cached_input_power_price, reference_output_power_price,
         effective_billing_factor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'success', $14,
               $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
      [
        principal.tenant_id, principal.api_key_id, route.public_model_id, usage.inputTokens, usage.outputTokens,
        usage.cachedInputTokens, billing.referenceCostMicros, cost, billing.factor,
        route.reference_input_power_per_million, route.reference_cached_input_power_per_million,
        route.reference_output_power_per_million, JSON.stringify({ billing: { usage, display, pricing: routePricing(route) } }), requestId,
        route.service_mode, route.pricing_version, route.pricing_label,
        route.customer_input_power_per_million, route.customer_cached_input_power_per_million, route.customer_output_power_per_million,
        route.reference_input_power_per_million, route.reference_cached_input_power_per_million, route.reference_output_power_per_million,
        billing.factor,
      ],
    );
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, type, amount_power, amount_micros, title, reference_id, balance_before_micros, balance_after_micros)
       VALUES ($1, 'consume', 0, $2, $3, $4, $5, $6)`,
      [principal.tenant_id, -cost, `${route.display_name} API 调用`, requestId, balanceBefore, balanceAfter],
    );
    await client.query('UPDATE customer_api_keys SET last_used_at = now() WHERE id = $1', [principal.api_key_id]);
    return tenantResult.rows[0];
  });
  return { cost, billing, display };
}

async function logFailure({ principal, modelId, requestId, status, errorCode }) {
  await pool.query(
    `INSERT INTO usage_logs (tenant_id, api_key_id, model_id, status, request_id, error_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [principal.tenant_id, principal.api_key_id, modelId || 'unknown', status, requestId, errorCode],
  );
}

function upstreamHeaders(route, req) {
  const key = decryptSecret(route.api_key_encrypted);
  const headers = { 'content-type': 'application/json', accept: req.get('accept') || 'application/json' };
  if (route.protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = req.get('anthropic-version') || '2023-06-01';
    if (req.get('anthropic-beta')) headers['anthropic-beta'] = req.get('anthropic-beta');
  } else {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function endpointUrl(baseUrl, path) {
  const base = baseUrl.replace(/\/$/, '');
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

proxyRouter.get('/models', requireCustomerApiKey, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.public_model_id, r.display_name, r.created_at, c.protocol
         FROM model_routes r JOIN upstream_credentials c ON c.id = r.credential_id
        WHERE r.tenant_id = $1 AND r.active = true
          AND (($2 = 'self_service' AND r.service_mode = 'self_service')
            OR ($2 = 'managed' AND r.service_mode = 'managed'))
          AND ($3 IS NULL OR r.id = $3)
        ORDER BY r.display_name`,
      [req.apiPrincipal.tenant_id, req.apiPrincipal.access_mode, req.apiPrincipal.allowed_route_id],
    );
    res.json({
      object: 'list',
      data: rows.map((row) => ({ id: row.public_model_id, object: 'model', owned_by: 'super-relay', name: row.display_name, protocol: row.protocol })),
    });
  } catch (error) {
    next(error);
  }
});

proxyRouter.get('/pricing', requireCustomerApiKey, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, c.protocol FROM model_routes r JOIN upstream_credentials c ON c.id = r.credential_id
        WHERE r.tenant_id = $1 AND r.active = true AND c.active = true
          AND (($2 = 'self_service' AND r.service_mode = 'self_service')
            OR ($2 = 'managed' AND r.service_mode = 'managed'))
          AND ($3 IS NULL OR r.id = $3)
        ORDER BY r.display_name`,
      [req.apiPrincipal.tenant_id, req.apiPrincipal.access_mode, req.apiPrincipal.allowed_route_id],
    );
    res.json({ object: 'pricing.list', unit: 'power', data: rows.map(routePricing) });
  } catch (error) { next(error); }
});

proxyRouter.get('/notices', requireCustomerApiKey, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.route_id, n.type, n.title, n.body, n.pricing_version, n.created_at
         FROM pricing_notifications n LEFT JOIN model_routes r ON r.id = n.route_id
        WHERE n.tenant_id = $1 AND (n.route_id IS NULL
          OR ($2 = 'self_service' AND r.service_mode = 'self_service')
          OR ($2 = 'managed' AND r.service_mode = 'managed'))
          AND ($3 IS NULL OR n.route_id IS NULL OR n.route_id = $3)
        ORDER BY n.created_at DESC LIMIT 100`,
      [req.apiPrincipal.tenant_id, req.apiPrincipal.access_mode, req.apiPrincipal.allowed_route_id],
    );
    res.json({ object: 'notice.list', data: rows });
  } catch (error) { next(error); }
});

for (const path of ['/chat/completions', '/responses', '/messages']) {
  proxyRouter.post(path, requireCustomerApiKey, async (req, res) => {
    const principal = req.apiPrincipal;
    const requestId = randomUUID();
    const requestedModel = req.body?.model;
    let reservation = 0;
    let route;

    try {
      route = await findRoute(principal, requestedModel);
      if (!route) {
        await logFailure({ principal, modelId: requestedModel, requestId, status: 'blocked', errorCode: 'model_not_allowed' });
        return res.status(404).json({ error: { message: '该模型未开通', type: 'invalid_request_error' } });
      }

      const protocolMismatch = (route.protocol === 'anthropic' && path !== '/messages')
        || (route.protocol === 'openai' && path === '/messages');
      if (protocolMismatch) {
        await logFailure({ principal, modelId: requestedModel, requestId, status: 'blocked', errorCode: 'protocol_mismatch' });
        const expected = route.protocol === 'anthropic' ? '/v1/messages（Anthropic）' : '/v1/chat/completions 或 /v1/responses（OpenAI）';
        return res.status(400).json({ error: { message: `该模型应使用 ${expected} 接入`, type: 'protocol_mismatch' } });
      }

      setPricingHeaders(res, route);

      reservation = reservationCost(route, req.body);
      if (!(await reserveBalance(principal.tenant_id, reservation))) {
        await logFailure({ principal, modelId: requestedModel, requestId, status: 'blocked', errorCode: 'insufficient_balance' });
        return res.status(402).json({ error: { message: '账户余额不足，请充值', type: 'insufficient_balance' } });
      }

      const upstreamBody = { ...req.body, model: route.upstream_model_id };
      if (upstreamBody.stream && route.protocol === 'openai') {
        upstreamBody.stream_options = { ...(upstreamBody.stream_options || {}), include_usage: true };
      }
      const upstream = await fetch(endpointUrl(route.base_url, path), {
        method: 'POST',
        headers: upstreamHeaders(route, req),
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });

      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 1000);
        console.error('Upstream request failed', { requestId, status: upstream.status, detail });
        await releaseReservation(principal.tenant_id, reservation);
        await logFailure({ principal, modelId: requestedModel, requestId, status: 'failed', errorCode: `upstream_${upstream.status}` });
        return res.status(502).json({ error: { message: '模型服务暂时不可用', type: 'upstream_error', request_id: requestId } });
      }

      res.set('x-request-id', requestId);
      if (!req.body.stream) {
        const payload = maskResponseModel(await upstream.json(), route);
        const usage = normalizeUsage(payload, req.body, payload);
        const settlement = await settleRequest({ principal, route, reservation, usage, requestId });
        res.set('x-s-billed-power', (settlement.cost / 1_000_000).toFixed(6));
        return res.status(upstream.status).json(payload);
      }

      res.status(upstream.status);
      res.set('content-type', upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8');
      res.set('cache-control', 'no-cache, no-transform');
      res.flushHeaders();
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let captured = '';
      let lineBuffer = '';
      let usagePayload = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        captured += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          const rewritten = rewriteSseLine(line, route);
          if (rewritten.usagePayload) usagePayload = rewritten.usagePayload;
          res.write(`${rewritten.line}\n`);
        }
      }
      if (lineBuffer) {
        const rewritten = rewriteSseLine(lineBuffer, route);
        if (rewritten.usagePayload) usagePayload = rewritten.usagePayload;
        res.write(rewritten.line);
      }
      const usage = normalizeUsage(usagePayload, req.body, captured);
      await settleRequest({ principal, route, reservation, usage, requestId });
      res.end();
    } catch (error) {
      console.error('Proxy request failed', { requestId, error: error.message });
      if (reservation) await releaseReservation(principal.tenant_id, reservation).catch(() => {});
      await logFailure({ principal, modelId: requestedModel, requestId, status: 'failed', errorCode: 'gateway_error' }).catch(() => {});
      if (!res.headersSent) res.status(502).json({ error: { message: '网关请求失败', type: 'gateway_error', request_id: requestId } });
      else res.end();
    }
  });
}
