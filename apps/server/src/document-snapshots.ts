import { and, eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as Y from 'yjs';
import { lockSession, type Principal } from './pages.js';
import { authorizeLockedPage } from './persistence.js';
import { hydrateStoredDocument } from './document-storage.js';
import { validateDocument } from './document.js';
import { documentUpdates, pages } from './schema.js';

export const SNAPSHOT_UPDATE_LIMIT = 100;
export const SNAPSHOT_TAIL_BYTE_LIMIT = 1024 * 1024;

export interface SnapshotHooks {
  beforeSnapshotCommit?: () => Promise<void>;
  afterSnapshotCommit?: () => Promise<void>;
  beforePruneCommit?: () => Promise<void>;
}

/** Hold the existing page queue through both transactions and any failures. */
export async function compactPage(pool: pg.Pool, pageId: string, principal: Principal, hooks: SnapshotHooks = {}) {
  const snapshotSequence = await persistSnapshot(pool, pageId, principal, hooks);
  // This boundary is already committed before the first covered update is removed.
  await hooks.afterSnapshotCommit?.();
  const prunedUpdates = await pruneCoveredUpdates(pool, pageId, principal, snapshotSequence, hooks);
  return { snapshotSequence, prunedUpdates };
}

async function persistSnapshot(pool: pg.Pool, pageId: string, principal: Principal, hooks: SnapshotHooks): Promise<number> {
  const client = await pool.connect();
  let discard = false;
  let committing = false;
  const doc = new Y.Doc({ gc: false });
  try {
    await client.query('BEGIN');
    const db = drizzle(client);
    await lockSession(db, principal);
    const page = await authorizeLockedPage(db, pageId, principal.accountId);
    if (!page.snapshotState || page.snapshotSequence < page.sequence) {
      await hydrateStoredDocument(db, page, doc);
      // Retain binary identities, deleted structs and history; projections never
      // replace the document. Existing document validation/size guards still apply.
      validateDocument(doc);
      await db.update(pages).set({ snapshotState: Buffer.from(Y.encodeStateAsUpdate(doc)), snapshotSequence: page.sequence })
        .where(eq(pages.id, pageId));
    }
    await hooks.beforeSnapshotCommit?.();
    committing = true;
    await client.query('COMMIT');
    return page.sequence;
  } catch (error) {
    if (committing) discard = true;
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { doc.destroy(); client.release(discard); }
}

async function pruneCoveredUpdates(pool: pg.Pool, pageId: string, principal: Principal, boundary: number, hooks: SnapshotHooks): Promise<number> {
  const client = await pool.connect();
  let discard = false;
  let committing = false;
  try {
    await client.query('BEGIN');
    const db = drizzle(client);
    await lockSession(db, principal);
    const page = await authorizeLockedPage(db, pageId, principal.accountId);
    if (!page.snapshotState || page.snapshotSequence < boundary) throw new Error('Snapshot not committed');
    const removed = await db.delete(documentUpdates)
      .where(and(eq(documentUpdates.pageId, pageId), lte(documentUpdates.sequence, boundary)));
    await hooks.beforePruneCommit?.();
    committing = true;
    await client.query('COMMIT');
    return removed.rowCount ?? 0;
  } catch (error) {
    if (committing) discard = true;
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
