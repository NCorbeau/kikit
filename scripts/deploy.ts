import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface DeployConfig {
  project: string;
  environment: string;
  appService: string;
  migrationService: string;
  origin: string;
}
export interface Deployment { id: string; status: string }
export interface DeployActions {
  list(service: string): Promise<Deployment[]>;
  stop(service: string): Promise<void>;
  upload(service: string): Promise<string>;
  healthy(): Promise<boolean>;
  sleep(): Promise<void>;
  now(): number;
  log(message: string): void;
}
const idle = new Set(['REMOVED', 'COMPLETED', 'FAILED', 'CRASHED', 'SKIPPED']);
const failed = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

export function parseConfig(value: unknown): DeployConfig {
  const config = value as DeployConfig;
  for (const key of ['project', 'environment', 'appService', 'migrationService'] as const) {
    if (!config || typeof config[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config[key])) {
      throw new Error(`Set ${key} to its Railway UUID in deploy.config.json.`);
    }
  }
  if (config.appService === config.migrationService) throw new Error('App and migration services must be separate.');
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || url.origin !== config.origin) throw new Error('origin must be an exact HTTPS origin.');
  return config;
}

/** Never advance on a build result alone, a previous deployment, or a job still running. */
export async function deploy(config: DeployConfig, actions: DeployActions): Promise<void> {
  const wait = async (message: string, check: () => Promise<boolean>) => {
    const deadline = actions.now() + 15 * 60_000;
    while (!await check()) {
      if (actions.now() >= deadline) throw new Error(`Timed out: ${message}. Check Railway before retrying.`);
      await actions.sleep();
    }
  };
  const [app, migration] = await Promise.all([actions.list(config.appService), actions.list(config.migrationService)]);
  if (migration.some(row => !idle.has(row.status))) throw new Error('Migration service is already active; inspect Railway first.');
  const active = app.filter(row => !idle.has(row.status));
  if (active.length > 1 || active.some(row => row.status !== 'SUCCESS')) {
    throw new Error('App has an unfinished or overlapping deployment; inspect Railway first.');
  }
  if (active.length) {
    actions.log('Stopping the app and waiting for removal…');
    await actions.stop(config.appService);
    await wait('old app removal', async () => {
      const rows = await actions.list(config.appService);
      // Railway may omit removed deployments. The job's database ownership
      // lock is the final proof that the old server can no longer mutate data.
      return rows.every(row => idle.has(row.status));
    });
  }
  const waitDeployment = async (service: string, id: string, expected: string) => {
    await wait(`${service} deployment ${id}`, async () => {
      const row = (await actions.list(service)).find(row => row.id === id);
      if (row && failed.has(row.status)) throw new Error(`Deployment ${id} ${row.status}; inspect its Railway logs.`);
      if (row?.status === 'COMPLETED' && expected !== 'COMPLETED') throw new Error(`App deployment ${id} exited unexpectedly.`);
      return row?.status === expected;
    });
  };
  actions.log('Building the committed snapshot and applying migrations…');
  const migrationId = await actions.upload(config.migrationService);
  await waitDeployment(config.migrationService, migrationId, 'COMPLETED');
  actions.log('Migrations completed. Deploying the matching app…');
  const appId = await actions.upload(config.appService);
  await waitDeployment(config.appService, appId, 'SUCCESS');
  await wait('public healthcheck', async () => {
    const row = (await actions.list(config.appService)).find(row => row.id === appId);
    if (!row || row.status !== 'SUCCESS') throw new Error(`App deployment ${appId} is no longer healthy in Railway.`);
    return actions.healthy();
  });
  actions.log(`Deployed successfully: ${config.origin} (${appId})`);
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const config = parseConfig(JSON.parse(readFileSync(join(root, 'deploy.config.json'), 'utf8')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (process.argv.includes('--dry-run')) {
    console.info(`Plan for ${commit}: stop app ${config.appService}, run migration service ${config.migrationService}, deploy app, check ${config.origin}/api/health. No remote actions performed.`);
    return;
  }
  if (git('status', '--porcelain')) throw new Error('Commit or stash working-tree changes before deploying. Only committed HEAD is uploaded.');
  const binary = process.env.KIKIT_RAILWAY_BIN || 'railway';
  try { execFileSync(binary, ['--version'], { stdio: 'ignore' }); }
  catch { throw new Error('Install Railway CLI (tested with 5.63.1) and run railway login first.'); }
  const key = createHash('sha256').update(`${config.project}:${config.environment}`).digest('hex');
  const lock = join(tmpdir(), `kikit-deploy-${key}.lock`);
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error(`Another local deployment may be running. Inspect it before removing ${lock}.`); }
  writeFileSync(fd, String(process.pid));
  let snapshot: string | undefined;
  try {
    snapshot = mkdtempSync(join(tmpdir(), 'kikit-deploy-'));
    const archive = join(snapshot, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], { cwd: root, stdio: 'ignore' });
    execFileSync('tar', ['-xf', archive, '-C', snapshot], { stdio: 'ignore' });
    rmSync(archive);
    const railway = (args: string[]) => {
      try {
        return execFileSync(binary, args, { cwd: snapshot, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { throw new Error(`Railway ${args[0]} failed. Check CLI login, service configuration and the Railway dashboard. Raw CLI output is withheld to protect secrets.`); }
    };
    const target = (service: string) => ['--project', config.project, '--environment', config.environment, '--service', service];
    console.info(`Deploying committed HEAD ${commit}. Downtime begins after preflight.`);
    await deploy(config, {
      list: async service => JSON.parse(railway(['deployment', 'list', ...target(service), '--limit', '1000', '--json'])),
      stop: async service => { railway(['down', ...target(service), '--yes']); },
      upload: async service => {
        const result = JSON.parse(railway(['up', ...target(service), '--detach', '--json', '--message', `kikit ${commit}`]));
        if (typeof result.deploymentId !== 'string') throw new Error('Railway did not return a deployment ID. Inspect the dashboard before retrying.');
        return result.deploymentId;
      },
      healthy: async () => {
        try { return (await fetch(`${config.origin}/api/health`, { signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store' })).ok; }
        catch { return false; }
      },
      sleep: () => new Promise(resolve => setTimeout(resolve, 5000)),
      now: Date.now,
      log: console.info,
    });
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    closeSync(fd);
    rmSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Deployment stopped: ${error instanceof Error ? error.message : 'unknown failure'}`);
    console.error('If shutdown began, the app may remain offline. Inspect Railway; do not automatically roll back after a migration.');
    process.exitCode = 1;
  });
}
