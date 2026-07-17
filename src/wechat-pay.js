import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, isWechatPayConfigured } from './config.js';

const API_BASE_URL = 'https://api.mch.weixin.qq.com';
const MAX_SIGNATURE_AGE_SECONDS = 300;
let cachedKeys;

export class WechatPayError extends Error {
  constructor(message, { code = 'WECHAT_PAY_ERROR', status = 502 } = {}) {
    super(message);
    this.name = 'WechatPayError';
    this.code = code;
    this.status = status;
  }
}

function requireConfiguration() {
  if (!isWechatPayConfigured()) {
    throw new WechatPayError('微信支付尚未完成服务器配置', { code: 'WECHAT_PAY_NOT_CONFIGURED', status: 503 });
  }
  if (Buffer.byteLength(config.wechatPay.apiV3Key, 'utf8') !== 32) {
    throw new WechatPayError('微信支付 API v3 密钥必须正好是 32 字节', { code: 'WECHAT_PAY_CONFIG_INVALID', status: 503 });
  }
  let notifyUrl;
  try { notifyUrl = new URL(config.wechatPay.notifyUrl); }
  catch { throw new WechatPayError('微信支付回调地址格式无效', { code: 'WECHAT_PAY_CONFIG_INVALID', status: 503 }); }
  if (notifyUrl.protocol !== 'https:') {
    throw new WechatPayError('微信支付回调地址必须使用 HTTPS', { code: 'WECHAT_PAY_CONFIG_INVALID', status: 503 });
  }
}

function paymentKeys() {
  requireConfiguration();
  if (!cachedKeys) {
    try {
      cachedKeys = {
        privateKey: crypto.createPrivateKey(fs.readFileSync(config.wechatPay.privateKeyPath)),
        publicKey: crypto.createPublicKey(fs.readFileSync(config.wechatPay.publicKeyPath)),
      };
    } catch {
      throw new WechatPayError('无法读取微信支付密钥文件，请检查路径和权限', { code: 'WECHAT_PAY_KEY_UNAVAILABLE', status: 503 });
    }
  }
  return cachedKeys;
}

export function requestSignatureMessage(method, canonicalUrl, timestamp, nonce, body = '') {
  return `${method.toUpperCase()}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body}\n`;
}

export function responseSignatureMessage(timestamp, nonce, body) {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

function signRequest(method, canonicalUrl, timestamp, nonce, body) {
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(requestSignatureMessage(method, canonicalUrl, timestamp, nonce, body)),
    paymentKeys().privateKey,
  ).toString('base64');
  const fields = [
    `mchid="${config.wechatPay.mchId}"`,
    `nonce_str="${nonce}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.wechatPay.merchantSerialNo}"`,
    `signature="${signature}"`,
  ];
  return `WECHATPAY2-SHA256-RSA2048 ${fields.join(',')}`;
}

function headerValue(headers, name) {
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name.toLowerCase()] || headers[name];
  return String(value || '').trim();
}

export function verifyWechatSignature({ headers, body, enforceFreshness = true, nowSeconds = Math.floor(Date.now() / 1000), publicKey }) {
  const timestamp = headerValue(headers, 'wechatpay-timestamp');
  const nonce = headerValue(headers, 'wechatpay-nonce');
  const serial = headerValue(headers, 'wechatpay-serial');
  const signature = headerValue(headers, 'wechatpay-signature');
  if (!timestamp || !nonce || !serial || !signature) {
    throw new WechatPayError('微信支付签名请求头不完整', { code: 'INVALID_WECHAT_SIGNATURE', status: 401 });
  }
  if (serial !== config.wechatPay.publicKeyId) {
    throw new WechatPayError('微信支付公钥 ID 不匹配', { code: 'INVALID_WECHAT_SIGNATURE', status: 401 });
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber)
      || (enforceFreshness && Math.abs(nowSeconds - timestampNumber) > MAX_SIGNATURE_AGE_SECONDS)) {
    throw new WechatPayError('微信支付签名时间已失效', { code: 'INVALID_WECHAT_SIGNATURE', status: 401 });
  }
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(responseSignatureMessage(timestamp, nonce, body)),
    publicKey || paymentKeys().publicKey,
    Buffer.from(signature, 'base64'),
  );
  if (!verified) throw new WechatPayError('微信支付回调验签失败', { code: 'INVALID_WECHAT_SIGNATURE', status: 401 });
  return true;
}

export function decryptNotificationResource(resource, apiV3Key = config.wechatPay.apiV3Key) {
  if (!resource?.ciphertext || !resource?.nonce) {
    throw new WechatPayError('微信支付回调加密报文不完整', { code: 'INVALID_WECHAT_RESOURCE', status: 400 });
  }
  const encrypted = Buffer.from(resource.ciphertext, 'base64');
  if (encrypted.length <= 16) {
    throw new WechatPayError('微信支付回调密文无效', { code: 'INVALID_WECHAT_RESOURCE', status: 400 });
  }
  try {
    const ciphertext = encrypted.subarray(0, -16);
    const authTag = encrypted.subarray(-16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(resource.nonce, 'utf8'));
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data || '', 'utf8'));
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch {
    throw new WechatPayError('微信支付回调解密失败', { code: 'INVALID_WECHAT_RESOURCE', status: 400 });
  }
}

async function wechatRequest(pathname, payload) {
  requireConfiguration();
  const method = 'POST';
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const response = await fetch(`${API_BASE_URL}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: signRequest(method, pathname, timestamp, nonce, body),
      'user-agent': 'super-relay-wechatpay/1.0',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => {
    throw new WechatPayError(`连接微信支付失败：${error.name === 'TimeoutError' ? '请求超时' : '网络异常'}`);
  });
  const responseBody = await response.text();
  verifyWechatSignature({ headers: response.headers, body: responseBody, enforceFreshness: false });
  let result;
  try { result = responseBody ? JSON.parse(responseBody) : {}; }
  catch { throw new WechatPayError('微信支付返回了无法解析的响应'); }
  if (!response.ok) {
    const code = String(result.code || 'WECHAT_PAY_API_ERROR').slice(0, 80);
    const message = String(result.message || '微信支付下单失败').slice(0, 200);
    throw new WechatPayError(message, { code, status: response.status >= 500 ? 502 : 400 });
  }
  return result;
}

export async function createNativePrepay({ outTradeNo, description, amountFen, expiresAt }) {
  const result = await wechatRequest('/v3/pay/transactions/native', {
    appid: config.wechatPay.appId,
    mchid: config.wechatPay.mchId,
    description,
    out_trade_no: outTradeNo,
    time_expire: expiresAt,
    notify_url: config.wechatPay.notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
  });
  if (!result.code_url) throw new WechatPayError('微信支付未返回付款二维码');
  return result.code_url;
}

export function parseWechatNotification(headers, rawBody) {
  requireConfiguration();
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  verifyWechatSignature({ headers, body, enforceFreshness: true });
  let notification;
  try { notification = JSON.parse(body); }
  catch { throw new WechatPayError('微信支付回调 JSON 无效', { code: 'INVALID_WECHAT_NOTIFICATION', status: 400 }); }
  if (notification.event_type !== 'TRANSACTION.SUCCESS') return { notification, transaction: null };
  if (notification.resource_type !== 'encrypt-resource') {
    throw new WechatPayError('微信支付回调资源类型无效', { code: 'INVALID_WECHAT_NOTIFICATION', status: 400 });
  }
  return { notification, transaction: decryptNotificationResource(notification.resource) };
}
