import { defineConfig } from '@playwright/test';

/**
 * Playwright config for hosted-fields browser tests. Requires:
 *   - apps/api running (default http://localhost:8080)
 *   - apps/checkout running (default http://localhost:7001)
 *   - apps/scheme-simulator running (default http://localhost:9002)
 *
 * Easiest path: `make up` first, then `pnpm test:browser`.
 *
 * Skipped in default `pnpm test` to keep CI fast; CI runs this in a
 * dedicated `browser-tests` job (see ADR-0015).
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.CHECKOUT_BASE_URL ?? 'http://localhost:7001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
