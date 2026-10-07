import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { lockSession, type Principal } from './pages.js';
import { AccessError } from './persistence-errors.js';
import { documentUpdates, pageGrants, pageInvitations, pages, receipts } from './schema.js';

/** Caller holds the page queue through commit and live-access revalidation. */
export async function deletePage(pool: pg.Pool, pageId: string, principal: Principal): Promise<void> {
  if (!principal.sessionId) throw new AccessError('Sign in required');
  const client = await pool.connect();
  let discard = false;
  let committing = false;
  try {
    await client.query('BEGIN');
    const db = drizzle(client);
    await lockSession(db, principal);
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).for('update');
    if (!page || page.ownerId !== principal.accountId) throw new AccessError('Page access denied');
    if (!page.deletedAt) {
      const [grant] = await db.select({ role: pageGrants.role }).from(pageGrants).where(and(
        eq(pageGrants.pageId, pageId), eq(pageGrants.accountId, principal.accountId),
      )).for('update');
      if (grant?.role !== 'owner') throw new AccessError('Page access denied');
      await db.delete(receipts).where(eq(receipts.pageId, pageId));
      await db.delete(documentUpdates).where(eq(documentUpdates.pageId, pageId));
      await db.delete(pageInvitations).where(eq(pageInvitations.pageId, pageId));
      await db.delete(pageGrants).where(eq(pageGrants.pageId, pageId));
      // Reserve the page identity without retaining note text or binary content.
      // A delayed POST /pages retry must never initialize this page again.
      await db.update(pages).set({ title: '', initialState: Buffer.alloc(0), deletedAt: new Date() })
        .where(eq(pages.id, pageId));
    }
    committing = true;
    await client.query('COMMIT');
  } catch (error) {
    if (committing) discard = true;
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
