import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config, assertProductionConfig } from './config.js';
import { pool, transaction } from './db.js';
import { clearSession, issueSession, requireAdmin, requireUser } from './auth.js';
import { createApiKey, decryptSecret, encryptSecret, hashApiKey } from './crypto.js';
import { proxyRouter } from './proxy.js';

assertProductionConfig();

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

function nonNegativePrice(value, fallback = undefined) {
  const price = value === '' || value === undefined ? fallback : Number(value);
  if (!Number.isFinite(price) || price < 0) throw new Error('价格必须是大于或等于 0 的数字');
  return price;
}

function pricingFields(body, current = {}) {
  const customerInput = nonNegativePrice(body.customerInputPrice, current.customer_input_power_per_million);
  const customerOutput = nonNegativePrice(body.customerOutputPrice, current.customer_output_power_per_million);
  const referenceInput = nonNegativePrice(body.referenceInputPrice, current.reference_input_power_per_million);
  const referenceOutput = nonNegativePrice(body.referenceOutputPrice, current.reference_output_power_per_million);
  const upstreamInput = nonNegativePrice(body.upstreamInputPrice, current.upstream_input_power_per_million ?? 0);
  const upstreamOutput = nonNegativePrice(body.upstreamOutputPrice, current.upstream_output_power_per_million ?? 0);
  return {
    customerInput,
    customerCachedInput: nonNegativePrice(body.customerCachedInputPrice, current.customer_cached_input_power_per_million ?? customerInput),
    customerOutput,
    referenceInput,
    referenceCachedInput: nonNegativePrice(body.referenceCachedInputPrice, current.reference_cached_input_power_per_million ?? referenceInput),
    referenceOutput,
    upstreamInput,
    upstreamCachedInput: nonNegativePrice(body.upstreamCachedInputPrice, current.upstream_cached_input_power_per_million ?? upstreamInput),
    upstreamOutput,
  };
}

function pageNumber(value) {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function dateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('日期格式无效');
  return `${text} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function sendCsv(res, filename, headers, rows) {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="${filename}"`);
  res.send(`\ufeff${csv}`);
}

async function routeForKey({ routeId, tenantId = null }) {
  const params = tenantId ? [routeId, tenantId] : [routeId];
  const tenantClause = tenantId ? 'AND r.tenant_id = $2' : '';
  const { rows } = await pool.query(
    `SELECT r.id, r.tenant_id, r.service_mode, r.display_name, r.public_model_id, c.protocol
       FROM model_routes r JOIN upstream_credentials c ON c.id = r.credential_id
      WHERE r.id = $1 ${tenantClause} AND r.active = true AND c.active = true`,
    params,
  );
  return rows[0];
}
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  issueSession(res, user);
  res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, tenantId: user.tenant_id } });
});

