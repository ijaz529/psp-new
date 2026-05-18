import { defineConfig } from 'vitest/config';

export const sharedVitestConfig = defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'test/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/*.test.ts', '**/*.spec.ts', '**/__fixtures__/**'],
    },
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});

export default sharedVitestConfig;
