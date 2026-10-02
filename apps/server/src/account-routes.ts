import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, pageSessionSchema } from '@kikit/contracts';
import { canAccessPage, createPage, listPages } from './pages.js';
import { AccessError } from './persistence-errors.js';
import type { RequestIdentity, ResolveIdentity } from './auth-routes.js';

type PageSessionRequest = FastifyRequest<{ Params: { pageId: string } }>;

/** Account HTTP responses authorize independently of the WebSocket handshake. */
export function registerAccountRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  identity: ResolveIdentity,
  fixture: boolean,
): void {
  async function requireAccount(request: FastifyRequest, reply: FastifyReply): Promise<RequestIdentity | null> {
    const active = await identity(request);
    if (!active) reply.code(401).send({ error: 'Sign in required' });
    return active;
  }

  async function getSession(request: FastifyRequest, reply: FastifyReply) {
    const active = await requireAccount(request, reply);
    if (!active) return;
    return { accountId: active.accountId, email: active.email, fixture };
  }

  async function listNotes(request: FastifyRequest, reply: FastifyReply) {
    const active = await requireAccount(request, reply);
    if (!active) return;
    reply.header('X-Kikit-Account', active.accountId);
    return listPages(pool, active.accountId);
  }

  async function createNote(request: FastifyRequest, reply: FastifyReply) {
    if (fixture) return reply.code(403).send({ error: 'Page creation requires an account' });
    const active = await requireAccount(request, reply);
    if (!active) return;
    const parsed = pageSessionSchema.shape.pageId.safeParse((request.body as { id?: unknown } | null)?.id);
    if (!parsed.success) return reply.code(400).send({ error: 'A valid page ID is required' });
    try {
      const page = await createPage(pool, parsed.data, active);
      reply.header('X-Kikit-Account', active.accountId);
      return page;
    } catch (error) {
      if (error instanceof AccessError) return reply.code(403).send({ error: 'Page access denied' });
      return reply.code(503).send({ error: 'Could not create the note. Try again.' });
    }
  }

  async function getPageSession(request: PageSessionRequest, reply: FastifyReply) {
    const active = await requireAccount(request, reply);
    if (!active) return;
    if (!pageSessionSchema.shape.pageId.safeParse(request.params.pageId).success) {
      return reply.code(400).send({ error: 'Invalid page ID' });
    }
    if (!await canAccessPage(pool, request.params.pageId, active)) {
      return reply.code(403).send({ error: 'Page access denied' });
    }
    return {
      accountId: active.accountId,
      pageId: request.params.pageId,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
    };
  }

  app.get('/api/session', getSession);
  app.get('/api/pages', listNotes);
  app.post('/api/pages', { bodyLimit: 1024 }, createNote);
  app.get<{ Params: { pageId: string } }>('/api/pages/:pageId/session', getPageSession);
}
