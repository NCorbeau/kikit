import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, encodeUpdate, pageSessionSchema, parseRecoveryFile } from '@kikit/contracts';
import type { ResolveIdentity } from './auth-routes.js';
import { createPage } from './pages.js';
import { AccessError } from './persistence-errors.js';
import { loadPage } from './persistence.js';
import { normalizeEmptyBody, projectTitle } from './document.js';

/** A recovery copy is server initialization of a new private page, never a REST save. */
export function registerRecoveryRoute(app: FastifyInstance, pool: pg.Pool, identity: ResolveIdentity) {
  // A fresh, locked committed read lets recovery detect acknowledged history
  // missing after a restore, even when that history remains in the client cache.
  app.get<{ Params: { pageId: string } }>('/api/pages/:pageId/recovery-state', async (request, reply) => {
    const active = await identity(request);
    if (!active?.sessionId) return reply.code(401).send({ error: 'Sign in required' });
    if (request.headers['x-kikit-account'] !== active.accountId) {
      return reply.code(401).send({ error: 'Your account changed. Reopen your notes.' });
    }
    if (!pageSessionSchema.shape.pageId.safeParse(request.params.pageId).success) {
      return reply.code(400).send({ error: 'Invalid page ID' });
    }
    try {
      const loaded = await loadPage(pool, request.params.pageId, active.accountId, active.sessionId);
      try {
        reply.header('X-Kikit-Account', active.accountId);
        return { accountId: active.accountId, pageId: request.params.pageId, protocolVersion: PROTOCOL_VERSION,
          schemaVersion: DOCUMENT_SCHEMA_VERSION, update: encodeUpdate(Y.encodeStateAsUpdate(loaded.doc)) };
      } finally { loaded.doc.destroy(); }
    } catch (error) {
      if (error instanceof AccessError) return reply.code(403).send({ error: 'Page access denied' });
      return reply.code(503).send({ error: 'Could not read committed recovery state. Keep the file and try again.' });
    }
  });
  app.post('/api/recovery/copies', { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => {
    const active = await identity(request);
    if (!active?.sessionId) return reply.code(401).send({ error: 'Sign in required' });
    if (request.headers['x-kikit-account'] !== active.accountId) {
      return reply.code(401).send({ error: 'Your account changed. Reopen your notes.' });
    }
    const body = request.body as { id?: unknown; recovery?: unknown } | null;
    const id = pageSessionSchema.shape.pageId.safeParse(body?.id);
    if (!id.success || typeof body?.recovery !== 'string') {
      return reply.code(400).send({ error: 'A note ID and recovery file are required.' });
    }
    const doc = new Y.Doc({ gc: false });
    let initialization;
    try {
      const recovery = parseRecoveryFile(body.recovery, { accountId: active.accountId });
      if (id.data === recovery.pageId) throw new Error('A recovery copy needs a new note ID.');
      Y.applyUpdate(doc, recovery.update);
      normalizeEmptyBody(doc);
      // Bind response-loss retries to the original binary input, before random repair IDs.
      const inputHash = createHash('sha256')
        .update(JSON.stringify([recovery.accountId, recovery.pageId, recovery.schemaVersion, recovery.protocolVersion]))
        .update(recovery.update).digest('hex');
      initialization = { state: Y.encodeStateAsUpdate(doc), title: projectTitle(doc), inputHash };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid recovery file.' });
    } finally { doc.destroy(); }
    try {
      const page = await createPage(pool, id.data, active, initialization);
      reply.header('X-Kikit-Account', active.accountId);
      return page;
    } catch (error) {
      if (error instanceof AccessError) return reply.code(403).send({ error: 'Note creation denied. Keep the recovery file.' });
      return reply.code(503).send({ error: 'Could not recover the note. Keep the file and try again.' });
    }
  });
}
