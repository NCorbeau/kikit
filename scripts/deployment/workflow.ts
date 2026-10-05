import type { DeployActions, DeployConfig } from './types.js';

const idleStatuses = new Set(['REMOVED', 'COMPLETED', 'FAILED', 'CRASHED', 'SKIPPED']);
const failureStatuses = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);
const waitTimeoutMs = 15 * 60_000;

async function waitUntil(
  actions: DeployActions,
  message: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = actions.now() + waitTimeoutMs;
  while (!await check()) {
    if (actions.now() >= deadline) {
      throw new Error(`Timed out: ${message}. Check Railway before retrying.`);
    }
    await actions.sleep();
  }
}

async function preflight(config: DeployConfig, actions: DeployActions): Promise<boolean> {
  const [app, migration] = await Promise.all([
    actions.list(config.appService),
    actions.list(config.migrationService),
  ]);
  if (migration.some(row => !idleStatuses.has(row.status))) {
    throw new Error('Migration service is already active; inspect Railway first.');
  }
  const active = app.filter(row => !idleStatuses.has(row.status));
  if (active.length > 1 || active.some(row => row.status !== 'SUCCESS')) {
    throw new Error('App has an unfinished or overlapping deployment; inspect Railway first.');
  }
  return active.length > 0;
}

async function stopApp(service: string, actions: DeployActions): Promise<void> {
  actions.log('Stopping the app and waiting for removal…');
  await actions.stop(service);
  await waitUntil(actions, 'old app removal', async () => {
    const rows = await actions.list(service);
    // Railway may omit removed deployments. The job's database ownership
    // lock is the final proof that the old server can no longer mutate data.
    return rows.every(row => idleStatuses.has(row.status));
  });
}

async function deployService(
  service: string,
  expectedStatus: 'COMPLETED' | 'SUCCESS',
  actions: DeployActions,
): Promise<string> {
  const id = await actions.upload(service);
  await waitUntil(actions, `${service} deployment ${id}`, async () => {
    const row = (await actions.list(service)).find(row => row.id === id);
    if (row && failureStatuses.has(row.status)) {
      throw new Error(`Deployment ${id} ${row.status}; inspect its Railway logs.`);
    }
    if (row?.status === 'COMPLETED' && expectedStatus !== 'COMPLETED') {
      throw new Error(`App deployment ${id} exited unexpectedly.`);
    }
    return row?.status === expectedStatus;
  });
  return id;
}

async function verifyHealth(service: string, id: string, actions: DeployActions): Promise<void> {
  await waitUntil(actions, 'public healthcheck', async () => {
    const row = (await actions.list(service)).find(row => row.id === id);
    if (!row || row.status !== 'SUCCESS') {
      throw new Error(`App deployment ${id} is no longer healthy in Railway.`);
    }
    return actions.healthy();
  });
}

/** Advance only after the exact migration job exits and the matching app is healthy. */
export async function deploy(config: DeployConfig, actions: DeployActions): Promise<void> {
  const appIsRunning = await preflight(config, actions);
  if (appIsRunning) await stopApp(config.appService, actions);

  actions.log('Building the committed snapshot and applying migrations…');
  await deployService(config.migrationService, 'COMPLETED', actions);

  actions.log('Migrations completed. Deploying the matching app…');
  const appId = await deployService(config.appService, 'SUCCESS', actions);
  await verifyHealth(config.appService, appId, actions);

  actions.log(`Deployed successfully: ${config.origin} (${appId})`);
}
