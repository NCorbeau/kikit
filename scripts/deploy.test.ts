import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deploy, parseConfig, type DeployActions, type Deployment } from './deploy.js';

const config = {
  project: '11111111-1111-1111-1111-111111111111',
  environment: '22222222-2222-2222-2222-222222222222',
  appService: '33333333-3333-3333-3333-333333333333',
  migrationService: '44444444-4444-4444-4444-444444444444',
  origin: 'https://example.com',
};

function harness(options: { migration?: string; app?: string; old?: string; health?: boolean } = {}) {
  const events: string[] = [];
  let stopped = false;
  let migrationUploaded = false;
  let appUploaded = false;
  let now = 0;
  const actions: DeployActions = {
    list: async service => {
      if (service === config.migrationService) {
        if (!migrationUploaded) return [{ id: 'prior-job', status: 'COMPLETED' }];
        return [{ id: 'new-job', status: options.migration ?? 'COMPLETED' }, { id: 'prior-job', status: 'COMPLETED' }];
      }
      const rows: Deployment[] = [{ id: 'old-app', status: stopped ? 'REMOVED' : options.old ?? 'SUCCESS' }];
      if (appUploaded) rows.unshift({ id: 'new-app', status: options.app ?? 'SUCCESS' });
      return rows;
    },
    stop: async () => { events.push('stop'); stopped = true; },
    upload: async service => {
      if (service === config.migrationService) {
        events.push('migrate'); migrationUploaded = true; return 'new-job';
      }
      events.push('app'); appUploaded = true; return 'new-app';
    },
    healthy: async () => { events.push('health'); return options.health ?? true; },
    sleep: async () => { now += 60_000; },
    now: () => now,
    log: () => {},
  };
  return { actions, events };
}

describe('deployment sequencing and failure recovery', () => {
  it('stops the old app, completes migrations, then deploys and checks health', async () => {
    const { actions, events } = harness();
    await deploy(config, actions);
    expect(events).toEqual(['stop', 'migrate', 'app', 'health']);
  });

  it.each(['FAILED', 'CRASHED', 'SUCCESS', 'BUILDING'])('does not start the app when the new job is %s', async migration => {
    const { actions, events } = harness({ migration });
    await expect(deploy(config, actions)).rejects.toThrow();
    expect(events).toEqual(['stop', 'migrate']);
  });

  it('waits for removal rather than trusting the stop command', async () => {
    const { actions, events } = harness();
    const list = actions.list;
    let removing = false;
    let first = true;
    actions.stop = async () => { events.push('stop'); removing = true; };
    actions.list = async service => {
      if (service === config.appService && removing && first) {
        first = false;
        return [{ id: 'old-app', status: 'REMOVING' }];
      }
      if (service === config.appService && removing && !events.includes('app')) return [{ id: 'old-app', status: 'REMOVED' }];
      return list(service);
    };
    actions.sleep = async () => { events.push('wait'); };
    await deploy(config, actions);
    expect(events.slice(0, 3)).toEqual(['stop', 'wait', 'migrate']);
  });

  it('does not migrate when stop fails', async () => {
    const { actions, events } = harness();
    actions.stop = async () => { throw new Error('stop failed'); };
    await expect(deploy(config, actions)).rejects.toThrow('stop failed');
    expect(events).toEqual([]);
  });

  it('allows removed deployments to disappear from the provider listing', async () => {
    const { actions } = harness();
    const list = actions.list;
    let stopped = false;
    actions.stop = async () => { stopped = true; };
    actions.list = async service => (await list(service)).filter(row => !(stopped && row.id === 'old-app'));
    await deploy(config, actions);
  });

  it('refuses an in-progress app before any mutation', async () => {
    const { actions, events } = harness({ old: 'BUILDING' });
    await expect(deploy(config, actions)).rejects.toThrow('unfinished');
    expect(events).toEqual([]);
  });

  it('refuses an already running migration job before stopping the app', async () => {
    const { actions, events } = harness();
    const list = actions.list;
    actions.list = service => service === config.migrationService
      ? Promise.resolve([{ id: 'other-job', status: 'DEPLOYING' }]) : list(service);
    await expect(deploy(config, actions)).rejects.toThrow('already active');
    expect(events).toEqual([]);
  });

  it('can retry while the app is already stopped', async () => {
    const { actions, events } = harness({ old: 'REMOVED' });
    await deploy(config, actions);
    expect(events).toEqual(['migrate', 'app', 'health']);
  });

  it('does not report success after a failed app or unavailable public healthcheck', async () => {
    for (const options of [{ app: 'CRASHED' }, { health: false }]) {
      const { actions } = harness(options);
      const logs: string[] = [];
      actions.log = message => { logs.push(message); };
      await expect(deploy(config, actions)).rejects.toThrow();
      expect(logs.some(message => message.includes('Deployed successfully'))).toBe(false);
    }
  });

  it('requires explicit separate service IDs and an exact HTTPS origin', () => {
    expect(parseConfig(config)).toEqual(config);
    expect(() => parseConfig({ ...config, appService: config.migrationService })).toThrow('separate');
    expect(() => parseConfig({ ...config, project: '' })).toThrow('UUID');
    expect(() => parseConfig({ ...config, origin: 'https://example.com/' })).toThrow('exact HTTPS');
  });
});

