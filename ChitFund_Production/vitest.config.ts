import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true, maxForks: 1 },
    },
    testTimeout: 15000,
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
});
