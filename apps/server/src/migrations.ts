import { fileURLToPath } from 'node:url';
import { asc } from 'drizzle-orm';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { bigint, pgTable, serial, text } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { DATABASE_SCHEMA_VERSION } from '@kikit/contracts';
import { CompatibilityError } from './persistence-errors.js';
import { schemaVersions } from './schema.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_LOCK = 719421;

/** Drizzle applies SQL and records its history in one transaction. Our session
 * lock also covers its history lookup, so concurrent runners cannot both apply it. */
export async function migrateDatabase(pool: pg.Pool, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
  const config = { migrationsFolder, migrationsTable: '__drizzle_migrations' };
  const files = readMigrationFiles(config);
  const client = await pool.connect();
  let locked = false;
  let discardConnection = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    locked = true;
    const db = drizzle(client);
    const { rows: [tables] } = await client.query<{
      schema: string | null; versions: string | null; history: string | null;
    }>(`SELECT current_schema() AS schema,
      to_regclass('schema_versions') AS versions,
      to_regclass('__drizzle_migrations') AS history`);
    if (!tables.schema) throw new Error('Migrations require a writable PostgreSQL schema.');
    if (tables.versions) {
      const versions = await db.select().from(schemaVersions);
      if (versions.length > 1 || versions.some(row => row.version < 1 || row.version > DATABASE_SCHEMA_VERSION)) {
        throw new CompatibilityError('Unsupported database version');
      }
    }
    if (tables.history) {
      const history = pgTable('__drizzle_migrations', {
        id: serial('id').primaryKey(),
        hash: text('hash').notNull(),
        createdAt: bigint('created_at', { mode: 'number' }),
      });
      const applied = await db.select().from(history).orderBy(asc(history.createdAt));
      verifyMigrationHistory(applied, files);
    }
    await migrate(db, { ...config, migrationsSchema: tables.schema });
  } catch (error) {
    // Includes an uncertain COMMIT or failed rollback inside Drizzle's migrator.
    discardConnection = true;
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      } catch {
        discardConnection = true;
      }
    }
    client.release(discardConnection);
  }
}

function verifyMigrationHistory(
  applied: { hash: string; createdAt: number | null }[],
  files: MigrationMeta[],
): void {
  const mismatch = applied.some((row, index) => {
    const file = files[index];
    return !file || row.hash !== file.hash || row.createdAt !== file.folderMillis;
  });
  if (mismatch) {
    throw new CompatibilityError('Migration history differs from these files. Applied migrations must remain unchanged.');
  }
}
