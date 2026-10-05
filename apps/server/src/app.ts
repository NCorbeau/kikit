import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { DATABASE_SCHEMA_VERSION, MAX_WIRE_BYTES } from '@kikit/contracts';
import { DEFAULT_DATABASE_URL, accountConfig, fixtureEnabled, isLoopback, requireLoopbackOrigin } from './config.js';
import { createPool } from './persistence.js';
import { createAuth, type SendMagicLink } from './auth.js';
import { createIdentityResolver, registerAuthRoutes } from './auth-routes.js';
import { registerAccountRoutes } from './account-routes.js';
import type { Principal } from './pages.js';
import { SyncRooms } from './sync-room.js';
import { attachSyncConnection } from './sync-connection.js';
import { registerTestRoutes, TestFaults } from './test-faults.js';
import { registerSharingRoutes } from './sharing-routes.js';
import { acquireServerOwnership, registerServerLifecycle } from './server-lifecycle.js';

interface ServerOptions {
  databaseUrl?: string;
  origin?: string;
  serveWeb?: boolean;
  sendMagicLink?: SendMagicLink;
}
const MAX_CONNECTIONS = 128;

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const fixture = fixtureEnabled();
  const config = fixture ? undefined : accountConfig(options.origin);
  const origin = config?.origin ?? options.origin ?? process.env.KIKIT_ORIGIN ?? 'http://127.0.0.1:5173';
  if (fixture) requireLoopbackOrigin(origin);
  if (options.sendMagicLink && process.env.NODE_ENV !== 'test') throw new Error('Test email delivery is restricted to NODE_ENV=test.');
  const pool = createPool(options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  // A second account server must never own independent live rooms for this database.
  const ownershipConnection = await acquireServerOwnership(pool, fixture);
  const auth = config ? createAuth(pool, config, options.sendMagicLink) : undefined;
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: !fixture && process.env.NODE_ENV === 'production' ? (_address, hop) => hop < 1 : false,
  });
  // ORM/driver errors can contain query parameters, including session tokens.
  app.setErrorHandler((error, _request, reply) => {
    const code = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 503;
    return reply.code(status).send({ error: status < 500 ? 'Request rejected' : 'Request could not be completed. Try again.' });
  });
  const faults = new TestFaults();
  const rooms = new SyncRooms(pool, faults);
  const connections = new Set<WebSocket>();
  const socketPrincipals = new WeakMap<FastifyRequest, Principal>();
  const lifecycle = registerServerLifecycle(app, pool, rooms, connections, ownershipConnection);
  try {
    await app.register(websocket, { options: { maxPayload: MAX_WIRE_BYTES } });

    app.addHook('onRequest', async (request, reply) => {
      if (lifecycle.shuttingDown) return reply.code(503).send({ error: 'Server unavailable' });
      if (request.url.startsWith('/api/')) {
        reply.header('Cache-Control', 'no-store');
        if (fixture && !isLoopback(request.ip)) return reply.code(403).send({ error: 'Development fixture is restricted to the local browser' });
        if (!fixture && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) {
          return reply.code(403).send({ error: 'Origin denied' });
        }
      }
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
    });

    const identity = createIdentityResolver(fixture, auth);

    app.get('/api/health', async (_request, reply) => {
      try {
        const result = await pool.query('SELECT version FROM schema_versions');
        if (result.rows.length !== 1 || result.rows[0].version !== DATABASE_SCHEMA_VERSION) throw new Error('Migrations pending');
        return { ready: true };
      } catch { return reply.code(503).send({ ready: false }); }
    });

    registerAuthRoutes(app, auth, origin, rooms);
    registerAccountRoutes(app, pool, identity, fixture);
    registerSharingRoutes(app, pool, rooms, identity);
    registerTestRoutes(app, faults, () => ({ ...rooms.queues.metrics, rooms: rooms.size, connections: connections.size }));
    app.get('/api/sync', {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin denied' });
        if (lifecycle.shuttingDown || connections.size >= MAX_CONNECTIONS) return reply.code(503).send({ error: 'Server unavailable' });
        const active = await identity(request);
        if (!active) return reply.code(401).send({ error: 'Sign in required' });
        socketPrincipals.set(request, active);
      },
    }, (socket, request) => {
      connections.add(socket);
      attachSyncConnection(socket, rooms, () => connections.delete(socket), socketPrincipals.get(request)!);
    });

    if (auth) lifecycle.startExpiryChecks();

    if (options.serveWeb) {
      await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web/dist/', import.meta.url)), cacheControl: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/') || !request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: 'Not found' });
        return reply.sendFile('index.html');
      });
    }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
