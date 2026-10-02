import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('fails the restore command without exposing a driver error containing credentials', async () => {
  const credential = 'test-only-driver-secret-must-not-reach-logs';
  // Fail the first admin query before any connection, database, role, or dump is created.
  const preload = `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(pathToFileURL(join(process.cwd(), 'package.json')).href)});
    const pg = require('pg');
    pg.Pool.prototype.query = () => Promise.reject(new Error(${JSON.stringify(credential)}));
  `;
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/verify-backup-restore.ts',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  expect(code).toBe(1);
  expect(output).toContain('Local backup restore failed.');
  expect(output).not.toContain(credential);
  expect(output).not.toContain('Local backup restore passed');
});
