import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ACCOUNT_ID, DEV_PAGE_ID } from '@kikit/contracts';
import { createSeed } from './document.js';
import { seedDevelopmentPage } from './development-seed.js';
import { migrateDatabase } from './migrations.js';
import { commitUpdate, loadPage } from './persistence.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../migrations/', import.meta.url));

// Each case owns a temporary schema. Neither development notes nor public test
// fixtures are reset by this suite.
describe.skipIf(!databaseUrl)('SQL migrations on PostgreSQL', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool;
  let schema: string;
  let temporaryFolder: string;

  beforeAll(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
  });

  beforeEach(async () => {
    schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    temporaryFolder = await mkdtemp(join(tmpdir(), 'kikit-migrations-'));
    await cp(migrationsFolder, temporaryFolder, { recursive: true });
  });

  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await rm(temporaryFolder, { recursive: true, force: true });
  });

  afterAll(async () => {
    await admin.end();
    vi.unstubAllEnvs();
  });

  async function addMigration(fixture: 'probe' | 'failed'): Promise<void> {
    const journalPath = join(temporaryFolder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const tag = `0001_${fixture}`;
    journal.entries.push({
      idx: journal.entries.length, version: '7', when: journal.entries.at(-1).when + 1, tag, breakpoints: true,
    });
    await writeFile(journalPath, JSON.stringify(journal));
    await cp(new URL(`./fixtures/migrations/${tag}.sql`, import.meta.url), join(temporaryFolder, `${tag}.sql`));
  }

  it('migrates concurrently and repeatedly, while keeping the seed explicit and idempotent', async () => {
    await Promise.all([migrateDatabase(pool), migrateDatabase(pool)]);
    await migrateDatabase(pool);
    expect((await pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations')).rows[0].count).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS count FROM pages')).rows[0].count).toBe(0);
    await seedDevelopmentPage(pool);
    const original = (await pool.query('SELECT initial_state FROM pages')).rows[0].initial_state;
    await Promise.all([seedDevelopmentPage(pool), seedDevelopmentPage(pool)]);
    const pages = await pool.query('SELECT initial_state FROM pages');
    expect(pages.rows).toHaveLength(1);
    expect(pages.rows[0].initial_state).toEqual(original);
    expect((await pool.query('SELECT count(*)::int AS count FROM page_grants')).rows[0].count).toBe(1);
  });

  it('adopts the old unjournaled schema without changing note bytes, updates, or receipts', async () => {
    await pool.query(await readFile(join(migrationsFolder, '0000_initial_schema.sql'), 'utf8'));
    await pool.query('INSERT INTO pages (id, owner_id, schema_version, initial_state) VALUES ($1,$2,1,$3)', [DEV_PAGE_ID, DEV_ACCOUNT_ID, Buffer.from(createSeed())]);
    await pool.query("INSERT INTO page_grants (page_id, account_id, role) VALUES ($1,$2,'owner')", [DEV_PAGE_ID, DEV_ACCOUNT_ID]);
    const original = (await pool.query('SELECT initial_state FROM pages')).rows[0].initial_state;
    const { doc } = await loadPage(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID);
    const beforeEdit = Y.encodeStateVector(doc);
    const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, 'Existing note. ');
    const update = Y.encodeStateAsUpdate(doc, beforeEdit);
    doc.destroy();
    const batchId = randomUUID();
    await commitUpdate(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID, batchId, update);
    await migrateDatabase(pool);
    await seedDevelopmentPage(pool);
    expect((await pool.query('SELECT initial_state, sequence FROM pages')).rows[0]).toEqual({ initial_state: original, sequence: '1' });
    expect((await pool.query('SELECT payload FROM document_updates')).rows[0].payload).toEqual(Buffer.from(update));
    expect((await pool.query('SELECT batch_id FROM receipts')).rows[0].batch_id).toBe(batchId);
    const replay = await commitUpdate(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID, batchId, update);
    expect(replay).toEqual({ sequence: 1, duplicate: true });
  });

  it('applies a subsequent SQL file exactly once across concurrent runners', async () => {
    await migrateDatabase(pool, temporaryFolder);
    await addMigration('probe');
    await Promise.all([migrateDatabase(pool, temporaryFolder), migrateDatabase(pool, temporaryFolder)]);
    await migrateDatabase(pool, temporaryFolder);
    expect((await pool.query('SELECT id FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations')).rows[0].count).toBe(3);
  });

  it('rolls back failed DDL and leaves that migration unrecorded', async () => {
    await migrateDatabase(pool, temporaryFolder);
    await addMigration('failed');
    await expect(migrateDatabase(pool, temporaryFolder)).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('migration_probe') AS table")).rows[0].table).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations')).rows[0].count).toBe(2);
  });

  it('rejects changed applied SQL and missing history instead of silently skipping it', async () => {
    await migrateDatabase(pool, temporaryFolder);
    const path = join(temporaryFolder, '0000_initial_schema.sql');
    const original = await readFile(path, 'utf8');
    await writeFile(path, `${original}\n-- Edited after application.\n`);
    await expect(migrateDatabase(pool, temporaryFolder)).rejects.toThrow('Applied migrations must remain unchanged');
    await writeFile(path, original);
    const journalPath = join(temporaryFolder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.entries = [];
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(migrateDatabase(pool, temporaryFolder)).rejects.toThrow('Migration history differs');
  });

  it('rejects a newer legacy schema before creating migration history', async () => {
    await pool.query(await readFile(join(migrationsFolder, '0000_initial_schema.sql'), 'utf8'));
    await pool.query('UPDATE schema_versions SET version = 999');
    await expect(migrateDatabase(pool)).rejects.toThrow('Unsupported database version');
    expect((await pool.query("SELECT to_regclass('__drizzle_migrations') AS table")).rows[0].table).toBeNull();
  });
});