it('uploads committed archives to explicit targets and stops on app failure without leaking ignored files', () => {
  const root = mkdtempSync(join(tmpdir(), 'kikit-deploy-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/deploy.ts'), readFileSync(new URL('./deploy.ts', import.meta.url)));
    writeFileSync(join(root, '.gitignore'), 'deploy.config.json\n.env\n');
    writeFileSync(join(root, 'tracked.txt'), 'committed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Deployment Test', '-c', 'user.email=deploy@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    writeFileSync(join(root, 'deploy.config.json'), JSON.stringify(config));
    writeFileSync(join(root, '.env'), 'secret-test-only');
    const stateFile = join(root, '.git', 'mock-state.json');
    const binary = join(root, '.git', 'mock-railway.mjs');
    writeFileSync(binary, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
const file = ${JSON.stringify(stateFile)};
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { events: [] };
const service = args[args.indexOf('--service') + 1];
if (args[args.indexOf('--project') + 1] !== ${JSON.stringify(config.project)} || args[args.indexOf('--environment') + 1] !== ${JSON.stringify(config.environment)}) process.exit(2);
if (args[0] === 'down') { state.stopped = true; state.events.push('stop'); }
if (args[0] === 'up') {
  if (existsSync('.env') || existsSync('deploy.config.json') || readFileSync('tracked.txt', 'utf8') !== 'committed') process.exit(3);
  const app = service === ${JSON.stringify(config.appService)};
  state[app ? 'app' : 'job'] = true;
  state.events.push(app ? 'app' : 'job');
  console.log(JSON.stringify({ deploymentId: app ? 'new-app' : 'new-job' }));
}
if (args[0] === 'deployment') {
  const app = service === ${JSON.stringify(config.appService)};
  console.log(JSON.stringify(app
    ? (state.app ? [{ id: 'new-app', status: 'FAILED' }] : [{ id: 'old-app', status: state.stopped ? 'REMOVED' : 'SUCCESS' }])
    : (state.job ? [{ id: 'new-job', status: 'COMPLETED' }] : [])));
}
writeFileSync(file, JSON.stringify(state));
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), 'scripts/deploy.ts'], {
      cwd: root, env: { ...process.env, KIKIT_RAILWAY_BIN: binary }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('new-app FAILED');
    expect(result.stderr + result.stdout).not.toContain('secret-test-only');
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).events).toEqual(['stop', 'job', 'app']);
    // Uncommitted source must fail before invoking any remote operation.
    rmSync(stateFile);
    writeFileSync(join(root, 'tracked.txt'), 'uncommitted');
    const dirty = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), 'scripts/deploy.ts'], {
      cwd: root, env: { ...process.env, KIKIT_RAILWAY_BIN: binary }, encoding: 'utf8', timeout: 15_000,
    });
    expect(dirty.stderr).toContain('Commit or stash');
    expect(dirty.status).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
