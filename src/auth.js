import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { hashApiKey } from './crypto.js';
import { pool } from './db.js';

const cookieName = 'super_relay_session';

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role, tenantId: user.tenant_id }, config.sessionSecret, { expiresIn: '12h' });
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(cookieName);
}

export async function requireUser(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies[cookieName], config.sessionSecret);
    const { rows } = await pool.query(
      'SELECT id, email, display_name, role, tenant_id, active FROM users WHERE id = $1',
      [payload.sub],
    );
    if (!rows[0]?.active) return res.status(401).json({ error: '登录已失效' });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: '请先登录' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

export async function requireCustomerApiKey(req, res, next) {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || req.get('x-api-key');
  if (!token) return res.status(401).json({ error: { message: 'API Key 缺失', type: 'authentication_error' } });
  const { rows } = await pool.query(
    `SELECT k.id AS api_key_id, k.tenant_id, k.name, t.balance_micros, t.reserved_micros, t.active AS tenant_active
       FROM customer_api_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1 AND k.active = true AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [hashApiKey(token)],
  );
  if (!rows[0]?.tenant_active) return res.status(401).json({ error: { message: 'API Key 无效或已停用', type: 'authentication_error' } });
  req.apiPrincipal = rows[0];
  next();
}
