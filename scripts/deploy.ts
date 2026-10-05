import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentCommit, readConfig, requireCleanWorkingTree, withDeploymentSnapshot } from './deployment/local.js';
import { createRailwayActions, requireRailwayCli } from './deployment/railway.js';
import { deploy } from './deployment/workflow.js';

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const config = readConfig(root);
  const commit = currentCommit(root);

  if (process.argv.includes('--dry-run')) {
    console.info(`Plan for ${commit}: stop app ${config.appService}, run migration service ${config.migrationService}, deploy app, check ${config.origin}/api/health. No remote actions performed.`);
    return;
  }

  requireCleanWorkingTree(root);
  const binary = process.env.KIKIT_RAILWAY_BIN || 'railway';
  requireRailwayCli(binary);

  await withDeploymentSnapshot(root, commit, config, async snapshot => {
    console.info(`Deploying committed HEAD ${commit}. Downtime begins after preflight.`);
    const actions = createRailwayActions(config, binary, snapshot, commit);
    await deploy(config, actions);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Deployment stopped: ${error instanceof Error ? error.message : 'unknown failure'}`);
    console.error('If shutdown began, the app may remain offline. Inspect Railway; do not automatically roll back after a migration.');
    process.exitCode = 1;
  });
}
