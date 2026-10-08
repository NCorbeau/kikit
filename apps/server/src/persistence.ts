import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { AccessError, CompatibilityError, ReceiptConflict } from './persistence-errors.js';
import { documentUpdates, pageGrants, pages, receipts } from './schema.js';
import { lockSession } from './pages.js';
import { hydrateStoredDocument } from './document-storage.js';

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

interface StoredReceipt {
  payloadHash: string;
  sequence: number;
  repairPayload: Buffer | null;
}
interface NewBatch {
  pageId: string;
  batchId: string;
  payloadHash: string;
  sequence: number;
  update: Uint8Array;
  repairPayload: Buffer | null;
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

export async function authorizeLockedPage(
  db: NodePgDatabase,
  pageId: string,
  accountId: string,
) {
  // Lock the page before its grant. All callers run after migrations.
  const [page] = await db.select().from(pages).where(and(eq(pages.id, pageId), isNull(pages.deletedAt))).for('update');
  if (!page) throw new AccessError('Page access denied');
  const [grant] = await db.select().from(pageGrants).where(and(
    eq(pageGrants.pageId, pageId), eq(pageGrants.accountId, accountId),
    inArray(pageGrants.role, ['owner', 'editor']),
  )).for('update');
  if (!grant) throw new AccessError('Page access denied');
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
): Promise<{ doc: Y.Doc; sequence: number; snapshotSequence: number; tailBytes: number }> {
  const client = await pool.connect();
  const db = drizzle(client);
  const doc = new Y.Doc();
  let discardConnection = false;
  try {
    await client.query('BEGIN');
    await lockSession(db, { accountId, sessionId });
    const page = await authorizeLockedPage(db, pageId, accountId);
    const tailBytes = await hydrateStoredDocument(db, page, doc);
    await client.query('COMMIT');
    return { doc, sequence: page.sequence, snapshotSequence: page.snapshotSequence, tailBytes };
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
    const receipt = await findCommittedReceipt(db, pageId, batchId);
    // Receipt lookup precedes validation: retries recover the original commit and repair.
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) {
        throw new ReceiptConflict('Batch identity already belongs to different bytes');
      }
      await client.query('COMMIT');
      return duplicateCommitResult(receipt, update);
    }

    // Hash immutable client bytes; validation may add a repair to the stored payload.
    const committedUpdate = hooks.validate?.() ?? update;
    const sequence = page.sequence + 1;
    const repairPayload = Buffer.from(committedUpdate).equals(Buffer.from(update)) ? null : Buffer.from(committedUpdate);
    await storeNewBatch(db, { pageId, batchId, payloadHash, sequence, update: committedUpdate, repairPayload }, hooks);
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

async function findCommittedReceipt(
  db: NodePgDatabase,
  pageId: string,
  batchId: string,
): Promise<StoredReceipt | undefined> {
  const [receipt] = await db.select({
    payloadHash: receipts.payloadHash,
    sequence: receipts.sequence,
    repairPayload: receipts.repairPayload,
  }).from(receipts)
    .where(and(eq(receipts.pageId, pageId), eq(receipts.batchId, batchId)));
  return receipt;
}

function duplicateCommitResult(receipt: StoredReceipt, submittedUpdate: Uint8Array): CommitResult {
  // Return the originally stored repair, never generate another one on replay.
  const repairedPayload = !receipt.repairPayload || receipt.repairPayload.equals(submittedUpdate)
    ? {} : { committedUpdate: receipt.repairPayload };
  return { sequence: receipt.sequence, duplicate: true, ...repairedPayload };
}

/** These writes share the caller's transaction and follow candidate validation. */
async function storeNewBatch(db: NodePgDatabase, batch: NewBatch, hooks: CommitHooks): Promise<void> {
  const { pageId, batchId, payloadHash, sequence, update, repairPayload } = batch;
  await db.insert(documentUpdates).values({ pageId, sequence, payload: Buffer.from(update) });
  await db.insert(receipts).values({ pageId, batchId, payloadHash, sequence, repairPayload });
  await db.update(pages).set({
    sequence,
    ...(hooks.projectTitle ? { title: hooks.projectTitle() } : {}),
  }).where(eq(pages.id, pageId));
}
