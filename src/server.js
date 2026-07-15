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
import { createApiKey, encryptSecret, hashApiKey } from './crypto.js';
import { validateDiscount } from './billing.js';
import { proxyRouter } from './proxy.js';

assertProductionConfig();

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
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
  const [tenant, models, keys, usage, ledger, orders, settings] = await Promise.all([
    pool.query('SELECT id, name, balance_micros, reserved_micros, active FROM tenants WHERE id = $1', [tenantId]),
    pool.query(`SELECT public_model_id, display_name, active,
      official_input_cny_per_million, official_cached_input_cny_per_million, official_output_cny_per_million
      FROM model_routes WHERE tenant_id = $1 ORDER BY display_name`, [tenantId]),
    pool.query('SELECT id, name, key_prefix, active, expires_at, last_used_at, created_at FROM customer_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]),
    pool.query(`SELECT model_id, input_tokens, output_tokens, cached_input_tokens,
      official_cost_micros, charged_cost_micros, customer_discount,
      official_input_price, official_cached_input_price, official_output_price,
      status, error_code, request_id, created_at
      FROM usage_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]),
    pool.query('SELECT type, amount_micros, amount_cny, title, reference_id, balance_before_micros, balance_after_micros, created_at FROM ledger_entries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100', [tenantId]),
    pool.query('SELECT id, amount_cny, credited_micros, status, payment_channel, created_at FROM recharge_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [tenantId]),
    pool.query('SELECT customer_discount FROM platform_settings WHERE id = 1'),
  ]);
  res.json({
    tenant: tenant.rows[0], models: models.rows, keys: keys.rows, usage: usage.rows,
    ledger: ledger.rows, orders: orders.rows, publicBaseUrl: config.publicBaseUrl,
    customerDiscount: Number(settings.rows[0].customer_discount),
  });
});

app.post('/api/customer/keys', requireUser, async (req, res) => {
  if (!req.user.tenant_id) return res.status(403).json({ error: '仅客户可创建 Key' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入 Key 名称' });
  const value = createApiKey();
  const { rows } = await pool.query(
    `INSERT INTO customer_api_keys (tenant_id, name, key_hash, key_prefix)
     VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, active, created_at`,
    [req.user.tenant_id, name, hashApiKey(value), `${value.slice(0, 13)}...${value.slice(-4)}`],
  );
  res.status(201).json({ key: rows[0], secret: value });
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
  const amount = Number(req.body.amountCny);
  if (!req.user.tenant_id || ![50, 100, 500, 1000].includes(amount)) return res.status(400).json({ error: '充值金额无效' });
  const creditedMicros = Math.round(amount * 1_000_000);
  const { rows } = await pool.query(
    `INSERT INTO recharge_orders (tenant_id, amount_cny, power, credited_micros)
     VALUES ($1, $2, 1, $3) RETURNING id, amount_cny, credited_micros, status, created_at`,
    [req.user.tenant_id, amount, creditedMicros],
  );
  res.status(201).json(rows[0]);
});

app.get('/api/admin/dashboard', requireUser, requireAdmin, async (_req, res) => {
  const [tenants, credentials, routes, orders, settings] = await Promise.all([
    pool.query(`SELECT t.*, u.email AS owner_email,
      (SELECT count(*) FROM model_routes r WHERE r.tenant_id = t.id AND r.active = true) AS model_count
      FROM tenants t LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'customer' ORDER BY t.created_at DESC`),
    pool.query(`SELECT c.id, c.tenant_id, c.label, c.base_url, c.protocol, c.supplier_group, c.active, c.created_at, t.name AS tenant_name
      FROM upstream_credentials c JOIN tenants t ON t.id = c.tenant_id ORDER BY c.created_at DESC`),
    pool.query(`SELECT r.*, t.name AS tenant_name, c.label AS credential_label
      FROM model_routes r JOIN tenants t ON t.id = r.tenant_id JOIN upstream_credentials c ON c.id = r.credential_id ORDER BY r.created_at DESC`),
    pool.query(`SELECT o.*, t.name AS tenant_name FROM recharge_orders o JOIN tenants t ON t.id = o.tenant_id
      WHERE o.status = 'pending' ORDER BY o.created_at ASC`),
    pool.query('SELECT * FROM platform_settings WHERE id = 1'),
  ]);
  res.json({ tenants: tenants.rows, credentials: credentials.rows, routes: routes.rows, orders: orders.rows, settings: settings.rows[0] });
});

app.patch('/api/admin/settings', requireUser, requireAdmin, async (req, res) => {
  let discount;
  try { discount = validateDiscount(req.body.customerDiscount); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const { rows } = await pool.query(
    'UPDATE platform_settings SET customer_discount = $1, updated_at = now() WHERE id = 1 RETURNING *',
    [discount],
  );
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
  const prices = [req.body.inputPrice, req.body.cachedInputPrice, req.body.outputPrice].map(Number);
  if (prices.some((price) => !Number.isFinite(price) || price < 0)) return res.status(400).json({ error: '模型官网价格必须是大于或等于 0 的数字' });
  const { rows } = await pool.query(
    `INSERT INTO model_routes
      (tenant_id, credential_id, public_model_id, upstream_model_id, display_name,
       input_usd_per_million, output_usd_per_million, billing_factor,
       official_input_cny_per_million, official_cached_input_cny_per_million, official_output_cny_per_million)
     SELECT $1, c.id, $3, $4, $5, 0, 0, 1, $6, $7, $8
       FROM upstream_credentials c
      WHERE c.id = $2 AND c.tenant_id = $1
     RETURNING *`,
    [tenantId, credentialId, String(publicModelId).trim(), String(upstreamModelId).trim(), String(displayName).trim(), ...prices],
  );
  if (!rows[0]) return res.status(400).json({ error: '供应商凭证不属于所选客户' });
  res.status(201).json(rows[0]);
});

app.patch('/api/admin/routes/:id', requireUser, requireAdmin, async (req, res) => {
  const current = await pool.query('SELECT * FROM model_routes WHERE id = $1', [req.params.id]);
  if (!current.rows[0]) return res.status(404).json({ error: '模型配置不存在' });
  const route = current.rows[0];
  const active = req.body.active === undefined ? route.active : Boolean(req.body.active);
  const prices = [
    req.body.inputPrice ?? route.official_input_cny_per_million,
    req.body.cachedInputPrice ?? route.official_cached_input_cny_per_million,
    req.body.outputPrice ?? route.official_output_cny_per_million,
  ].map(Number);
  if (prices.some((price) => !Number.isFinite(price) || price < 0)) return res.status(400).json({ error: '模型官网价格必须是大于或等于 0 的数字' });
  const { rows } = await pool.query(
    `UPDATE model_routes SET active = $2, official_input_cny_per_million = $3,
      official_cached_input_cny_per_million = $4, official_output_cny_per_million = $5
      WHERE id = $1 RETURNING *`,
    [req.params.id, active, ...prices],
  );
  if (!rows[0]) return res.status(404).json({ error: '模型配置不存在' });
  res.json(rows[0]);
});

app.post('/api/admin/recharge-orders/:id/confirm', requireUser, requireAdmin, async (req, res) => {
  const result = await transaction(async (client) => {
    const order = await client.query("SELECT * FROM recharge_orders WHERE id = $1 AND status = 'pending' FOR UPDATE", [req.params.id]);
    if (!order.rows[0]) return null;
    const item = order.rows[0];
    const account = await client.query('SELECT balance_micros FROM tenants WHERE id = $1', [item.tenant_id]);
    const balanceBefore = Number(account.rows[0].balance_micros);
    const balanceAfter = balanceBefore + Number(item.credited_micros);
    await client.query("UPDATE recharge_orders SET status = 'paid', paid_at = now() WHERE id = $1", [item.id]);
    await client.query('UPDATE tenants SET balance_micros = $2 WHERE id = $1', [item.tenant_id, balanceAfter]);
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, type, amount_power, amount_micros, amount_cny, title, reference_id, created_by, balance_before_micros, balance_after_micros)
       VALUES ($1, 'recharge', 0, $2, $3, '充值入账', $4, $5, $6, $7)`,
      [item.tenant_id, item.credited_micros, item.amount_cny, item.id, req.user.id, balanceBefore, balanceAfter],
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
