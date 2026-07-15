import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { disconnectPrisma } from './db/prisma';

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, 'FastTest dashboard listening');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
  // Force-exit if graceful close hangs.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Backstop: never let an unhandled async error take the whole server down.
// A rejected promise that escapes a route (e.g. a transient DB error such as a
// full temp disk) is logged and swallowed so the process keeps serving requests.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err: err.message, stack: err.stack }, 'unhandledRejection (kept alive)');
});
process.on('uncaughtException', (err: Error) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException (kept alive)');
});

export { app, server };
