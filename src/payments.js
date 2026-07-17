import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config, isWechatPayConfigured } from './config.js';
import { pool, transaction } from './db.js';
import { createNativePrepay, WechatPayError } from './wechat-pay.js';

const ORDER_LIFETIME_MS = 15 * 60 * 1000;
const MAX_POWER_PER_ORDER = 100_000;

function orderId() {
  return crypto.randomBytes(16).toString('hex');
}

function parsePower(value) {
  const power = Number(value);
  if (!Number.isFinite(power) || power <= 0 || power > MAX_POWER_PER_ORDER) {
    throw new WechatPayError(`单笔充值电力必须大于 0 且不超过 ${MAX_POWER_PER_ORDER}`, { code: 'INVALID_RECHARGE_AMOUNT', status: 400 });
  }
  const micros = Math.round(power * 1_000_000);
  if (Math.abs(micros / 1_000_000 - power) > 1e-9) {
    throw new WechatPayError('充值电力最多保留 6 位小数', { code: 'INVALID_RECHARGE_AMOUNT', status: 400 });
  }
  return micros;
}

async function presentOrder(row) {
  return {
    id: row.id,
    rechargeOrderId: row.recharge_order_id,
    requestedPowerMicros: Number(row.requested_power_micros),
    cnyPerPower: Number(row.cny_per_power_snapshot),
    amountFen: Number(row.amount_fen),
    amountCny: Number(row.amount_fen) / 100,
    status: row.status,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    qrCodeDataUrl: row.status === 'pending' && row.code_url
      ? await QRCode.toDataURL(row.code_url, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
      : null,
  };
}

export async function createWechatPayment({ tenantId, requestedPower }) {
  if (!isWechatPayConfigured()) {
    throw new WechatPayError('微信支付尚未开通，请联系管理员', { code: 'WECHAT_PAY_NOT_CONFIGURED', status: 503 });
  }
  const requestedPowerMicros = parsePower(requestedPower);
  const prepared = await transaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM wechat_pay_orders
        WHERE tenant_id = $1 AND requested_power_micros = $2 AND status IN ('creating', 'pending')
          AND julianday(expires_at) > julianday('now')
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, requestedPowerMicros],
    );
    if (existing.rows[0]?.status === 'creating') {
      throw new WechatPayError('相同金额的支付订单正在创建，请勿重复点击', { code: 'PAYMENT_ORDER_CREATING', status: 409 });
    }
    if (existing.rows[0]) return { existing: existing.rows[0] };

    const activeCount = await client.query(
      `SELECT count(*) AS total FROM wechat_pay_orders
        WHERE tenant_id = $1 AND status IN ('creating', 'pending')
          AND julianday(expires_at) > julianday('now')`,
      [tenantId],
    );
    if (Number(activeCount.rows[0].total) >= 3) {
      throw new WechatPayError('未支付订单过多，请先完成已有订单或等待 15 分钟', { code: 'TOO_MANY_PENDING_ORDERS', status: 429 });
    }

    const settings = await client.query('SELECT recharge_cny_per_power FROM platform_settings WHERE id = 1');
    const rate = Number(settings.rows[0]?.recharge_cny_per_power);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new WechatPayError('管理员设置的充值汇率无效', { code: 'INVALID_RECHARGE_RATE', status: 503 });
    }
    const amountFen = Math.round((requestedPowerMicros / 1_000_000) * rate * 100);
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      throw new WechatPayError('按当前汇率计算的支付金额无效', { code: 'INVALID_PAYMENT_AMOUNT', status: 400 });
    }

    const rechargeOrderId = orderId();
    const paymentOrderId = orderId();
    const outTradeNo = orderId();
    const expiresAt = new Date(Date.now() + ORDER_LIFETIME_MS).toISOString();
    await client.query(
      `INSERT INTO recharge_orders
        (id, tenant_id, requested_power_micros, amount_cny, settlement_cny_per_power, payment_channel, external_order_id)
       VALUES ($1, $2, $3, $4, $5, 'wechat_native', $6)`,
      [rechargeOrderId, tenantId, requestedPowerMicros, amountFen / 100, rate, outTradeNo],
    );
    const inserted = await client.query(
      `INSERT INTO wechat_pay_orders
        (id, recharge_order_id, tenant_id, out_trade_no, app_id, mch_id, requested_power_micros,
         cny_per_power_snapshot, amount_fen, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [paymentOrderId, rechargeOrderId, tenantId, outTradeNo, config.wechatPay.appId, config.wechatPay.mchId,
        requestedPowerMicros, rate, amountFen, expiresAt],
    );
    return { created: inserted.rows[0] };
  });

  if (prepared.existing) return presentOrder(prepared.existing);
  const item = prepared.created;
  try {
    const codeUrl = await createNativePrepay({
      outTradeNo: item.out_trade_no,
      description: `超级中转站 ${Number(item.requested_power_micros) / 1_000_000} 电力充值`,
      amountFen: Number(item.amount_fen),
      expiresAt: item.expires_at,
    });
    const updated = await pool.query(
      `UPDATE wechat_pay_orders SET code_url = $2, status = 'pending', updated_at = now()
        WHERE id = $1 AND status = 'creating' RETURNING *`,
      [item.id, codeUrl],
    );
    return presentOrder(updated.rows[0]);
  } catch (error) {
    const code = String(error.code || 'WECHAT_PAY_CREATE_FAILED').slice(0, 80);
    const message = String(error.message || '微信支付下单失败').slice(0, 200);
    await transaction(async (client) => {
      await client.query(
        `UPDATE wechat_pay_orders SET status = 'failed', failure_code = $2, failure_message = $3, updated_at = now()
          WHERE id = $1 AND status = 'creating'`,
        [item.id, code, message],
      );
      await client.query("UPDATE recharge_orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [item.recharge_order_id]);
    });
    throw error;
  }
}

export async function getWechatPayment({ tenantId, paymentOrderId }) {
  let result = await pool.query('SELECT * FROM wechat_pay_orders WHERE id = $1 AND tenant_id = $2', [paymentOrderId, tenantId]);
  if (!result.rows[0]) throw new WechatPayError('支付订单不存在', { code: 'PAYMENT_ORDER_NOT_FOUND', status: 404 });
  let item = result.rows[0];
  if (['creating', 'pending'].includes(item.status) && Date.parse(item.expires_at) <= Date.now()) {
    await transaction(async (client) => {
      await client.query(
        `UPDATE wechat_pay_orders SET status = 'expired', updated_at = now()
          WHERE id = $1 AND status IN ('creating', 'pending')`,
        [item.id],
      );
      await client.query("UPDATE recharge_orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [item.recharge_order_id]);
    });
    result = await pool.query('SELECT * FROM wechat_pay_orders WHERE id = $1 AND tenant_id = $2', [paymentOrderId, tenantId]);
    item = result.rows[0];
  }
  return presentOrder(item);
}

export async function expireWechatPayments() {
  return transaction(async (client) => {
    await client.query(
      `UPDATE recharge_orders SET status = 'cancelled'
        WHERE status = 'pending' AND id IN (
          SELECT recharge_order_id FROM wechat_pay_orders
           WHERE status IN ('creating', 'pending') AND julianday(expires_at) <= julianday('now')
        )`,
    );
    const result = await client.query(
      `UPDATE wechat_pay_orders SET status = 'expired', updated_at = now()
        WHERE status IN ('creating', 'pending') AND julianday(expires_at) <= julianday('now')`,
    );
    return result.rowCount;
  });
}

function validateSuccessfulTransaction(remote, local) {
  if (!remote || remote.trade_state !== 'SUCCESS') throw new WechatPayError('微信支付状态不是成功', { code: 'INVALID_PAYMENT_STATE', status: 400 });
  if (remote.mchid !== local.mch_id || remote.mchid !== config.wechatPay.mchId) throw new WechatPayError('微信支付商户号不匹配', { code: 'PAYMENT_MERCHANT_MISMATCH', status: 400 });
  if (remote.appid !== local.app_id || remote.appid !== config.wechatPay.appId) throw new WechatPayError('微信支付 AppID 不匹配', { code: 'PAYMENT_APPID_MISMATCH', status: 400 });
  if (remote.out_trade_no !== local.out_trade_no) throw new WechatPayError('微信支付订单号不匹配', { code: 'PAYMENT_ORDER_MISMATCH', status: 400 });
  if (Number(remote.amount?.total) !== Number(local.amount_fen) || remote.amount?.currency !== 'CNY') {
    throw new WechatPayError('微信支付金额或币种不匹配', { code: 'PAYMENT_AMOUNT_MISMATCH', status: 400 });
  }
  if (!remote.transaction_id) throw new WechatPayError('微信支付交易号缺失', { code: 'PAYMENT_TRANSACTION_ID_MISSING', status: 400 });
}

export async function creditWechatPayment(remote) {
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT p.*, r.status AS recharge_status, r.credited_micros
         FROM wechat_pay_orders p JOIN recharge_orders r ON r.id = p.recharge_order_id
        WHERE p.out_trade_no = $1`,
      [String(remote?.out_trade_no || '')],
    );
    const item = result.rows[0];
    if (!item) throw new WechatPayError('本地微信支付订单不存在', { code: 'PAYMENT_ORDER_NOT_FOUND', status: 404 });
    validateSuccessfulTransaction(remote, item);
    if (item.status === 'paid' && item.recharge_status === 'paid') return { credited: false, alreadyPaid: true };

    const account = await client.query('SELECT balance_micros FROM tenants WHERE id = $1', [item.tenant_id]);
    if (!account.rows[0]) throw new WechatPayError('充值账户不存在', { code: 'PAYMENT_TENANT_NOT_FOUND', status: 409 });
    const creditedMicros = Number(item.requested_power_micros);
    const balanceBefore = Number(account.rows[0].balance_micros);
    const balanceAfter = balanceBefore + creditedMicros;
    await client.query(
      `UPDATE wechat_pay_orders SET status = 'paid', wechat_transaction_id = $2,
        paid_at = $3, updated_at = now() WHERE id = $1`,
      [item.id, remote.transaction_id, remote.success_time || new Date().toISOString()],
    );
    await client.query(
      `UPDATE recharge_orders SET status = 'paid', paid_at = $2, credited_micros = $3,
        amount_cny = $4, settlement_cny_per_power = $5 WHERE id = $1`,
      [item.recharge_order_id, remote.success_time || new Date().toISOString(), creditedMicros,
        Number(item.amount_fen) / 100, Number(item.cny_per_power_snapshot)],
    );
    await client.query('UPDATE tenants SET balance_micros = $2 WHERE id = $1', [item.tenant_id, balanceAfter]);
    await client.query(
      `INSERT INTO ledger_entries
        (tenant_id, type, amount_power, amount_micros, amount_cny, title, reference_id,
         balance_before_micros, balance_after_micros)
       VALUES ($1, 'recharge', 0, $2, $3, '微信支付充值入账', $4, $5, $6)`,
      [item.tenant_id, creditedMicros, Number(item.amount_fen) / 100,
        item.recharge_order_id, balanceBefore, balanceAfter],
    );
    return { credited: true, alreadyPaid: false };
  });
}
