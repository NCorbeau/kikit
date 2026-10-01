import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { requireDevelopmentFixture } from './config.js';
import { createSeed } from './document.js';
import { pageGrants, pages } from './schema.js';

/** Fixture data is separate from schema migrations and explicitly development-only. */
export async function seedDevelopmentPage(pool: pg.Pool): Promise<void> {
  requireDevelopmentFixture();
  const client = await pool.connect();
  const db = drizzle(client);
  let discardConnection = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(719421)');
    await db.insert(pages).values({
      id: DEV_PAGE_ID,
      ownerId: DEV_ACCOUNT_ID,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      initialState: Buffer.from(createSeed()),
    }).onConflictDoNothing();
    await db.insert(pageGrants).values({
      pageId: DEV_PAGE_ID,
      accountId: DEV_ACCOUNT_ID,
      role: 'owner',
    }).onConflictDoNothing();
    await client.query('COMMIT');
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