app.post('/api/auth/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});

app.get('/api/me', requireUser, async (req, res) => {
  let tenant = null;
  if (req.user.tenant_id) {
    const result = await pool.query('SELECT id, name, balance_micros, reserved_micros, active FROM tenants WHERE id = $1', [req.user.tenant_id]);
    tenant = result.rows[0] || null;
  }
  res.json({ user: req.user, tenant, publicBaseUrl: config.publicBaseUrl });
});

app.get('/api/customer/dashboard', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '管理员没有客户账本' });
  const tenantId = req.user.tenant_id;
  const [tenant, models, keys, usage, usageCount, ledger, ledgerCount, orders, notices] = await Promise.all([
    pool.query('SELECT id, name, balance_micros, reserved_micros, active FROM tenants WHERE id = $1', [tenantId]),
    pool.query(`SELECT r.id, r.public_model_id, r.display_name, r.active, r.service_mode, r.pricing_version, r.pricing_label, r.pricing_updated_at,
      customer_input_power_per_million, customer_cached_input_power_per_million, customer_output_power_per_million,
      reference_input_power_per_million, reference_cached_input_power_per_million, reference_output_power_per_million,
      c.protocol
      FROM model_routes r JOIN upstream_credentials c ON c.id = r.credential_id
      WHERE r.tenant_id = $1 ORDER BY r.display_name`, [tenantId]),
    pool.query(`SELECT k.id, k.name, k.key_prefix, k.active, k.access_mode, k.allowed_route_id,
      r.display_name AS route_name, r.public_model_id, c.protocol, k.key_encrypted IS NOT NULL AS can_copy,
      k.expires_at, k.last_used_at, k.created_at
      FROM customer_api_keys k
      LEFT JOIN model_routes r ON r.id = k.allowed_route_id
      LEFT JOIN upstream_credentials c ON c.id = r.credential_id
      WHERE k.tenant_id = $1 ORDER BY k.created_at DESC`, [tenantId]),
    pool.query(`SELECT model_id, input_tokens, output_tokens, cached_input_tokens,
      official_cost_micros, charged_cost_micros, effective_billing_factor,
      pricing_version_snapshot, pricing_label_snapshot, service_mode,
      customer_input_power_price, customer_cached_input_power_price, customer_output_power_price,
      reference_input_power_price, reference_cached_input_power_price, reference_output_power_price,
      status, error_code, request_id, created_at
      FROM usage_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [tenantId]),
    pool.query('SELECT count(*) AS total FROM usage_logs WHERE tenant_id = $1', [tenantId]),
    pool.query('SELECT type, amount_micros, amount_cny, title, reference_id, balance_before_micros, balance_after_micros, created_at FROM ledger_entries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10', [tenantId]),
    pool.query('SELECT count(*) AS total FROM ledger_entries WHERE tenant_id = $1', [tenantId]),
    pool.query('SELECT id, requested_power_micros, amount_cny, credited_micros, settlement_cny_per_power, status, payment_channel, created_at FROM recharge_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [tenantId]),
    pool.query(`SELECT n.id, n.route_id, n.type, n.title, n.body, n.pricing_version, n.created_at,
      CASE WHEN nr.user_id IS NULL THEN 0 ELSE 1 END AS is_read
      FROM pricing_notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $2
      WHERE n.tenant_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [tenantId, req.user.id]),
  ]);
  res.json({
    tenant: tenant.rows[0], models: models.rows, keys: keys.rows,
    usage: usage.rows, usagePagination: { page: 1, pageSize: 10, total: Number(usageCount.rows[0].total) },
    ledger: ledger.rows, ledgerPagination: { page: 1, pageSize: 10, total: Number(ledgerCount.rows[0].total) },
    orders: orders.rows, publicBaseUrl: config.publicBaseUrl,
    notices: notices.rows,
  });
});

app.post('/api/customer/keys', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '当前账号不能创建 Key' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入 Key 名称' });
  const accessMode = req.body.accessMode === 'managed' ? 'managed' : 'self_service';
  const route = await routeForKey({ routeId: String(req.body.routeId || ''), tenantId: req.user.tenant_id });
  if (!route || route.service_mode !== accessMode) return res.status(400).json({ error: '请选择与访问模式匹配的可用模型' });
  const value = createApiKey();
  const { rows } = await pool.query(
    `INSERT INTO customer_api_keys
      (tenant_id, name, key_hash, key_prefix, key_encrypted, access_mode, managed_route_id, allowed_route_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, key_prefix, access_mode, allowed_route_id, active, created_at`,
    [req.user.tenant_id, name, hashApiKey(value), `${value.slice(0, 13)}...${value.slice(-4)}`,
      encryptSecret(value), accessMode, accessMode === 'managed' ? route.id : null, route.id],
  );
  res.status(201).json({ key: rows[0], secret: value });
});

app.get('/api/customer/keys/:id/secret', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '当前账号不能查看 Key' });
  const { rows } = await pool.query(
    'SELECT key_encrypted FROM customer_api_keys WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.user.tenant_id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Key 不存在' });
  if (!rows[0].key_encrypted) return res.status(409).json({ error: '该 Key 创建于可复制功能上线前，请重新生成' });
  res.json({ secret: decryptSecret(rows[0].key_encrypted) });
});

app.patch('/api/customer/keys/:id', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE customer_api_keys SET active = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, active',
    [req.params.id, req.user.tenant_id, Boolean(req.body.active)],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Key 不存在' });
  res.json(rows[0]);
});

app.post('/api/customer/recharge-orders', requireUser, async (req, res) => {
  const requestedPower = Number(req.body.requestedPower);
  if (!req.user.tenant_id || !Number.isFinite(requestedPower) || requestedPower <= 0) return res.status(400).json({ error: '申请充值的电力必须大于 0' });
  const requestedPowerMicros = Math.round(requestedPower * 1_000_000);
  const { rows } = await pool.query(
    `INSERT INTO recharge_orders (tenant_id, requested_power_micros)
     VALUES ($1, $2) RETURNING id, requested_power_micros, credited_micros, status, created_at`,
    [req.user.tenant_id, requestedPowerMicros],
  );
  res.status(201).json(rows[0]);
});

