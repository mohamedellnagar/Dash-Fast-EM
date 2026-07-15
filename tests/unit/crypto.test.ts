import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, maskSecret } from '../../src/lib/crypto';

describe('AES-256-GCM secret encryption', () => {
  it('round-trips plaintext', () => {
    const secret = 'WSzq-super-secret-api-key-NU8w';
    const enc = encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decrypt(enc)).toBe(secret);
  });
  it('produces different ciphertext each time (random IV)', () => {
    expect(encrypt('abc')).not.toBe(encrypt('abc'));
  });
  it('fails on tampered ciphertext', () => {
    const enc = encrypt('hello');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
  it('masks secrets for display', () => {
    expect(maskSecret('WSzqABCDEFGHNU8w')).toBe('WSzq********NU8w');
    expect(maskSecret('short')).toBe('********');
    expect(maskSecret('')).toBe('');
  });
});
