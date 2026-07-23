import { defineConfig } from 'vitest/config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { testDatabaseUrl } = require('./scripts/test-db-url');

// Tests always run against the dedicated test schema, never dev data.
process.env.DATABASE_URL = testDatabaseUrl();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'node_modules/**'],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