app.post('/api/customer/notices/:id/read', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '当前账号不能操作通知' });
  const notice = await pool.query('SELECT id FROM pricing_notifications WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user.tenant_id]);
  if (!notice.rows[0]) return res.status(404).json({ error: '通知不存在' });
  await pool.query(
    `INSERT INTO notification_reads (notification_id, user_id) VALUES ($1, $2)
     ON CONFLICT (notification_id, user_id) DO UPDATE SET read_at = now()`,
    [req.params.id, req.user.id],
  );
  res.json({ ok: true });
});

app.get('/api/customer/usage', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '当前账号没有用量日志' });
  let startAt; let endAt;
  try {
    startAt = dateBoundary(req.query.startAt);
    endAt = dateBoundary(req.query.endAt, true);
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const page = pageNumber(req.query.page);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const params = [req.user.tenant_id, startAt, endAt];
  const where = 'tenant_id = $1 AND ($2 IS NULL OR created_at >= $2) AND ($3 IS NULL OR created_at <= $3)';
  const [items, count] = await Promise.all([
    pool.query(`SELECT model_id, input_tokens, output_tokens, cached_input_tokens,
      official_cost_micros, charged_cost_micros, effective_billing_factor,
      pricing_version_snapshot, pricing_label_snapshot, service_mode,
      status, error_code, request_id, created_at
      FROM usage_logs WHERE ${where} ORDER BY created_at DESC LIMIT 10 OFFSET $4`, [...params, offset]),
    pool.query(`SELECT count(*) AS total FROM usage_logs WHERE ${where}`, params),
  ]);
  res.json({ data: items.rows, pagination: { page, pageSize, total: Number(count.rows[0].total) }, filters: { startAt: req.query.startAt || '', endAt: req.query.endAt || '' } });
});

app.get('/api/customer/ledger', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '当前账号没有账本' });
  let startAt; let endAt;
  try {
    startAt = dateBoundary(req.query.startAt);
    endAt = dateBoundary(req.query.endAt, true);
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const page = pageNumber(req.query.page);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const params = [req.user.tenant_id, startAt, endAt];
  const where = 'tenant_id = $1 AND ($2 IS NULL OR created_at >= $2) AND ($3 IS NULL OR created_at <= $3)';
  const [items, count] = await Promise.all([
    pool.query(`SELECT type, amount_micros, amount_cny, title, reference_id,
      balance_before_micros, balance_after_micros, created_at
      FROM ledger_entries WHERE ${where} ORDER BY created_at DESC LIMIT 10 OFFSET $4`, [...params, offset]),
    pool.query(`SELECT count(*) AS total FROM ledger_entries WHERE ${where}`, params),
  ]);
  res.json({ data: items.rows, pagination: { page, pageSize, total: Number(count.rows[0].total) }, filters: { startAt: req.query.startAt || '', endAt: req.query.endAt || '' } });
});

app.get('/api/customer/export/:kind', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '当前账号没有可导出数据' });
  let startAt; let endAt;
  try {
    startAt = dateBoundary(req.query.startAt);
    endAt = dateBoundary(req.query.endAt, true);
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const params = [req.user.tenant_id, startAt, endAt];
  const where = 'tenant_id = $1 AND ($2 IS NULL OR created_at >= $2) AND ($3 IS NULL OR created_at <= $3)';
  if (req.params.kind === 'usage') {
    const { rows } = await pool.query(
      `SELECT created_at, request_id, model_id, service_mode, input_tokens, cached_input_tokens,
       output_tokens, official_cost_micros, charged_cost_micros, effective_billing_factor,
       pricing_label_snapshot, pricing_version_snapshot, status, error_code
       FROM usage_logs WHERE ${where} ORDER BY created_at DESC`, params,
    );
    return sendCsv(res, 'usage-logs.csv',
      ['时间', '请求ID', '模型', '模式', '输入Token', '缓存Token', '输出Token', '官方参考电力', '实扣电力', '综合倍率', '价格标签', '价格版本', '状态', '错误码'],
      rows.map((row) => [row.created_at, row.request_id, row.model_id, row.service_mode, row.input_tokens,
        row.cached_input_tokens, row.output_tokens, Number(row.official_cost_micros) / 1_000_000,
        Number(row.charged_cost_micros) / 1_000_000, row.effective_billing_factor,
        row.pricing_label_snapshot, row.pricing_version_snapshot, row.status, row.error_code]));
  }
  if (req.params.kind === 'ledger') {
    const { rows } = await pool.query(
      `SELECT created_at, type, title, reference_id, amount_micros, amount_cny,
       balance_before_micros, balance_after_micros
       FROM ledger_entries WHERE ${where} ORDER BY created_at DESC`, params,
    );
    return sendCsv(res, 'power-ledger.csv',
      ['时间', '类型', '项目', '关联ID', '电力变动', '实收人民币', '变动前电力', '变动后电力'],
      rows.map((row) => [row.created_at, row.type, row.title, row.reference_id,
        Number(row.amount_micros) / 1_000_000, row.amount_cny,
        Number(row.balance_before_micros) / 1_000_000, Number(row.balance_after_micros) / 1_000_000]));
  }
  res.status(404).json({ error: '导出类型不存在' });
});

