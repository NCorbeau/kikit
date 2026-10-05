import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DeployConfig } from './types.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseConfig(value: unknown): DeployConfig {
  const config = value as DeployConfig;
  for (const key of ['project', 'environment', 'appService', 'migrationService'] as const) {
    if (!config || typeof config[key] !== 'string' || !uuidPattern.test(config[key])) {
      throw new Error(`Set ${key} to its Railway UUID in deploy.config.json.`);
    }
  }
  if (config.appService === config.migrationService) {
    throw new Error('App and migration services must be separate.');
  }
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || url.origin !== config.origin) {
    throw new Error('origin must be an exact HTTPS origin.');
  }
  return config;
}

export function readConfig(root: string): DeployConfig {
  return parseConfig(JSON.parse(readFileSync(join(root, 'deploy.config.json'), 'utf8')));
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function currentCommit(root: string): string {
  return git(root, 'rev-parse', 'HEAD');
}

export function requireCleanWorkingTree(root: string): void {
  if (git(root, 'status', '--porcelain')) {
    throw new Error('Commit or stash working-tree changes before deploying. Only committed HEAD is uploaded.');
  }
}

function acquireLocalLock(config: DeployConfig): () => void {
  const key = createHash('sha256').update(`${config.project}:${config.environment}`).digest('hex');
  const lock = join(tmpdir(), `kikit-deploy-${key}.lock`);
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch {
    throw new Error(`Another local deployment may be running. Inspect it before removing ${lock}.`);
  }
  try {
    writeFileSync(fd, String(process.pid));
  } catch (error) {
    closeSync(fd);
    rmSync(lock);
    throw error;
  }
  return () => {
    closeSync(fd);
    rmSync(lock);
  };
}

function extractCommit(root: string, commit: string, snapshot: string): void {
  const archive = join(snapshot, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], { cwd: root, stdio: 'ignore' });
  execFileSync('tar', ['-xf', archive, '-C', snapshot], { stdio: 'ignore' });
  rmSync(archive);
}

/** Keep the local lock until the workflow settles, and always remove its archive. */
export async function withDeploymentSnapshot(
  root: string,
  commit: string,
  config: DeployConfig,
  run: (snapshot: string) => Promise<void>,
): Promise<void> {
  const releaseLock = acquireLocalLock(config);
  try {
    const snapshot = mkdtempSync(join(tmpdir(), 'kikit-deploy-'));
    try {
      extractCommit(root, commit, snapshot);
      await run(snapshot);
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
  } finally {
    releaseLock();
  }
}
