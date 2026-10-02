import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { joinInvitationSchema, pageSessionSchema } from '@kikit/contracts';
import type { Principal } from './pages.js';
import { AccessError } from './persistence-errors.js';
import type { SyncRooms } from './sync-room.js';
import {
  InvitationError, disableInvitation, findInvitationPage, getSharing,
  joinInvitation, removeMember, replaceInvitation,
} from './sharing.js';

type PageRequest = FastifyRequest<{ Params: { pageId: string; accountId?: string } }>;
type MemberRequest = FastifyRequest<{ Params: { pageId: string; accountId: string } }>;
type SharingAction = (active: Principal) => Promise<unknown>;

/** Account identity, invitation redemption and page permissions remain separate. */
export function registerSharingRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  rooms: SyncRooms,
  identity: (request: FastifyRequest) => Promise<Principal | null>,
) {
  async function requireSharingPrincipal(request: FastifyRequest, reply: FastifyReply) {
    const active = await identity(request);
    if (!active?.sessionId) {
      reply.code(401).send({ error: 'Sign in required' });
      return null;
    }
    // Bind the explicit browser action to the account shown to the user. A
    // cookie switch must not join a different account before response checks.
    const expected = request.headers['x-kikit-account'];
    if (expected !== undefined && expected !== active.accountId) {
      reply.code(401).send({ error: 'Your account changed. Reopen your notes.' });
      return null;
    }
    return active;
  }
  function sendSharingFailure(reply: FastifyReply, error: unknown) {
    if (error instanceof InvitationError) return reply.code(410).send({ error: 'This invitation is invalid or no longer available.' });
    if (error instanceof AccessError) return reply.code(403).send({ error: 'Page access denied' });
    return reply.code(503).send({ error: 'Could not update sharing. Try again.' });
  }
  async function authorizedPageAction(request: PageRequest, reply: FastifyReply, action: SharingAction) {
    const active = await requireSharingPrincipal(request, reply);
    if (!active) return;
    if (!pageSessionSchema.shape.pageId.safeParse(request.params.pageId).success) {
      return reply.code(400).send({ error: 'Invalid page ID' });
    }
    try {
      const result = await action(active);
      reply.header('X-Kikit-Account', active.accountId);
      return result;
    } catch (error) {
      return sendSharingFailure(reply, error);
    }
  }

  /** Validate the HTTP principal before ordering the mutation with page writes. */
  function queuedPageMutation(request: PageRequest, reply: FastifyReply, mutation: SharingAction) {
    return authorizedPageAction(request, reply, active =>
      rooms.accessMutation(request.params.pageId, () => mutation(active)));
  }

  function getPageSharing(request: PageRequest, reply: FastifyReply) {
    return authorizedPageAction(request, reply, active => getSharing(pool, request.params.pageId, active));
  }

  function replacePageInvitation(request: PageRequest, reply: FastifyReply) {
    return queuedPageMutation(request, reply, active => replaceInvitation(pool, request.params.pageId, active));
  }

  function disablePageInvitation(request: PageRequest, reply: FastifyReply) {
    return queuedPageMutation(request, reply, async active => {
      await disableInvitation(pool, request.params.pageId, active);
      return { success: true };
    });
  }

  function removePageEditor(request: MemberRequest, reply: FastifyReply) {
    if (!request.params.accountId || request.params.accountId.length > 200) {
      return reply.code(400).send({ error: 'Invalid member' });
    }
    return queuedPageMutation(request, reply, async active => {
      await removeMember(pool, request.params.pageId, request.params.accountId, active);
      return { success: true };
    });
  }

  async function redeemInvitation(request: FastifyRequest, reply: FastifyReply) {
    const active = await requireSharingPrincipal(request, reply);
    if (!active) return;
    const parsed = joinInvitationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid invitation' });
    try {
      const pageId = await findInvitationPage(pool, parsed.data.token);
      if (!pageId) throw new InvitationError();
      const page = await rooms.accessMutation(pageId, () => joinInvitation(pool, pageId, parsed.data.token, active));
      reply.header('X-Kikit-Account', active.accountId);
      return page;
    } catch (error) {
      return sendSharingFailure(reply, error);
    }
  }

  app.get<{ Params: { pageId: string } }>('/api/pages/:pageId/sharing', getPageSharing);
  app.post<{ Params: { pageId: string } }>('/api/pages/:pageId/invitation', { bodyLimit: 1024 }, replacePageInvitation);
  app.delete<{ Params: { pageId: string } }>('/api/pages/:pageId/invitation', disablePageInvitation);
  app.delete<{ Params: { pageId: string; accountId: string } }>('/api/pages/:pageId/members/:accountId', removePageEditor);
  app.post('/api/invitations/join', { bodyLimit: 1024 }, redeemInvitation);
}
