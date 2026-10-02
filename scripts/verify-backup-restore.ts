import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as Y from 'yjs';
import { createServer } from '../apps/server/src/app.js';
import { migrateDatabase } from '../apps/server/src/migrations.js';
import { commitUpdate, loadPage } from '../apps/server/src/persistence.js';

type App = Awaited<ReturnType<typeof createServer>>;
type AccountSession = { accountId: string; sessionId: string; cookie: string };
type CommittedPage = { pageId: string; batchId: string; update: Uint8Array; sequence: number };

// This drill only touches uniquely named disposable databases in local Compose.
// It never reads DATABASE_URL or any production credentials.
const suffix = randomBytes(8).toString('hex');
const sourceDatabase = `kikit_restore_source_${suffix}`;
const restoredDatabase = `kikit_restore_target_${suffix}`;
const runtimeRole = `kikit_runtime_${suffix}`;
const runtimePassword = randomBytes(24).toString('hex');
const localDatabaseUrl = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/';
const origin = 'http://127.0.0.1:5199';
const title = 'Restore drill';
const directory = await mkdtemp(join(tmpdir(), 'kikit-restore-'));
const dumpPath = join(directory, 'backup.dump');

// Track resources as they are acquired so partial setup failures can be cleaned up.
const admin = new pg.Pool({ connectionString: `${localDatabaseUrl}postgres` });
const pools: pg.Pool[] = [];
const clientClosures: Promise<void>[] = [];
const createdDatabases: string[] = [];
let roleCreated = false;
let app: App | undefined;
admin.on('error', reportPoolError);

async function verifyRestore() {
  try {
    process.env.NODE_ENV = 'test';
    process.env.KIKIT_DEV_FIXTURE = '0';
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');

    await createDatabasesAndRole();
    const source = poolFor(sourceDatabase);
    await prepareSourceDatabase(source);
    const runtime = poolFor(sourceDatabase, true);
    await verifyRuntimeCannotCreateTables(runtime);

    let magicLink = '';
    app = await createServer({
      databaseUrl: runtime.options.connectionString,
      origin,
      sendMagicLink: async ({ url }) => { magicLink = url; },
    });
    const session = await signIn(app, runtime, () => magicLink);
    const page = await createCommittedPage(app, runtime, session);
    await app.close();
    app = undefined;

    const original = await fingerprint(source);
    await runDatabaseTool(['pg_dump', '-U', 'kikit', '-Fc', sourceDatabase], 'dump');
    await runDatabaseTool(['pg_restore', '-U', 'kikit', '--exit-on-error', '-d', restoredDatabase], 'restore');
    const restored = poolFor(restoredDatabase);
    assert.deepEqual(await fingerprint(restored), original);
    await migrateDatabase(restored); // Restored checksums/history still accept this release.

    const restoredRuntime = poolFor(restoredDatabase, true);
    await verifyRuntimeCannotCreateTables(restoredRuntime);
    app = await createServer({
      databaseUrl: restoredRuntime.options.connectionString,
      origin,
      sendMagicLink: async () => undefined,
    });
    await verifyRestoredSession(app, session);
    await verifyRestoredPage(restoredRuntime, session, page);
  } finally {
    await cleanup();
  }
}

async function createDatabasesAndRole() {
  for (const database of [sourceDatabase, restoredDatabase]) {
    await admin.query(`CREATE DATABASE "${database}"`);
    createdDatabases.push(database);
  }
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  roleCreated = true;
}

