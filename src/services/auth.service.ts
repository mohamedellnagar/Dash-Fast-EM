import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface LoginResult {
  ok: boolean;
  userId?: string;
  reason?: 'INVALID_CREDENTIALS' | 'INACTIVE';
}

/** Verify credentials. Uses a constant-ish path to avoid user enumeration. */
export async function authenticate(email: string, password: string): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase().trim(), deletedAt: null },
  });
  if (!user) {
    // Perform a dummy hash to reduce timing signal.
    await bcrypt.compare(password, '$2a$12$0000000000000000000000000000000000000000000000000000');
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, reason: 'INVALID_CREDENTIALS' };
  if (!user.isActive) return { ok: false, reason: 'INACTIVE' };

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { ok: true, userId: user.id };
}
