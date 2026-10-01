import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import {
  DEV_ACCOUNT_ID,
  DEV_PAGE_ID,
  DOCUMENT_SCHEMA_VERSION,
  MAX_WIRE_BYTES,
  PROTOCOL_VERSION,
} from '@kikit/contracts';
import {
  DEFAULT_DATABASE_URL,
  isLoopback,
  requireDevelopmentFixture,
  requireLoopbackOrigin,
} from './config.js';
import { createPool } from './persistence.js';
import { SyncRooms } from './sync-room.js';
import { attachSyncConnection } from './sync-connection.js';
import { registerTestRoutes, TestFaults } from './test-faults.js';

interface ServerOptions {
  databaseUrl?: string;
  origin?: string;
}
const MAX_CONNECTIONS = 128;

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  requireDevelopmentFixture();
  const origin = options.origin ?? process.env.KIKIT_ORIGIN ?? 'http://127.0.0.1:5173';
  requireLoopbackOrigin(origin);
  const pool = createPool(options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const faults = new TestFaults();
  const rooms = new SyncRooms(pool, faults);
  const connections = new Set<WebSocket>();
  let shuttingDown = false;
  await app.register(websocket, { options: { maxPayload: MAX_WIRE_BYTES } });

  app.get('/api/dev/session', async (request, reply) => {
    const foreignOrigin = request.headers.origin && request.headers.origin !== origin;
    if (!isLoopback(request.ip) || foreignOrigin) {
      return reply.code(403).send({ error: 'Development fixture is restricted to the local browser' });
    }
    // This fixture is not authentication. Page authorization still runs for every
    // handshake and every committed batch independently of this identity endpoint.
    return {
      accountId: DEV_ACCOUNT_ID,
      pageId: DEV_PAGE_ID,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
    };
  });

  registerTestRoutes(app, faults, () => ({
    ...rooms.queues.metrics,
    rooms: rooms.size,
    connections: connections.size,
  }));
  app.get('/api/sync', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!isLoopback(request.ip) || request.headers.origin !== origin) {
        return reply.code(403).send({ error: 'Origin denied' });
      }
      if (shuttingDown || connections.size >= MAX_CONNECTIONS) {
        return reply.code(503).send({ error: 'Server unavailable' });
      }
    },
  }, socket => {
    connections.add(socket);
    attachSyncConnection(socket, rooms, () => connections.delete(socket));
  });

  app.addHook('preClose', async () => {
    shuttingDown = true;
    for (const socket of connections) socket.close(1001, 'Server shutdown');
    // Socket handshakes are bounded separately. Database work keeps its queue slot.
    const closeTimer = setTimeout(() => {
      for (const socket of connections) socket.terminate();
    }, 1000);
    closeTimer.unref();
    await rooms.queues.drain();
    clearTimeout(closeTimer);
    for (const socket of connections) socket.terminate();
  });
  app.addHook('onClose', async () => {
    rooms.destroy();
    await pool.end();
  });
  return app;
}
