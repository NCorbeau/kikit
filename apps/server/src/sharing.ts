import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { PageSummary, SharingState } from '@kikit/contracts';
import { AccessError } from './persistence-errors.js';
import { lockPage, lockSession, type Principal } from './pages.js';
import { pageGrants, pageInvitations, pages, user } from './schema.js';

export class InvitationError extends AccessError {
  constructor() { super('This invitation is unavailable.'); }
}

type LockedPage = typeof pages.$inferSelect;
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function tokenHash(token: string): string {
  if (token.length !== 43 || !invitationTokenPattern.test(token)) throw new InvitationError();
  return createHash('sha256').update(token).digest('hex');
}

/** Locate a queue only: redemption rechecks the invitation under its page lock. */
export async function findInvitationPage(pool: pg.Pool, token: string): Promise<string | null> {
  if (token.length !== 43 || !invitationTokenPattern.test(token)) return null;
  const [invitation] = await drizzle(pool).select({ pageId: pageInvitations.pageId }).from(pageInvitations)
    .where(and(eq(pageInvitations.tokenHash, tokenHash(token)), eq(pageInvitations.disabled, false)));
  return invitation?.pageId ?? null;
}

/** The caller orders this transaction with joins/writes in the shared page queue. */
async function withLockedPage<T>(
  pool: pg.Pool,
  pageId: string,
  principal: Principal,
  task: (db: NodePgDatabase, page: LockedPage) => Promise<T>,
): Promise<T> {
  if (!principal.sessionId) throw new AccessError('Sign in required');
  const client = await pool.connect();
  let discard = false;
  let committing = false;
  try {
    await client.query('BEGIN');
    const db = drizzle(client);
    await lockSession(db, principal);
    const page = await lockPage(db, pageId);
    const result = await task(db, page);
    committing = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A failed COMMIT response may conceal success. The queue wrapper must
    // invalidate/revalidate live access before allowing subsequent propagation.
    if (committing) discard = true;
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

async function requireOwner(db: NodePgDatabase, page: LockedPage, principal: Principal): Promise<void> {
  if (page.ownerId !== principal.accountId) throw new AccessError('Page access denied');
  const [grant] = await db.select({ role: pageGrants.role }).from(pageGrants).where(and(
    eq(pageGrants.pageId, page.id), eq(pageGrants.accountId, principal.accountId),
  )).for('update');
  if (grant?.role !== 'owner') throw new AccessError('Page access denied');
}

export async function joinInvitation(
  pool: pg.Pool, pageId: string, token: string, principal: Principal,
): Promise<PageSummary> {
  const hash = tokenHash(token);
  return withLockedPage(pool, pageId, principal, async (db, page) => {
    const [existingGrant] = await db.select({ role: pageGrants.role }).from(pageGrants).where(and(
      eq(pageGrants.pageId, pageId), eq(pageGrants.accountId, principal.accountId),
    )).for('update');
    if ((page.ownerId === principal.accountId && existingGrant?.role !== 'owner')
      || (page.ownerId !== principal.accountId && existingGrant?.role === 'owner')) {
      throw new AccessError('Page access denied');
    }
    const [invitation] = await db.select({ tokenHash: pageInvitations.tokenHash, disabled: pageInvitations.disabled })
      .from(pageInvitations).where(eq(pageInvitations.pageId, pageId)).for('update');
    if (!invitation || invitation.disabled || invitation.tokenHash !== hash) throw new InvitationError();
    // The page lock also serializes concurrent joins when this grant is absent.
    // DO NOTHING preserves an existing owner/editor role and makes retries safe.
    await db.insert(pageGrants).values({ pageId, accountId: principal.accountId, role: 'editor' })
      .onConflictDoNothing({ target: [pageGrants.pageId, pageGrants.accountId] });
    const [grant] = await db.select({ role: pageGrants.role }).from(pageGrants).where(and(
      eq(pageGrants.pageId, pageId), eq(pageGrants.accountId, principal.accountId),
    )).for('update');
    return { id: page.id, title: page.title, createdAt: page.createdAt.toISOString(), role: grant.role };
  });
}

export async function getSharing(pool: pg.Pool, pageId: string, principal: Principal): Promise<SharingState> {
  return withLockedPage(pool, pageId, principal, async (db, page) => {
    await requireOwner(db, page, principal);
    const [invitation] = await db.select({ disabled: pageInvitations.disabled }).from(pageInvitations)
      .where(eq(pageInvitations.pageId, pageId));
    const members = await db.select({
      accountId: pageGrants.accountId, name: user.name, email: user.email, role: pageGrants.role,
    }).from(pageGrants).innerJoin(user, eq(user.id, pageGrants.accountId))
      .where(eq(pageGrants.pageId, pageId)).orderBy(asc(user.name), asc(pageGrants.accountId));
    return { invitationActive: !!invitation && !invitation.disabled, members };
  });
}

export async function replaceInvitation(pool: pg.Pool, pageId: string, principal: Principal): Promise<{ token: string }> {
  const token = randomBytes(32).toString('base64url');
  return withLockedPage(pool, pageId, principal, async (db, page) => {
    await requireOwner(db, page, principal);
    await db.insert(pageInvitations).values({ pageId, tokenHash: tokenHash(token) }).onConflictDoUpdate({
      target: pageInvitations.pageId,
      set: { tokenHash: tokenHash(token), disabled: false, createdAt: new Date() },
    });
    return { token };
  });
}

export async function disableInvitation(pool: pg.Pool, pageId: string, principal: Principal): Promise<void> {
  await withLockedPage(pool, pageId, principal, async (db, page) => {
    await requireOwner(db, page, principal);
    await db.update(pageInvitations).set({ disabled: true }).where(eq(pageInvitations.pageId, pageId));
  });
}

export async function removeMember(
  pool: pg.Pool, pageId: string, accountId: string, principal: Principal,
): Promise<void> {
  await withLockedPage(pool, pageId, principal, async (db, page) => {
    await requireOwner(db, page, principal);
    if (page.ownerId === accountId) throw new AccessError('The owner cannot be removed');
    const [grant] = await db.select({ role: pageGrants.role }).from(pageGrants).where(and(
      eq(pageGrants.pageId, pageId), eq(pageGrants.accountId, accountId),
    )).for('update');
    if (!grant) return; // A retried removal has the same durable outcome.
    if (grant.role !== 'editor') throw new AccessError('The owner cannot be removed');
    await db.delete(pageGrants).where(and(
      eq(pageGrants.pageId, pageId), eq(pageGrants.accountId, accountId), eq(pageGrants.role, 'editor'),
    ));
  });
}
