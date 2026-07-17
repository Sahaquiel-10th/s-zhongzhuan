import 'dotenv/config';

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4173,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4173',
  databasePath: process.env.NODE_ENV === 'test' ? ':memory:' : (process.env.DATABASE_PATH || './data/super-relay.db'),
  sessionSecret: process.env.SESSION_SECRET || 'development-only-session-secret',
  encryptionKey: process.env.UPSTREAM_KEY_ENCRYPTION_KEY,
  adminAccount: (process.env.ADMIN_ACCOUNT || process.env.ADMIN_EMAIL || 'admin').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me-now',
  reservationOutputTokens: numberFromEnv('RESERVATION_OUTPUT_TOKENS', 2048),
  wechatPay: {
    appId: process.env.WECHAT_PAY_APP_ID || '',
    mchId: process.env.WECHAT_PAY_MCH_ID || '',
    merchantSerialNo: process.env.WECHAT_PAY_MERCHANT_SERIAL_NO || '',
    privateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '',
    publicKeyId: process.env.WECHAT_PAY_PUBLIC_KEY_ID || '',
    publicKeyPath: process.env.WECHAT_PAY_PUBLIC_KEY_PATH || '',
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || '',
  },
};

export function isWechatPayConfigured() {
  return Object.values(config.wechatPay).every((value) => String(value).trim());
}

export function assertProductionConfig() {
  const missing = [];
  if (config.env === 'production' && config.sessionSecret.length < 32) missing.push('SESSION_SECRET (至少 32 字符)');
  if (!config.encryptionKey) missing.push('UPSTREAM_KEY_ENCRYPTION_KEY');
  if (config.env === 'production' && config.adminPassword === 'change-me-now') missing.push('ADMIN_PASSWORD');
  if (missing.length) throw new Error(`缺少必要配置: ${missing.join(', ')}`);
}
