import { createHash } from 'node:crypto';
import pg from 'pg';
import * as Y from 'yjs';
import { DATABASE_SCHEMA_VERSION, DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { createSeed } from './document.js';

export class AccessError extends Error {}
export class ReceiptConflict extends Error {}
export class CompatibilityError extends Error {}
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 10000, options: "-c transaction_timeout=15000" });
}
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(719421)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pages (
        id uuid PRIMARY KEY, owner_id text NOT NULL, schema_version integer NOT NULL,
        sequence bigint NOT NULL DEFAULT 0, initial_state bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS page_grants (
        page_id uuid NOT NULL REFERENCES pages(id), account_id text NOT NULL,
        role text NOT NULL CHECK (role IN ('owner','editor')), PRIMARY KEY(page_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS document_updates (
        page_id uuid NOT NULL REFERENCES pages(id), sequence bigint NOT NULL,
        payload bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(page_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        page_id uuid NOT NULL REFERENCES pages(id), batch_id uuid NOT NULL,
        payload_hash text NOT NULL, sequence bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(page_id, batch_id),
        FOREIGN KEY(page_id, sequence) REFERENCES document_updates(page_id, sequence)
      )`);
    const versions = await client.query<{ version: number }>('SELECT version FROM schema_versions');
    if (versions.rows.some(row => row.version !== DATABASE_SCHEMA_VERSION)) throw new CompatibilityError('Unsupported database version');
    await client.query('INSERT INTO schema_versions(version) VALUES($1) ON CONFLICT DO NOTHING', [DATABASE_SCHEMA_VERSION]);
    await client.query('INSERT INTO pages(id,owner_id,schema_version,initial_state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [DEV_PAGE_ID, DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, Buffer.from(createSeed())]);
    await client.query("INSERT INTO page_grants(page_id,account_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING", [DEV_PAGE_ID, DEV_ACCOUNT_ID]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
async function authorize(client: pg.PoolClient, pageId: string, accountId: string, lock = false): Promise<{ sequence: string; initial_state: Buffer }> {
  const result = await client.query<{ sequence: string; initial_state: Buffer; schema_version: number }>(`
    SELECT p.sequence, p.initial_state, p.schema_version FROM pages p
    JOIN page_grants g ON g.page_id=p.id AND g.account_id=$2
    WHERE p.id=$1 AND g.role IN ('owner','editor') ${lock ? 'FOR UPDATE OF p, g' : ''}`, [pageId, accountId]);
  if (!result.rows[0]) throw new AccessError('Page access denied');
  if (result.rows[0].schema_version !== DOCUMENT_SCHEMA_VERSION) throw new CompatibilityError('Unsupported document schema');
  return result.rows[0];
}
export async function loadPage(pool: pg.Pool, pageId: string, accountId: string): Promise<{ doc: Y.Doc; sequence: number }> {
  const client = await pool.connect();
  const doc = new Y.Doc();
  try {
    await client.query('BEGIN');
    const page = await authorize(client, pageId, accountId, true);
    Y.applyUpdate(doc, page.initial_state);
    const updates = await client.query<{ payload: Buffer }>('SELECT payload FROM document_updates WHERE page_id=$1 AND sequence <= $2 ORDER BY sequence', [pageId, page.sequence]);
    for (const row of updates.rows) Y.applyUpdate(doc, row.payload);
    await client.query('COMMIT');
    return { doc, sequence: Number(page.sequence) };
  } catch (error) {
    doc.destroy();
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
export async function commitUpdate(pool: pg.Pool, pageId: string, accountId: string, batchId: string, update: Uint8Array, beforeCommit?: () => Promise<void>, validate?: () => void, afterCommit?: () => void): Promise<{ sequence: number; duplicate: boolean }> {
  const client = await pool.connect();
  let discard = false;
  const hash = createHash('sha256').update(update).digest('hex');
  try {
    await client.query('BEGIN');
    const page = await authorize(client, pageId, accountId, true);
    const receipt = await client.query<{ payload_hash: string; sequence: string }>('SELECT payload_hash, sequence FROM receipts WHERE page_id=$1 AND batch_id=$2', [pageId, batchId]);
    if (receipt.rows[0]) {
      if (receipt.rows[0].payload_hash !== hash) throw new ReceiptConflict('Batch identity already belongs to different bytes');
      await client.query('COMMIT');
      return { sequence: Number(receipt.rows[0].sequence), duplicate: true };
    }
    validate?.();
    const sequence = Number(page.sequence) + 1;
    await client.query('INSERT INTO document_updates(page_id,sequence,payload) VALUES($1,$2,$3)', [pageId, sequence, Buffer.from(update)]);
    await client.query('INSERT INTO receipts(page_id,batch_id,payload_hash,sequence) VALUES($1,$2,$3,$4)', [pageId, batchId, hash, sequence]);
    await client.query('UPDATE pages SET sequence=$2 WHERE id=$1', [pageId, sequence]);
    await beforeCommit?.();
    // No client timeout races this transaction. Unknown COMMIT results remain unacknowledged.
    await client.query('COMMIT');
    afterCommit?.();
    return { sequence, duplicate: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