app.get('/api/admin/dashboard', requireUser, requireAdmin, async (_req, res) => {
  const [tenants, credentials, routes, keys, orders, settings] = await Promise.all([
    pool.query(`SELECT t.*, u.email AS owner_email,
      (SELECT count(*) FROM model_routes r WHERE r.tenant_id = t.id AND r.active = true) AS model_count
      FROM tenants t LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'customer' ORDER BY t.created_at DESC`),
    pool.query(`SELECT c.id, c.tenant_id, c.label, c.base_url, c.protocol, c.supplier_group, c.active, c.created_at, t.name AS tenant_name
      FROM upstream_credentials c JOIN tenants t ON t.id = c.tenant_id ORDER BY c.created_at DESC`),
    pool.query(`SELECT r.*, t.name AS tenant_name, c.label AS credential_label, c.protocol
      FROM model_routes r JOIN tenants t ON t.id = r.tenant_id JOIN upstream_credentials c ON c.id = r.credential_id ORDER BY r.created_at DESC`),
    pool.query(`SELECT k.id, k.tenant_id, k.name, k.key_prefix, k.active, k.access_mode, k.allowed_route_id,
      k.key_encrypted IS NOT NULL AS can_copy, k.last_used_at, k.created_at,
      t.name AS tenant_name, r.display_name AS route_name, r.public_model_id, c.protocol
      FROM customer_api_keys k
      JOIN tenants t ON t.id = k.tenant_id
      LEFT JOIN model_routes r ON r.id = k.allowed_route_id
      LEFT JOIN upstream_credentials c ON c.id = r.credential_id
      ORDER BY k.created_at DESC`),
    pool.query(`SELECT o.*, t.name AS tenant_name FROM recharge_orders o JOIN tenants t ON t.id = o.tenant_id
      WHERE o.status = 'pending' ORDER BY o.created_at ASC`),
    pool.query('SELECT * FROM platform_settings WHERE id = 1'),
  ]);
  res.json({ tenants: tenants.rows, credentials: credentials.rows, routes: routes.rows, keys: keys.rows, orders: orders.rows, settings: settings.rows[0] });
});

app.post('/api/admin/keys', requireUser, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const route = await routeForKey({ routeId: String(req.body.routeId || '') });
  if (!name || !route) return res.status(400).json({ error: '请填写 Key 名称并选择可用服务' });
  const value = createApiKey();
  const managedRouteId = route.service_mode === 'managed' ? route.id : null;
  const { rows } = await pool.query(
    `INSERT INTO customer_api_keys
      (tenant_id, name, key_hash, key_prefix, key_encrypted, access_mode, managed_route_id, allowed_route_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, name, key_prefix, access_mode, allowed_route_id, active, created_at`,
    [route.tenant_id, name, hashApiKey(value), `${value.slice(0, 13)}...${value.slice(-4)}`,
      encryptSecret(value), route.service_mode, managedRouteId, route.id],
  );
  res.status(201).json({ key: rows[0], secret: value });
});

app.get('/api/admin/keys/:id/secret', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT key_encrypted FROM customer_api_keys WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Key 不存在' });
  if (!rows[0].key_encrypted) return res.status(409).json({ error: '该 Key 创建于可复制功能上线前，请重新生成' });
  res.json({ secret: decryptSecret(rows[0].key_encrypted) });
});

app.patch('/api/admin/keys/:id', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE customer_api_keys SET active = $2 WHERE id = $1 RETURNING id, active',
    [req.params.id, Boolean(req.body.active)],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Key 不存在' });
  res.json(rows[0]);
});

