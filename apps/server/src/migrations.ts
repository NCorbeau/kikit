import type pg from 'pg';
import {
  DATABASE_SCHEMA_VERSION,
  DEV_ACCOUNT_ID,
  DEV_PAGE_ID,
  DOCUMENT_SCHEMA_VERSION,
} from '@kikit/contracts';
import { createSeed } from './document.js';
import { CompatibilityError } from './persistence-errors.js';

const INITIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS pages (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    schema_version integer NOT NULL,
    sequence bigint NOT NULL DEFAULT 0,
    initial_state bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS page_grants (
    page_id uuid NOT NULL REFERENCES pages(id),
    account_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','editor')),
    PRIMARY KEY(page_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS document_updates (
    page_id uuid NOT NULL REFERENCES pages(id),
    sequence bigint NOT NULL,
    payload bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(page_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    page_id uuid NOT NULL REFERENCES pages(id),
    batch_id uuid NOT NULL,
    payload_hash text NOT NULL,
    sequence bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(page_id, batch_id),
    FOREIGN KEY(page_id, sequence) REFERENCES document_updates(page_id, sequence)
  )`;

/** Migration and one-time seed share a transaction protected by an advisory lock. */
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(719421)');
    await client.query(INITIAL_SCHEMA);
    const versions = await client.query<{ version: number }>('SELECT version FROM schema_versions');
    if (versions.rows.some(row => row.version !== DATABASE_SCHEMA_VERSION)) {
      throw new CompatibilityError('Unsupported database version');
    }
    await client.query(`
      INSERT INTO schema_versions(version) VALUES($1)
      ON CONFLICT DO NOTHING`, [DATABASE_SCHEMA_VERSION]);
    await client.query(`
      INSERT INTO pages(id, owner_id, schema_version, initial_state) VALUES($1, $2, $3, $4)
      ON CONFLICT DO NOTHING`, [DEV_PAGE_ID, DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, Buffer.from(createSeed())]);
    await client.query(`
      INSERT INTO page_grants(page_id, account_id, role) VALUES($1, $2, 'owner')
      ON CONFLICT DO NOTHING`, [DEV_PAGE_ID, DEV_ACCOUNT_ID]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
