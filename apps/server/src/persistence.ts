import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { AccessError, CompatibilityError, ReceiptConflict } from './persistence-errors.js';
import { documentUpdates, pageGrants, pages, receipts } from './schema.js';
import { lockSession } from './pages.js';

export { AccessError, CompatibilityError, ReceiptConflict } from './persistence-errors.js';
export { migrateDatabase } from './migrations.js';

export interface CommitResult {
  sequence: number;
  duplicate: boolean;
  committedUpdate?: Uint8Array;
}
export interface CommitHooks {
  beforeCommit?: () => Promise<void>;
  validate?: () => Uint8Array | void;
  afterCommit?: () => void;
  projectTitle?: () => string;
  sessionId?: string;
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    lock_timeout: 2000,
    idle_in_transaction_session_timeout: 10_000,
    options: '-c transaction_timeout=15000',
  });
  // pg evicts the failed idle client. Handle its event so later work can reconnect.
  pool.on('error', () => {
    console.warn('PostgreSQL idle connection failed; the pool will reconnect on demand.');
  });
  return pool;
}

async function authorizeLockedPage(
  db: NodePgDatabase,
  pageId: string,
  accountId: string,
) {
  const [page] = await db.select({
    sequence: pages.sequence,
    initialState: pages.initialState,
    schemaVersion: pages.schemaVersion,
  }).from(pages)
    .innerJoin(pageGrants, and(
      eq(pageGrants.pageId, pages.id),
      eq(pageGrants.accountId, accountId),
    ))
    .where(and(eq(pages.id, pageId), inArray(pageGrants.role, ['owner', 'editor'])))
    .for('update', { of: [pages, pageGrants] });
  if (!page) throw new AccessError('Page access denied');
  if (page.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new CompatibilityError('Unsupported document schema');
  }
  return page;
}

export async function loadPage(
  pool: pg.Pool,
  pageId: string,
  accountId: string,
  sessionId?: string,
): Promise<{ doc: Y.Doc; sequence: number }> {
  const client = await pool.connect();
  const db = drizzle(client);
  const doc = new Y.Doc();
  let discardConnection = false;
  try {
    await client.query('BEGIN');
    await lockSession(db, { accountId, sessionId });
    const page = await authorizeLockedPage(db, pageId, accountId);
    Y.applyUpdate(doc, page.initialState);
    const updates = await db.select({ payload: documentUpdates.payload })
      .from(documentUpdates)
      .where(and(eq(documentUpdates.pageId, pageId), lte(documentUpdates.sequence, page.sequence)))
      .orderBy(asc(documentUpdates.sequence));
    for (const row of updates) Y.applyUpdate(doc, row.payload);
    await client.query('COMMIT');
    return { doc, sequence: page.sequence };
  } catch (error) {
    doc.destroy();
    try {
      await client.query('ROLLBACK');
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}

export async function commitUpdate(
  pool: pg.Pool,
  pageId: string,
  accountId: string,
  batchId: string,
  update: Uint8Array,
  hooks: CommitHooks = {},
): Promise<CommitResult> {
  const client = await pool.connect();
  const db = drizzle(client);
  let discardConnection = false;
  const payloadHash = createHash('sha256').update(update).digest('hex');
  try {
    await client.query('BEGIN');
    await lockSession(db, { accountId, sessionId: hooks.sessionId });
    const page = await authorizeLockedPage(db, pageId, accountId);
    const [receipt] = await db.select({
      payloadHash: receipts.payloadHash,
      sequence: receipts.sequence,
      payload: documentUpdates.payload,
    }).from(receipts)
      .innerJoin(documentUpdates, and(
        eq(documentUpdates.pageId, receipts.pageId),
        eq(documentUpdates.sequence, receipts.sequence),
      ))
      .where(and(eq(receipts.pageId, pageId), eq(receipts.batchId, batchId)));
    // Receipt lookup precedes validation: retries recover the original commit and repair.
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) {
        throw new ReceiptConflict('Batch identity already belongs to different bytes');
      }
      await client.query('COMMIT');
      const repairedPayload = receipt.payload.equals(update) ? {} : { committedUpdate: receipt.payload };
      return { sequence: receipt.sequence, duplicate: true, ...repairedPayload };
    }

    // Hash immutable client bytes; validation may add a repair to the stored payload.
    const committedUpdate = hooks.validate?.() ?? update;
    const sequence = page.sequence + 1;
    await db.insert(documentUpdates).values({ pageId, sequence, payload: Buffer.from(committedUpdate) });
    await db.insert(receipts).values({ pageId, batchId, payloadHash, sequence });
    await db.update(pages).set({ sequence, ...(hooks.projectTitle ? { title: hooks.projectTitle() } : {}) }).where(eq(pages.id, pageId));
    await hooks.beforeCommit?.();
    // No client timeout races this transaction. Unknown results stay unacknowledged.
    await client.query('COMMIT');
    hooks.afterCommit?.();
    const repairedPayload = committedUpdate === update ? {} : { committedUpdate };
    return { sequence, duplicate: false, ...repairedPayload };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}
