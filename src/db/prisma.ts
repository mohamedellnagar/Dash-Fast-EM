import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// Single shared Prisma client. In tests a distinct DATABASE_URL points at a
// throwaway SQLite file so runs never touch dev data.
export const prisma = new PrismaClient({
  log: env.isProd ? ['warn', 'error'] : ['warn', 'error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