async function prepareSourceDatabase(pool: pg.Pool) {
  await migrateDatabase(pool);
  await pool.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO "${runtimeRole}";
    GRANT SELECT ON schema_versions TO "${runtimeRole}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user, auth_session, auth_account, auth_verification,
      pages, page_grants, document_updates, receipts TO "${runtimeRole}";
  `);
}

async function verifyRuntimeCannotCreateTables(pool: pg.Pool) {
  await assert.rejects(pool.query('CREATE TABLE must_not_create (id int)'), /permission denied/);
}

async function signIn(server: App, pool: pg.Pool, getMagicLink: () => string): Promise<AccountSession> {
  const requested = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin },
    payload: { email: 'restore-drill@example.test', callbackURL: '/' },
  });
  assert.equal(requested.statusCode, 200);

  const verification = new URL(getMagicLink());
  const redemption = await server.inject({ url: verification.pathname + verification.search });
  assert.equal(redemption.statusCode, 302);
  const headers = redemption.headers['set-cookie'];
  const cookie = (Array.isArray(headers) ? headers : [headers])
    .filter(Boolean)
    .map(value => String(value).split(';')[0])
    .join('; ');

  const session = await server.inject({ url: '/api/session', headers: { cookie } });
  const accountId = session.json().accountId as string;
  const result = await pool.query('SELECT id FROM auth_session WHERE user_id=$1', [accountId]);
  const sessionId = result.rows[0].id as string;
  return { accountId, sessionId, cookie };
}

async function createCommittedPage(server: App, pool: pg.Pool, session: AccountSession): Promise<CommittedPage> {
  const { accountId, sessionId, cookie } = session;
  const pageId = randomUUID();
  const created = await server.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { origin, cookie },
    payload: { id: pageId },
  });
  assert.equal(created.statusCode, 200);

  const loaded = await loadPage(pool, pageId, accountId, sessionId);
  const before = Y.encodeStateVector(loaded.doc);
  (loaded.doc.getXmlFragment('title').get(0) as Y.XmlElement).insert(0, [new Y.XmlText(title)]);
  const update = Y.encodeStateAsUpdate(loaded.doc, before);
  loaded.doc.destroy();

  const batchId = randomUUID();
  const receipt = await commitUpdate(pool, pageId, accountId, batchId, update, {
    sessionId,
    projectTitle: () => title,
  });
  assert.equal(receipt.sequence, 1);
  return { pageId, batchId, update, sequence: receipt.sequence };
}

async function verifyRestoredSession(server: App, session: AccountSession) {
  const response = await server.inject({ url: '/api/session', headers: { cookie: session.cookie } });
  assert.equal(response.json().accountId, session.accountId);
}

async function verifyRestoredPage(pool: pg.Pool, session: AccountSession, page: CommittedPage) {
  const { accountId, sessionId } = session;
  const { pageId, batchId, update, sequence } = page;
  const duplicate = await commitUpdate(pool, pageId, accountId, batchId, update, { sessionId });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sequence, sequence);

  const recovered = await loadPage(pool, pageId, accountId, sessionId);
  assert.equal(recovered.doc.getXmlFragment('title').toString(), `<paragraph>${title}</paragraph>`);
  const vector = Y.encodeStateVector(recovered.doc);
  (recovered.doc.getXmlFragment('title').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' continued')]);
  const continued = Y.encodeStateAsUpdate(recovered.doc, vector);
  recovered.doc.destroy();

  const receipt = await commitUpdate(pool, pageId, accountId, randomUUID(), continued, { sessionId });
  assert.equal(receipt.sequence, 2);
}

async function fingerprint(pool: pg.Pool) {
  const tables = [
    'auth_user', 'auth_session', 'auth_account', 'auth_verification',
    'pages', 'page_grants', 'document_updates', 'receipts',
    'schema_versions', '__drizzle_migrations',
  ];
  const contents: [table: string, hash: string][] = [];
  for (const table of tables) {
    const result = await pool.query(`SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY row_to_json(t)::text`);
    // Compare exact rows without exposing session tokens or note bytes on failure.
    const hash = createHash('sha256').update(JSON.stringify(result.rows)).digest('hex');
    contents.push([table, hash]);
  }
  return contents;
}

async function runDatabaseTool(args: string[], mode: 'dump' | 'restore') {
  const file = await open(dumpPath, mode === 'dump' ? 'w' : 'r', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
        stdio: mode === 'dump' ? ['ignore', file.fd, 'pipe'] : [file.fd, 'ignore', 'pipe'],
      });
      child.stderr?.resume(); // Database tool errors may contain data; report only exit status.
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Database ${mode} failed (${code}).`));
      });
    });
  } finally {
    await file.close();
  }
}

function poolFor(database: string, runtime = false) {
  const connectionString = runtime
    ? `postgres://${runtimeRole}:${runtimePassword}@127.0.0.1:54329/${database}`
    : `${localDatabaseUrl}${database}`;
  const pool = new pg.Pool({ connectionString });
  pool.on('error', reportPoolError);
  pool.on('connect', client => {
    clientClosures.push(new Promise<void>(resolve => client.once('end', resolve)));
  });
  pools.push(pool);
  return pool;
}

function reportPoolError() {
  // An unhandled pool event can dump a client including its connection credentials.
  console.error('Restore drill database connection failed.');
  process.exitCode = 1;
}

async function cleanup() {
  await app?.close();
  await Promise.all(pools.map(pool => pool.end()));
  // pg-pool can settle end() before removed clients finish disconnecting.
  // Wait for their actual end events and never force-terminate a closing client.
  await Promise.all(clientClosures);
  for (const database of createdDatabases) await admin.query(`DROP DATABASE "${database}"`);
  if (roleCreated) await admin.query(`DROP ROLE "${runtimeRole}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}

try {
  await verifyRestore();
  if (!process.exitCode) {
    console.log('Local backup restore passed: account/session, exact binary records and receipt identity, continued writes, and runtime DDL denial.');
  }
} catch {
  // Driver/assertion errors may contain cookies, passwords, or note records.
  console.error('Local backup restore failed. Raw error details are omitted.');
  process.exitCode = 1;
}
