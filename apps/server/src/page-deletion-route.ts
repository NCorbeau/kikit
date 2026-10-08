import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pageSessionSchema } from '@kikit/contracts';
import type { ResolveIdentity } from './auth-routes.js';
import type { SyncRooms } from './sync-room.js';
import { AccessError } from './persistence-errors.js';
import { deletePage } from './page-deletion.js';

export function registerPageDeletionRoute(app: FastifyInstance, pool: pg.Pool, rooms: SyncRooms, identity: ResolveIdentity) {
  app.delete<{ Params: { pageId: string } }>('/api/pages/:pageId', async (request, reply) => {
    const active = await identity(request);
    if (!active?.sessionId) return reply.code(401).send({ error: 'Sign in required' });
    if (request.headers['x-kikit-account'] !== active.accountId) {
      return reply.code(401).send({ error: 'Your account changed. Reopen your notes.' });
    }
    if (!pageSessionSchema.shape.pageId.safeParse(request.params.pageId).success) {
      return reply.code(400).send({ error: 'Invalid page ID' });
    }
    try {
      await rooms.accessMutation(request.params.pageId, () => deletePage(pool, request.params.pageId, active));
      reply.header('X-Kikit-Account', active.accountId);
      return { success: true };
    } catch (error) {
      if (error instanceof AccessError) return reply.code(403).send({ error: 'Page access denied' });
      return reply.code(503).send({ error: 'Could not delete the note. Try again.' });
    }
  });
}
