import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { DOCUMENT_SCHEMA_VERSION, type PageSummary } from '@kikit/contracts';
import { AccessError } from './persistence-errors.js';
import { createSeed } from './document.js';
import { pages, pageGrants, session } from './schema.js';

export interface Principal { accountId: string; sessionId?: string }

/** Held until COMMIT: session deletion cannot race an authorized document write. */
export async function lockSession(db: NodePgDatabase, principal: Principal): Promise<void> {
  if (!principal.sessionId) return; // Explicit local fixture only; production always supplies a session ID.
  const [active] = await db.select({ id: session.id }).from(session).where(and(
    eq(session.id, principal.sessionId), eq(session.userId, principal.accountId),
    sql`${session.expiresAt} > now()`,
  )).for('share');
  if (!active) throw new AccessError('Session expired or revoked');
}

export async function canAccessPage(pool: pg.Pool, pageId: string, principal: Principal): Promise<boolean> {
  const db = drizzle(pool);
  const query = db.select({ id: pages.id }).from(pages).innerJoin(pageGrants, and(
    eq(pageGrants.pageId, pages.id), eq(pageGrants.accountId, principal.accountId),
  ));
  const rows = principal.sessionId
    ? await query.innerJoin(session, and(eq(session.id, principal.sessionId), eq(session.userId, principal.accountId)))
      .where(and(eq(pages.id, pageId), sql`${session.expiresAt} > now()`))
    : await query.where(eq(pages.id, pageId));
  return rows.length > 0;
}

export async function listPages(pool: pg.Pool, accountId: string): Promise<PageSummary[]> {
  const rows = await drizzle(pool).select({ id: pages.id, title: pages.title, createdAt: pages.createdAt })
    .from(pages).innerJoin(pageGrants, and(eq(pageGrants.pageId, pages.id), eq(pageGrants.accountId, accountId)))
    .orderBy(asc(pages.createdAt));
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** Client page ID makes a retried create idempotent. Ownership is checked independently. */
export async function createPage(pool: pg.Pool, id: string, principal: Principal): Promise<PageSummary> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const db = drizzle(client);
    await lockSession(db, principal);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal.accountId]);
    const [existing] = await db.select().from(pages).where(eq(pages.id, id));
    if (existing && existing.ownerId !== principal.accountId) throw new AccessError('Page access denied');
    if (!existing) {
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(pages).where(eq(pages.ownerId, principal.accountId));
      if (total >= 100) throw new Error('The account has reached the 100-note limit.');
      await db.insert(pages).values({ id, ownerId: principal.accountId, schemaVersion: DOCUMENT_SCHEMA_VERSION, initialState: Buffer.from(createSeed('', '')) });
      await db.insert(pageGrants).values({ pageId: id, accountId: principal.accountId, role: 'owner' });
    }
    const [page] = await db.select({ id: pages.id, title: pages.title, createdAt: pages.createdAt }).from(pages).where(eq(pages.id, id));
    await client.query('COMMIT');
    return { ...page, createdAt: page.createdAt.toISOString() };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
