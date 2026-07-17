import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { creditWechatPayment } from '../src/payments.js';
import {
  decryptNotificationResource,
  requestSignatureMessage,
  responseSignatureMessage,
  verifyWechatSignature,
  WechatPayError,
} from '../src/wechat-pay.js';

test('request signature message follows WeChat Pay API v3 canonical format', () => {
  assert.equal(
    requestSignatureMessage('post', '/v3/pay/transactions/native', 1710000000, 'nonce', '{"amount":1}'),
    'POST\n/v3/pay/transactions/native\n1710000000\nnonce\n{"amount":1}\n',
  );
});

test('callback signature is verified and stale callbacks are rejected', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  config.wechatPay.publicKeyId = 'PUB_KEY_ID_TEST';
  const timestamp = 1710000000;
  const nonce = 'callback-nonce';
  const body = '{"event_type":"TRANSACTION.SUCCESS"}';
  const signature = crypto.sign('RSA-SHA256', Buffer.from(responseSignatureMessage(timestamp, nonce, body)), privateKey).toString('base64');
  const headers = {
    'wechatpay-timestamp': String(timestamp),
    'wechatpay-nonce': nonce,
    'wechatpay-serial': 'PUB_KEY_ID_TEST',
    'wechatpay-signature': signature,
  };
  assert.equal(verifyWechatSignature({ headers, body, publicKey, nowSeconds: timestamp }), true);
  assert.throws(
    () => verifyWechatSignature({ headers, body, publicKey, nowSeconds: timestamp + 301 }),
    (error) => error instanceof WechatPayError && error.code === 'INVALID_WECHAT_SIGNATURE',
  );
  assert.throws(
    () => verifyWechatSignature({ headers, body: `${body} `, publicKey, nowSeconds: timestamp }),
    (error) => error instanceof WechatPayError && error.code === 'INVALID_WECHAT_SIGNATURE',
  );
});

test('notification resource is decrypted with AES-256-GCM and tampering fails', () => {
  const key = '0123456789abcdef0123456789abcdef';
  const nonce = '123456789012';
  const associatedData = 'transaction';
  const payload = { out_trade_no: 'test-order', trade_state: 'SUCCESS', amount: { total: 700 } };
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  const resource = { nonce, associated_data: associatedData, ciphertext: ciphertext.toString('base64') };
  assert.deepEqual(decryptNotificationResource(resource, key), payload);
  const tampered = Buffer.from(ciphertext);
  tampered[0] ^= 1;
  assert.throws(
    () => decryptNotificationResource({ ...resource, ciphertext: tampered.toString('base64') }, key),
    (error) => error instanceof WechatPayError && error.code === 'INVALID_WECHAT_RESOURCE',
  );
});

test('verified payment crediting is idempotent and updates balance in one transaction', async () => {
  config.wechatPay.appId = 'wx-test-app';
  config.wechatPay.mchId = 'test-merchant';
  await pool.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, balance_micros INTEGER NOT NULL);
    CREATE TABLE recharge_orders (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, requested_power_micros INTEGER NOT NULL,
      amount_cny REAL, credited_micros INTEGER NOT NULL DEFAULT 0, settlement_cny_per_power REAL,
      status TEXT NOT NULL, payment_channel TEXT, external_order_id TEXT, paid_at TEXT
    );
    CREATE TABLE wechat_pay_orders (
      id TEXT PRIMARY KEY, recharge_order_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      out_trade_no TEXT UNIQUE NOT NULL, app_id TEXT NOT NULL, mch_id TEXT NOT NULL,
      requested_power_micros INTEGER NOT NULL, cny_per_power_snapshot REAL NOT NULL,
      amount_fen INTEGER NOT NULL, status TEXT NOT NULL, wechat_transaction_id TEXT UNIQUE,
      updated_at TEXT, paid_at TEXT
    );
    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      type TEXT NOT NULL, amount_power INTEGER, amount_micros INTEGER, amount_cny REAL,
      title TEXT, reference_id TEXT, balance_before_micros INTEGER, balance_after_micros INTEGER
    );
    CREATE UNIQUE INDEX test_ledger_recharge_unique ON ledger_entries(reference_id) WHERE type = 'recharge';
    INSERT INTO tenants VALUES ('tenant-1', 1000000);
    INSERT INTO recharge_orders VALUES ('recharge-1', 'tenant-1', 10000000, 70, 0, 7, 'pending', 'wechat_native', 'trade-1', NULL);
    INSERT INTO wechat_pay_orders VALUES ('pay-1', 'recharge-1', 'tenant-1', 'trade-1', 'wx-test-app', 'test-merchant', 10000000, 7, 7000, 'pending', NULL, NULL, NULL);
  `);
  const remote = {
    appid: 'wx-test-app', mchid: 'test-merchant', out_trade_no: 'trade-1', transaction_id: 'wx-transaction-1',
    trade_state: 'SUCCESS', success_time: '2026-07-17T10:00:00+08:00', amount: { total: 7000, currency: 'CNY' },
  };
  assert.deepEqual(await creditWechatPayment(remote), { credited: true, alreadyPaid: false });
  assert.deepEqual(await creditWechatPayment(remote), { credited: false, alreadyPaid: true });
  const account = await pool.query('SELECT balance_micros FROM tenants WHERE id = $1', ['tenant-1']);
  const ledger = await pool.query('SELECT count(*) AS total FROM ledger_entries WHERE reference_id = $1', ['recharge-1']);
  assert.equal(Number(account.rows[0].balance_micros), 11_000_000);
  assert.equal(Number(ledger.rows[0].total), 1);
});
