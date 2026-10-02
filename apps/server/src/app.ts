import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import type { PoolClient } from 'pg';
import { DATABASE_SCHEMA_VERSION, DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, MAX_WIRE_BYTES, PROTOCOL_VERSION, pageSessionSchema } from '@kikit/contracts';
import { DEFAULT_DATABASE_URL, accountConfig, fixtureEnabled, isLoopback, requireLoopbackOrigin } from './config.js';
import { createPool } from './persistence.js';
import { createAuth, requestHeaders, type SendMagicLink } from './auth.js';
import { canAccessPage, createPage, listPages, type Principal } from './pages.js';
import { AccessError } from './persistence-errors.js';
import { SyncRooms } from './sync-room.js';
import { attachSyncConnection } from './sync-connection.js';
import { registerTestRoutes, TestFaults } from './test-faults.js';
import { registerSharingRoutes } from './sharing-routes.js';

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
  const owner = await authOwnership(pool, fixture);
  const auth = config ? createAuth(pool, config, options.sendMagicLink) : undefined;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024,
    trustProxy: !fixture && process.env.NODE_ENV === 'production' ? (_address, hop) => hop < 1 : false });
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
  let shuttingDown = false;
  let ownershipLost = false;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook('preClose', async () => {
    shuttingDown = true;
    clearInterval(expiryTimer);
    for (const socket of connections) socket.close(1001, 'Server shutdown');
    const closeTimer = setTimeout(() => { for (const socket of connections) socket.terminate(); }, 1000);
    closeTimer.unref();
    await rooms.queues.drain();
    clearTimeout(closeTimer);
    for (const socket of connections) socket.terminate();
  });
  app.addHook('onClose', async () => {
    rooms.destroy();
    if (owner) {
      if (!ownershipLost) await owner.query('SELECT pg_advisory_unlock(719422)').catch(() => undefined);
      owner.release(ownershipLost);
    }
    await pool.end();
  });
  owner?.on('error', () => {
    ownershipLost = true;
    shuttingDown = true;
    // Stop queue admission synchronously; never keep rooms alive after losing ownership.
    void rooms.queues.drain().catch(() => undefined);
    for (const socket of connections) socket.terminate();
    console.error('Database ownership connection lost; stopping Kikit.');
    void app.close().catch(() => { console.error('Kikit shutdown failed.'); });
  });
  try {
    await app.register(websocket, { options: { maxPayload: MAX_WIRE_BYTES } });

    app.addHook('onRequest', async (request, reply) => {
      if (shuttingDown) return reply.code(503).send({ error: 'Server unavailable' });
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

    async function identity(request: FastifyRequest) {
      if (fixture) return { accountId: DEV_ACCOUNT_ID, email: 'Local development', sessionId: undefined };
      const active = await auth!.api.getSession({ headers: authHeaders(request), query: { disableCookieCache: true, disableRefresh: true } });
      return active ? { accountId: active.user.id, email: active.user.email, sessionId: active.session.id } : null;
    }

    function authHeaders(request: FastifyRequest): Headers {
      const headers = requestHeaders(request.headers);
      headers.set('x-kikit-client-ip', request.ip);
      headers.delete('content-length');
      return headers;
    }

    app.get('/api/health', async (_request, reply) => {
      try {
        const result = await pool.query('SELECT version FROM schema_versions');
        if (result.rows.length !== 1 || result.rows[0].version !== DATABASE_SCHEMA_VERSION) throw new Error('Migrations pending');
        return { ready: true };
      } catch { return reply.code(503).send({ ready: false }); }
    });

    if (auth) {
      app.route({
        method: ['GET', 'POST'], url: '/api/auth/*',
        handler: async (request, reply) => {
          const response = await auth.handler(new Request(new URL(request.url, origin), {
            method: request.method, headers: authHeaders(request),
            ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
          }));
          // Revocation is ordered behind in-flight page writes and before this response.
          if (request.method === 'POST') await rooms.revalidate();
          reply.code(response.status);
          response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
          const cookies = response.headers.getSetCookie();
          if (cookies.length) reply.header('set-cookie', cookies);
          return reply.send(await response.text());
        },
      });
    } else {
      app.get('/api/dev/session', async (request, reply) => {
        if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin denied' });
        return { accountId: DEV_ACCOUNT_ID, pageId: DEV_PAGE_ID, protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION };
      });
    }

    app.get('/api/session', async (request, reply) => {
      const active = await identity(request);
      if (!active) return reply.code(401).send({ error: 'Sign in required' });
      return { accountId: active.accountId, email: active.email, fixture };
    });
    app.get('/api/pages', async (request, reply) => {
      const active = await identity(request);
      if (!active) return reply.code(401).send({ error: 'Sign in required' });
      reply.header('X-Kikit-Account', active.accountId);
      return listPages(pool, active.accountId);
    });
    app.post('/api/pages', { bodyLimit: 1024 }, async (request, reply) => {
      if (fixture) return reply.code(403).send({ error: 'Page creation requires an account' });
      const active = await identity(request);
      if (!active) return reply.code(401).send({ error: 'Sign in required' });
      const parsed = pageSessionSchema.shape.pageId.safeParse((request.body as { id?: unknown } | null)?.id);
      if (!parsed.success) return reply.code(400).send({ error: 'A valid page ID is required' });
      try {
        const page = await createPage(pool, parsed.data, active);
        reply.header('X-Kikit-Account', active.accountId);
        return page;
      }
      catch (error) {
        if (error instanceof AccessError) return reply.code(403).send({ error: 'Page access denied' });
        return reply.code(503).send({ error: 'Could not create the note. Try again.' });
      }
    });
    app.get<{ Params: { pageId: string } }>('/api/pages/:pageId/session', async (request, reply) => {
      const active = await identity(request);
      if (!active) return reply.code(401).send({ error: 'Sign in required' });
      if (!pageSessionSchema.shape.pageId.safeParse(request.params.pageId).success) return reply.code(400).send({ error: 'Invalid page ID' });
      if (!await canAccessPage(pool, request.params.pageId, active)) return reply.code(403).send({ error: 'Page access denied' });
      return { accountId: active.accountId, pageId: request.params.pageId, protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION };
    });

    registerSharingRoutes(app, pool, rooms, identity);
    registerTestRoutes(app, faults, () => ({ ...rooms.queues.metrics, rooms: rooms.size, connections: connections.size }));
    app.get('/api/sync', {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin denied' });
        if (shuttingDown || connections.size >= MAX_CONNECTIONS) return reply.code(503).send({ error: 'Server unavailable' });
        const active = await identity(request);
        if (!active) return reply.code(401).send({ error: 'Sign in required' });
        socketPrincipals.set(request, active);
      },
    }, (socket, request) => {
      connections.add(socket);
      attachSyncConnection(socket, rooms, () => connections.delete(socket), socketPrincipals.get(request)!);
    });

    let checking = false;
    expiryTimer = auth ? setInterval(() => {
      if (checking || shuttingDown) return;
      checking = true;
      void rooms.revalidate().finally(() => { checking = false; });
    }, 10_000) : undefined;
    expiryTimer?.unref();

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

async function authOwnership(pool: ReturnType<typeof createPool>, fixture: boolean) {
  if (fixture) return undefined;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock(719422) AS acquired');
    if (!row.acquired) throw new Error('Another Kikit account server is active. Stop and drain it before deployment.');
    return client;
  } catch (error) {
    client?.release();
    await pool.end();
    throw error;
  }
}
