import { randomUUID } from 'node:crypto';
import express from 'express';
import { pool, transaction } from './db.js';
import { decryptSecret } from './crypto.js';
import { calculateBilling, normalizeUsage, pricingDisplay, reservationCost } from './billing.js';
import { requireCustomerApiKey } from './auth.js';
import { maskResponseModel, rewriteSseLine } from './sanitize.js';

export const proxyRouter = express.Router();

async function findRoute(tenantId, publicModelId) {
  const { rows } = await pool.query(
    `SELECT r.*, c.base_url, c.api_key_encrypted, c.protocol,
            s.customer_discount
       FROM model_routes r
       JOIN upstream_credentials c ON c.id = r.credential_id
       JOIN platform_settings s ON s.id = 1
      WHERE r.tenant_id = $1 AND r.public_model_id = $2 AND r.active = true AND c.active = true`,
    [tenantId, publicModelId],
  );
  return rows[0];
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
         metadata_json, status, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'success', $14)`,
      [
        principal.tenant_id, principal.api_key_id, route.public_model_id, usage.inputTokens, usage.outputTokens,
        usage.cachedInputTokens, billing.officialCostMicros, cost, billing.discount,
        route.official_input_cny_per_million, route.official_cached_input_cny_per_million,
        route.official_output_cny_per_million, JSON.stringify({ billing: { usage, display } }), requestId,
      ],
    );
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, type, amount_power, amount_micros, title, reference_id, balance_before_micros, balance_after_micros)
       VALUES ($1, 'consume', 0, $2, $3, $4, $5, $6)`,
      [principal.tenant_id, -cost, `${route.display_name} 模型调用`, requestId, balanceBefore, balanceAfter],
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
      `SELECT public_model_id, display_name, created_at
         FROM model_routes WHERE tenant_id = $1 AND active = true ORDER BY display_name`,
      [req.apiPrincipal.tenant_id],
    );
    res.json({
      object: 'list',
      data: rows.map((row) => ({ id: row.public_model_id, object: 'model', owned_by: 'super-relay', name: row.display_name })),
    });
  } catch (error) {
    next(error);
  }
});

for (const path of ['/chat/completions', '/responses', '/messages']) {
  proxyRouter.post(path, requireCustomerApiKey, async (req, res) => {
    const principal = req.apiPrincipal;
    const requestId = randomUUID();
    const requestedModel = req.body?.model;
    let reservation = 0;
    let route;

    try {
      route = await findRoute(principal.tenant_id, requestedModel);
      if (!route) {
        await logFailure({ principal, modelId: requestedModel, requestId, status: 'blocked', errorCode: 'model_not_allowed' });
        return res.status(404).json({ error: { message: '该模型未开通', type: 'invalid_request_error' } });
      }

      reservation = reservationCost(route, req.body);
      if (!(await reserveBalance(principal.tenant_id, reservation))) {
        await logFailure({ principal, modelId: requestedModel, requestId, status: 'blocked', errorCode: 'insufficient_balance' });
        return res.status(402).json({ error: { message: '账户余额不足，请充值', type: 'insufficient_balance' } });
      }

      const upstreamBody = { ...req.body, model: route.upstream_model_id };
      if (upstreamBody.stream) {
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
        res.set('x-billed-cny', (settlement.cost / 1_000_000).toFixed(6));
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
