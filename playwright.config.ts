import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: 'accounts.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  outputDir: './test-results/fixture',
  reporter: process.env.CI ? [['./scripts/ci-browser-reporter.ts', { outputDir: './test-results/fixture' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'pnpm --filter @kikit/web dev --port 5174',
    url: 'http://127.0.0.1:5174',
    env: { KIKIT_API_TARGET: 'http://127.0.0.1:3002' },
    reuseExistingServer: false,
  },
});
