import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
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
