import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'accounts.spec.ts', workers: 1,
  timeout: 90_000, expect: { timeout: 12_000 },
  use: { baseURL: 'http://127.0.0.1:5198', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
