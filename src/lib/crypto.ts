import crypto from 'crypto';
import { env } from '../config/env';

// AES-256-GCM authenticated encryption for secrets at rest (API keys,
// usernames, passwords for FastTest workspaces). The key comes from
// ENCRYPTION_KEY (32 bytes, hex or base64). Ciphertext format:
//   v1:<iv_b64>:<authTag_b64>:<cipher_b64>

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

function loadKey(): Buffer {
  const raw = env.encryptionKey;
  // Accept 64-char hex, base64, or a raw passphrase (hashed to 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  return crypto.createHash('sha256').update(raw).digest();
}

const KEY = loadKey();

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Invalid ciphertext format');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptOrNull(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  return encrypt(plaintext);
}

export function decryptOrNull(payload: string | null | undefined): string | null {
  if (!payload) return null;
  return decrypt(payload);
}

/** Mask a secret for display, e.g. "WSzq********NU8w". */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return '';
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}********${secret.slice(-4)}`;
}
