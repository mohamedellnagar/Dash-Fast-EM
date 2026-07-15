import { defineConfig } from 'vitest/config';

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
