import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION } from '@kikit/contracts';
import { requestHeaders, type KikitAuth } from './auth.js';
import type { Principal } from './pages.js';
import type { SyncRooms } from './sync-room.js';

export type RequestIdentity = Principal & { email: string };
export type ResolveIdentity = (request: FastifyRequest) => Promise<RequestIdentity | null>;

/** Translate the independently validated session into the page-access principal. */
export function createIdentityResolver(fixture: boolean, auth: KikitAuth | undefined): ResolveIdentity {
  return async request => {
    if (fixture) return { accountId: DEV_ACCOUNT_ID, email: 'Local development', sessionId: undefined };
    const active = await auth!.api.getSession({
      headers: authRequestHeaders(request),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    return active ? {
      accountId: active.user.id,
      name: active.user.name,
      email: active.user.email,
      sessionId: active.session.id,
    } : null;
  };
}

/** Forward Fastify's trusted client address, rather than a supplied IP header. */
function authRequestHeaders(request: FastifyRequest): Headers {
  const headers = requestHeaders(request.headers);
  headers.set('x-kikit-client-ip', request.ip);
  headers.delete('content-length');
  return headers;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: KikitAuth | undefined,
  origin: string,
  rooms: SyncRooms,
): void {
  if (!auth) {
    app.get('/api/dev/session', async (request, reply) => {
      if (request.headers.origin && request.headers.origin !== origin) {
        return reply.code(403).send({ error: 'Origin denied' });
      }
      return {
        accountId: DEV_ACCOUNT_ID,
        pageId: DEV_PAGE_ID,
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
      };
    });
    return;
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const response = await auth.handler(new Request(new URL(request.url, origin), {
        method: request.method,
        headers: authRequestHeaders(request),
        ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
      }));
      // Revocation is ordered behind in-flight page writes and before this response.
      if (request.method === 'POST') await rooms.revalidate();
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });
}
