import { createHash } from 'node:crypto';
import pg from 'pg';
import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { AccessError, CompatibilityError, ReceiptConflict } from './persistence-errors.js';

export { AccessError, CompatibilityError, ReceiptConflict } from './persistence-errors.js';
export { migrateDatabase } from './migrations.js';

interface AuthorizedPage {
  sequence: string;
  initial_state: Buffer;
  schema_version: number;
}
interface StoredReceipt {
  payload_hash: string;
  sequence: string;
  payload: Buffer;
}
export interface CommitResult {
  sequence: number;
  duplicate: boolean;
  committedUpdate?: Uint8Array;
}
export interface CommitHooks {
  beforeCommit?: () => Promise<void>;
  validate?: () => Uint8Array | void;
  afterCommit?: () => void;
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
  client: pg.PoolClient,
  pageId: string,
  accountId: string,
): Promise<AuthorizedPage> {
  const result = await client.query<AuthorizedPage>(`
    SELECT p.sequence, p.initial_state, p.schema_version
    FROM pages p
    JOIN page_grants g ON g.page_id = p.id AND g.account_id = $2
    WHERE p.id = $1 AND g.role IN ('owner','editor')
    FOR UPDATE OF p, g`, [pageId, accountId]);
  const page = result.rows[0];
  if (!page) throw new AccessError('Page access denied');
  if (page.schema_version !== DOCUMENT_SCHEMA_VERSION) {
    throw new CompatibilityError('Unsupported document schema');
  }
  return page;
}

export async function loadPage(
  pool: pg.Pool,
  pageId: string,
  accountId: string,
): Promise<{ doc: Y.Doc; sequence: number }> {
  const client = await pool.connect();
  const doc = new Y.Doc();
  try {
    await client.query('BEGIN');
    const page = await authorizeLockedPage(client, pageId, accountId);
    Y.applyUpdate(doc, page.initial_state);
    const updates = await client.query<{ payload: Buffer }>(`
      SELECT payload FROM document_updates
      WHERE page_id = $1 AND sequence <= $2
      ORDER BY sequence`, [pageId, page.sequence]);
    for (const row of updates.rows) Y.applyUpdate(doc, row.payload);
    await client.query('COMMIT');
    return { doc, sequence: Number(page.sequence) };
  } catch (error) {
    doc.destroy();
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
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
  let discardConnection = false;
  const payloadHash = createHash('sha256').update(update).digest('hex');
  try {
    await client.query('BEGIN');
    const page = await authorizeLockedPage(client, pageId, accountId);
    const receipts = await client.query<StoredReceipt>(`
      SELECT r.payload_hash, r.sequence, u.payload
      FROM receipts r
      JOIN document_updates u ON u.page_id = r.page_id AND u.sequence = r.sequence
      WHERE r.page_id = $1 AND r.batch_id = $2`, [pageId, batchId]);
    const receipt = receipts.rows[0];
    // Receipt lookup precedes validation: retries recover the original commit and repair.
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) {
        throw new ReceiptConflict('Batch identity already belongs to different bytes');
      }
      await client.query('COMMIT');
      const repairedPayload = receipt.payload.equals(update) ? {} : { committedUpdate: receipt.payload };
      return { sequence: Number(receipt.sequence), duplicate: true, ...repairedPayload };
    }

    // Hash immutable client bytes; validation may add a repair to the stored payload.
    const committedUpdate = hooks.validate?.() ?? update;
    const sequence = Number(page.sequence) + 1;
    await client.query(`
      INSERT INTO document_updates(page_id, sequence, payload) VALUES($1, $2, $3)`,
    [pageId, sequence, Buffer.from(committedUpdate)]);
    await client.query(`
      INSERT INTO receipts(page_id, batch_id, payload_hash, sequence) VALUES($1, $2, $3, $4)`,
    [pageId, batchId, payloadHash, sequence]);
    await client.query('UPDATE pages SET sequence = $2 WHERE id = $1', [pageId, sequence]);
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
