import crypto from 'node:crypto';
import { config } from './config.js';

function encryptionKey() {
  const key = Buffer.from(config.encryptionKey || '', 'base64');
  if (key.length !== 32) throw new Error('UPSTREAM_KEY_ENCRYPTION_KEY 必须是 32 字节 Base64');
  return key;
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value) {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hashApiKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createApiKey() {
  return `sk-live-${crypto.randomBytes(24).toString('base64url')}`;
}
