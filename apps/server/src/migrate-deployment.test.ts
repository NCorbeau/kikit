import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('fails deployment migration without printing credentials or seeding fixtures', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/src/migrate-deployment.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', KIKIT_DEV_FIXTURE: '1', KIKIT_MIGRATION_DATABASE_URL: 'postgres://secret-test-value@invalid' },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Deployment migration failed');
  expect(result.stderr).not.toContain('secret-test-value');
  expect(result.stdout).not.toContain('completed');
});
