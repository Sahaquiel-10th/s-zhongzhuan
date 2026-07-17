import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, requireUser } from '../src/auth.js';
import { pool } from '../src/db.js';

function sessionFor(user) {
  let token;
  issueSession({ cookie(_name, value) { token = value; } }, user);
  return token;
}

async function authenticate(token) {
  let statusCode;
  let payload;
  let calledNext = false;
  const req = { cookies: { super_relay_session: token } };
  const res = {
    status(value) { statusCode = value; return this; },
    json(value) { payload = value; return this; },
  };
  await requireUser(req, res, () => { calledNext = true; });
  return { req, statusCode, payload, calledNext };
}

test('changing session version revokes previously issued login cookies', async () => {
  await pool.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, display_name TEXT, role TEXT, tenant_id TEXT,
      active INTEGER NOT NULL, session_version INTEGER NOT NULL
    );
    INSERT INTO users VALUES ('user-1', 'demo', 'Demo', 'customer', 'tenant-1', 1, 1);
  `);
  const token = sessionFor({ id: 'user-1', role: 'customer', tenant_id: 'tenant-1', session_version: 1 });
  const before = await authenticate(token);
  assert.equal(before.calledNext, true);
  assert.equal(before.req.user.email, 'demo');

  await pool.query('UPDATE users SET session_version = 2 WHERE id = $1', ['user-1']);
  const after = await authenticate(token);
  assert.equal(after.calledNext, false);
  assert.equal(after.statusCode, 401);
  assert.match(after.payload.error, /重新登录/);
});
