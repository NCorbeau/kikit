import type { FastifyInstance } from 'fastify';
import { isLoopback } from './config.js';

export class TestFaults {
  dropNextAck = false;
  failNextCommit = false;
  postCommitError = false;

  beforeCommit = async (): Promise<void> => {
    if (!this.failNextCommit) return;
    this.failNextCommit = false;
    throw new Error('Injected pre-commit database failure');
  };

  afterCommit = (): void => {
    if (!this.postCommitError) return;
    this.postCommitError = false;
    throw new Error('Injected unknown commit outcome');
  };

  consumeDroppedAcknowledgement(): boolean {
    if (!this.dropNextAck) return false;
    this.dropNextAck = false;
    return true;
  }
}

type FaultRequest = Partial<Pick<TestFaults, 'dropNextAck' | 'failNextCommit' | 'postCommitError'>>;
const FAULT_NAMES = ['dropNextAck', 'failNextCommit', 'postCommitError'];

export function registerTestRoutes(
  app: FastifyInstance,
  faults: TestFaults,
  metrics: () => object,
): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KIKIT_TEST_FAULTS !== '1') return;
  app.post('/api/test/faults', async (request, reply) => {
    if (!isLoopback(request.ip)) return reply.code(403).send({ error: 'Loopback only' });
    const body = request.body as FaultRequest | undefined;
    const valid = body
      && Object.keys(body).every(key => FAULT_NAMES.includes(key))
      && Object.values(body).every(value => typeof value === 'boolean');
    if (!valid) return reply.code(400).send({ error: 'Invalid fault request' });
    faults.dropNextAck = body.dropNextAck ?? faults.dropNextAck;
    faults.failNextCommit = body.failNextCommit ?? faults.failNextCommit;
    faults.postCommitError = body.postCommitError ?? faults.postCommitError;
    return { ok: true };
  });
  app.get('/api/test/metrics', async (request, reply) => {
    if (!isLoopback(request.ip)) return reply.code(403).send({ error: 'Loopback only' });
    return metrics();
  });
}
