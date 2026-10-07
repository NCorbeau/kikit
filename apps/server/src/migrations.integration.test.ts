import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_SCHEMA_VERSION, DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { createSeed } from './document.js';
import { seedDevelopmentPage } from './development-seed.js';
import { migrateDatabase } from './migrations.js';
import { commitUpdate, loadPage } from './persistence.js';
import { compactPage } from './document-snapshots.js';
import { prepareCommittedUpdate } from './document-candidate.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationCount = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')).entries.length;

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
    expect((await pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations')).rows[0].count).toBe(migrationCount);
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
    const doc = new Y.Doc();
    Y.applyUpdate(doc, original);
    const beforeEdit = Y.encodeStateVector(doc);
    const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, 'Existing note. ');
    const update = Y.encodeStateAsUpdate(doc, beforeEdit);
    doc.destroy();
    const batchId = randomUUID();
    // This fixture was created by the old version, before current-version APIs
    // would accept it. Retain its original update and payload-hashed receipt.
    await pool.query('INSERT INTO document_updates (page_id, sequence, payload) VALUES ($1,1,$2)', [DEV_PAGE_ID, Buffer.from(update)]);
    await pool.query('INSERT INTO receipts (page_id, batch_id, payload_hash, sequence) VALUES ($1,$2,$3,1)', [DEV_PAGE_ID, batchId, createHash('sha256').update(update).digest('hex')]);
    await pool.query('UPDATE pages SET sequence=1 WHERE id=$1', [DEV_PAGE_ID]);
    await migrateDatabase(pool);
    await seedDevelopmentPage(pool);
    expect((await pool.query('SELECT initial_state, sequence FROM pages')).rows[0]).toEqual({ initial_state: original, sequence: '1' });
    expect((await pool.query('SELECT payload FROM document_updates')).rows[0].payload).toEqual(Buffer.from(update));
    expect((await pool.query('SELECT batch_id FROM receipts')).rows[0].batch_id).toBe(batchId);
    const replay = await commitUpdate(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID, batchId, update);
    expect(replay).toEqual({ sequence: 1, duplicate: true });
  });

  it('upgrades schema-1 metadata without rewriting committed state, history or receipts', async () => {
    const journalPath = join(temporaryFolder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.entries = journal.entries.slice(0, 3);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrateDatabase(pool, temporaryFolder);
    const initial = Buffer.from(createSeed('Legacy note', 'Original content'));
    await pool.query('INSERT INTO pages (id, owner_id, schema_version, initial_state) VALUES ($1,$2,1,$3)', [DEV_PAGE_ID, DEV_ACCOUNT_ID, initial]);
    await pool.query("INSERT INTO page_grants (page_id, account_id, role) VALUES ($1,$2,'owner')", [DEV_PAGE_ID, DEV_ACCOUNT_ID]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, initial);
    const before = Y.encodeStateVector(doc);
    ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'Pending old version edit. ');
    const update = Y.encodeStateAsUpdate(doc, before);
    const batchId = randomUUID();
    await pool.query('INSERT INTO document_updates (page_id, sequence, payload) VALUES ($1,1,$2)', [DEV_PAGE_ID, Buffer.from(update)]);
    await pool.query('INSERT INTO receipts (page_id, batch_id, payload_hash, sequence) VALUES ($1,$2,$3,1)', [DEV_PAGE_ID, batchId, createHash('sha256').update(update).digest('hex')]);
    await pool.query('UPDATE pages SET sequence=1 WHERE id=$1', [DEV_PAGE_ID]);
    const updates = (await pool.query('SELECT * FROM document_updates')).rows;
    const receipts = (await pool.query('SELECT * FROM receipts')).rows;
    await migrateDatabase(pool);
    expect((await pool.query('SELECT * FROM schema_versions')).rows).toEqual([{ version: DATABASE_SCHEMA_VERSION }]);
    expect((await pool.query('SELECT initial_state, schema_version, sequence FROM pages')).rows[0])
      .toEqual({ initial_state: initial, schema_version: DOCUMENT_SCHEMA_VERSION, sequence: '1' });
    expect((await pool.query('SELECT * FROM document_updates')).rows).toEqual(updates);
    expect((await pool.query('SELECT * FROM receipts')).rows).toEqual(receipts.map(row => ({ ...row, repair_payload: null })));
    const loaded = await loadPage(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID);
    expect(Y.encodeStateAsUpdate(loaded.doc)).toEqual(Y.encodeStateAsUpdate(doc));
    expect(await commitUpdate(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: true });
    loaded.doc.destroy();
    doc.destroy();
  });

  it('moves legacy server repairs into durable receipts before allowing update pruning', async () => {
    const journalPath = join(temporaryFolder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.entries = journal.entries.slice(0, 5);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrateDatabase(pool, temporaryFolder);
    const initial = Buffer.from(createSeed());
    await pool.query('INSERT INTO pages (id, owner_id, schema_version, initial_state, sequence) VALUES ($1,$2,$3,$4,1)',
      [DEV_PAGE_ID, DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, initial]);
    await pool.query("INSERT INTO page_grants (page_id, account_id, role) VALUES ($1,$2,'owner')", [DEV_PAGE_ID, DEV_ACCOUNT_ID]);
    const committed = new Y.Doc(); Y.applyUpdate(committed, initial);
    const changed = new Y.Doc(); Y.applyUpdate(changed, initial);
    const vector = Y.encodeStateVector(changed); changed.getXmlFragment('body').delete(0, 1);
    const submitted = Y.encodeStateAsUpdate(changed, vector); changed.destroy();
    const repaired = prepareCommittedUpdate(committed, submitted).repairedUpdate!; committed.destroy();
    const batchId = randomUUID();
    const hash = createHash('sha256').update(submitted).digest('hex');
    await pool.query('INSERT INTO document_updates (page_id, sequence, payload) VALUES ($1,1,$2)', [DEV_PAGE_ID, Buffer.from(repaired)]);
    await pool.query('INSERT INTO receipts (page_id, batch_id, payload_hash, sequence) VALUES ($1,$2,$3,1)', [DEV_PAGE_ID, batchId, hash]);
    const original = (await pool.query('SELECT * FROM receipts')).rows[0];
    await migrateDatabase(pool);
    expect((await pool.query('SELECT * FROM receipts')).rows[0]).toEqual({ ...original, repair_payload: Buffer.from(repaired) });
    await compactPage(pool, DEV_PAGE_ID, { accountId: DEV_ACCOUNT_ID });
    expect((await pool.query('SELECT * FROM document_updates')).rowCount).toBe(0);
    expect(await commitUpdate(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID, batchId, submitted))
      .toEqual({ sequence: 1, duplicate: true, committedUpdate: Buffer.from(repaired) });
    const loaded = await loadPage(pool, DEV_PAGE_ID, DEV_ACCOUNT_ID);
    expect(loaded.doc.getXmlFragment('body').length).toBe(1); loaded.doc.destroy();
  });

  it('applies a subsequent SQL file exactly once across concurrent runners', async () => {
    await migrateDatabase(pool, temporaryFolder);
    await addMigration('probe');
    await Promise.all([migrateDatabase(pool, temporaryFolder), migrateDatabase(pool, temporaryFolder)]);
    await migrateDatabase(pool, temporaryFolder);
    expect((await pool.query('SELECT id FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations')).rows[0].count).toBe(migrationCount + 1);
  });

  it('rolls back failed DDL and leaves that migration unrecorded', async () => {
    await migrateDatabase(pool, temporaryFolder);
    await addMigration('failed');
    await expect(migrateDatabase(pool, temporaryFolder)).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('migration_probe') AS table")).rows[0].table).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations')).rows[0].count).toBe(migrationCount);
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
