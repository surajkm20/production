import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 15000,
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
});