app.post('/api/admin/tenants', requireUser, requireAdmin, async (req, res) => {
  const { name, ownerEmail, ownerPassword } = req.body;
  if (!name || !ownerEmail || String(ownerPassword || '').length < 8) return res.status(400).json({ error: '客户名称、邮箱和至少 8 位密码为必填项' });
  const passwordHash = await bcrypt.hash(ownerPassword, 12);
  const result = await transaction(async (client) => {
    const tenant = await client.query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', [String(name).trim()]);
    const user = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, 'customer') RETURNING id, email, display_name, role`,
      [tenant.rows[0].id, String(ownerEmail).trim().toLowerCase(), passwordHash, String(name).trim()],
    );
    return { tenant: tenant.rows[0], user: user.rows[0] };
  });
  res.status(201).json(result);
});

app.post('/api/admin/credentials', requireUser, requireAdmin, async (req, res) => {
  const { tenantId, label, baseUrl, apiKey, protocol = 'openai', supplierGroup = '' } = req.body;
  if (!tenantId || !label || !baseUrl || !apiKey) return res.status(400).json({ error: '客户、名称、Base URL 和供应商 Key 为必填项' });
  let parsed;
  try { parsed = new URL(baseUrl); } catch { return res.status(400).json({ error: 'Base URL 格式无效' }); }
  if (parsed.protocol !== 'https:' && config.env === 'production') return res.status(400).json({ error: '生产环境 Base URL 必须使用 HTTPS' });
  const { rows } = await pool.query(
    `INSERT INTO upstream_credentials (tenant_id, label, base_url, api_key_encrypted, protocol, supplier_group)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, tenant_id, label, base_url, protocol, supplier_group, active`,
    [tenantId, String(label).trim(), parsed.toString().replace(/\/$/, ''), encryptSecret(apiKey), protocol, supplierGroup || null],
  );
  res.status(201).json(rows[0]);
});

app.post('/api/admin/routes', requireUser, requireAdmin, async (req, res) => {
  const { tenantId, credentialId, publicModelId, upstreamModelId, displayName } = req.body;
  if (!tenantId || !credentialId || !publicModelId || !upstreamModelId || !displayName) return res.status(400).json({ error: '模型配置不完整' });
  const serviceMode = req.body.serviceMode === 'managed' ? 'managed' : 'self_service';
  let prices;
  try { prices = pricingFields(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const pricingLabel = String(req.body.pricingLabel || '当前价格').trim();
  const { rows } = await pool.query(
    `INSERT INTO model_routes
      (tenant_id, credential_id, public_model_id, upstream_model_id, display_name,
       input_usd_per_million, output_usd_per_million, billing_factor,
       official_input_cny_per_million, official_cached_input_cny_per_million, official_output_cny_per_million,
       service_mode, customer_input_power_per_million, customer_cached_input_power_per_million, customer_output_power_per_million,
       reference_input_power_per_million, reference_cached_input_power_per_million, reference_output_power_per_million,
       upstream_input_power_per_million, upstream_cached_input_power_per_million, upstream_output_power_per_million,
       pricing_label)
     SELECT $1, c.id, $3, $4, $5, 0, 0, 1, 0, 0, 0,
            $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       FROM upstream_credentials c
      WHERE c.id = $2 AND c.tenant_id = $1
     RETURNING *`,
    [tenantId, credentialId, String(publicModelId).trim(), String(upstreamModelId).trim(), String(displayName).trim(),
      serviceMode, prices.customerInput, prices.customerCachedInput, prices.customerOutput,
      prices.referenceInput, prices.referenceCachedInput, prices.referenceOutput,
      prices.upstreamInput, prices.upstreamCachedInput, prices.upstreamOutput, pricingLabel],
  );
  if (!rows[0]) return res.status(400).json({ error: '供应商凭证不属于所选客户' });
  res.status(201).json(rows[0]);
});

app.patch('/api/admin/routes/:id', requireUser, requireAdmin, async (req, res) => {
  const current = await pool.query('SELECT * FROM model_routes WHERE id = $1', [req.params.id]);
  if (!current.rows[0]) return res.status(404).json({ error: '模型配置不存在' });
  const route = current.rows[0];
  const active = req.body.active === undefined ? route.active : Boolean(req.body.active);
  const isPricingUpdate = ['customerInputPrice', 'customerOutputPrice', 'referenceInputPrice', 'referenceOutputPrice']
    .some((field) => req.body[field] !== undefined);
  if (!isPricingUpdate) {
    const { rows } = await pool.query('UPDATE model_routes SET active = $2 WHERE id = $1 RETURNING *', [req.params.id, active]);
    return res.json(rows[0]);
  }
  let prices;
  try { prices = pricingFields(req.body, route); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const pricingLabel = String(req.body.pricingLabel || route.pricing_label || '当前价格').trim();
  const customNotification = String(req.body.notificationBody || '').trim();
  const result = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE model_routes SET active = $2,
        customer_input_power_per_million = $3, customer_cached_input_power_per_million = $4,
        customer_output_power_per_million = $5, reference_input_power_per_million = $6,
        reference_cached_input_power_per_million = $7, reference_output_power_per_million = $8,
        upstream_input_power_per_million = $9, upstream_cached_input_power_per_million = $10,
        upstream_output_power_per_million = $11, pricing_label = $12,
        pricing_version = pricing_version + 1, pricing_updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, active, prices.customerInput, prices.customerCachedInput, prices.customerOutput,
        prices.referenceInput, prices.referenceCachedInput, prices.referenceOutput,
        prices.upstreamInput, prices.upstreamCachedInput, prices.upstreamOutput, pricingLabel],
    );
    const updated = rows[0];
    const summary = [
      customNotification,
      `成交价：输入 ${Number(route.customer_input_power_per_million)} → ${Number(updated.customer_input_power_per_million)}，输出 ${Number(route.customer_output_power_per_million)} → ${Number(updated.customer_output_power_per_million)} 电力 / 1M Token。`,
      `官方参考：输入 ${Number(route.reference_input_power_per_million)} → ${Number(updated.reference_input_power_per_million)}，输出 ${Number(route.reference_output_power_per_million)} → ${Number(updated.reference_output_power_per_million)} 电力 / 1M Token。`,
    ].filter(Boolean).join(' ');
    await client.query(
      `INSERT INTO pricing_notifications (tenant_id, route_id, title, body, pricing_version)
       VALUES ($1, $2, $3, $4, $5)`,
      [updated.tenant_id, updated.id, `${updated.display_name} 价格已更新`, summary, updated.pricing_version],
    );
    return updated;
  });
  res.json(result);
});

app.post('/api/admin/recharge-orders/:id/confirm', requireUser, requireAdmin, async (req, res) => {
  const creditedPower = Number(req.body.creditedPower);
  const amountCny = req.body.amountCny === '' || req.body.amountCny === undefined ? null : Number(req.body.amountCny);
  if (!Number.isFinite(creditedPower) || creditedPower <= 0) return res.status(400).json({ error: '实际到账电力必须大于 0' });
  if (amountCny !== null && (!Number.isFinite(amountCny) || amountCny <= 0)) return res.status(400).json({ error: '实收人民币金额无效' });
  const creditedMicros = Math.round(creditedPower * 1_000_000);
  const settlementRate = amountCny === null ? null : amountCny / creditedPower;
  const result = await transaction(async (client) => {
    const order = await client.query("SELECT * FROM recharge_orders WHERE id = $1 AND status = 'pending' FOR UPDATE", [req.params.id]);
    if (!order.rows[0]) return null;
    const item = order.rows[0];
    const account = await client.query('SELECT balance_micros FROM tenants WHERE id = $1', [item.tenant_id]);
    const balanceBefore = Number(account.rows[0].balance_micros);
    const balanceAfter = balanceBefore + creditedMicros;
    await client.query(
      "UPDATE recharge_orders SET status = 'paid', paid_at = now(), credited_micros = $2, amount_cny = $3, settlement_cny_per_power = $4 WHERE id = $1",
      [item.id, creditedMicros, amountCny, settlementRate],
    );
    await client.query('UPDATE tenants SET balance_micros = $2 WHERE id = $1', [item.tenant_id, balanceAfter]);
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, type, amount_power, amount_micros, amount_cny, title, reference_id, created_by, balance_before_micros, balance_after_micros)
       VALUES ($1, 'recharge', 0, $2, $3, '充值入账', $4, $5, $6, $7)`,
      [item.tenant_id, creditedMicros, amountCny, item.id, req.user.id, balanceBefore, balanceAfter],
    );
    return item;
  });
  if (!result) return res.status(409).json({ error: '订单不存在或已经处理' });
  res.json({ ok: true });
});

app.use('/v1', proxyRouter);
app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*splat', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ? 409 : 500;
  res.status(status).json({ error: status === 409 ? '数据已存在，请检查邮箱或模型 ID' : '服务器内部错误' });
});

const server = app.listen(config.port, () => {
  console.log(`超级中转站已启动: ${config.publicBaseUrl}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
