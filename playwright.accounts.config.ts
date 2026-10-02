import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', workers: 1,
  forbidOnly: !!process.env.CI,
  outputDir: './test-results/accounts',
  reporter: process.env.CI ? [['./scripts/ci-browser-reporter.ts', { outputDir: './test-results/accounts' }]] : 'list',
  projects: [
    { name: 'accounts', testMatch: 'accounts.spec.ts' },
    { name: 'sharing', testMatch: 'sharing.spec.ts' },
  ],
  timeout: 90_000, expect: { timeout: 12_000 },
  use: { baseURL: 'http://127.0.0.1:5198', trace: process.env.CI ? 'off' : 'retain-on-failure', screenshot: 'only-on-failure' },
});
