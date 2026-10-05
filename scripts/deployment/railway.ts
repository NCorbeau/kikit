import { execFileSync } from 'node:child_process';
import type { DeployActions, DeployConfig, Deployment } from './types.js';

const deploymentsQuery = `query($input: DeploymentListInput!) {
  deployments(input: $input, first: 1000) {
    edges { node { id status deploymentStopped instances { status } } }
  }
}`;

export function requireRailwayCli(binary: string): void {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('Install Railway CLI (tested with 5.63.1) and run railway login first.');
  }
}

function runRailway(binary: string, cwd: string, args: string[]): string {
  try {
    return execFileSync(binary, args, {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Railway ${args[0]} failed. Check CLI login, service configuration and the Railway dashboard. Raw CLI output is withheld to protect secrets.`);
  }
}

async function checkHealth(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function createRailwayActions(
  config: DeployConfig,
  binary: string,
  snapshot: string,
  commit: string,
): DeployActions {
  const railway = (args: string[]) => runRailway(binary, snapshot, args);
  const target = (service: string) => [
    '--project', config.project,
    '--environment', config.environment,
    '--service', service,
  ];

  return {
    list: async service => {
      const result = JSON.parse(railway([
        'api', deploymentsQuery, '--variables', JSON.stringify({ input: {
          projectId: config.project, environmentId: config.environment, serviceId: service,
        } }), '--compact',
      ]));
      return result.data.deployments.edges.map((edge: { node: Deployment }) => edge.node);
    },
    stop: async service => {
      railway(['down', ...target(service), '--yes']);
    },
    upload: async service => {
      const result = JSON.parse(railway([
        'up', ...target(service), '--detach', '--json', '--message', `kikit ${commit}`,
      ]));
      if (typeof result.deploymentId !== 'string') {
        throw new Error('Railway did not return a deployment ID. Inspect the dashboard before retrying.');
      }
      return result.deploymentId;
    },
    migrationCompleted: async id => {
      const output = railway([
        'logs', id, ...target(config.migrationService), '--lines', '100', '--json',
      ]);
      return output.split('\n').filter(Boolean).some(line =>
        JSON.parse(line).message === 'Kikit deployment migrations completed.');
    },
    healthy: () => checkHealth(config.origin),
    sleep: () => new Promise(resolve => setTimeout(resolve, 5000)),
    now: Date.now,
    log: console.info,
  };
}
