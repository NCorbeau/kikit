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

// This drill only touches uniquely named disposable databases in local Compose.
// It never reads DATABASE_URL or any production credentials.
const suffix = randomBytes(8).toString('hex');
const source = `kikit_restore_source_${suffix}`;
const target = `kikit_restore_target_${suffix}`;
const role = `kikit_runtime_${suffix}`;
const password = randomBytes(24).toString('hex');
const base = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/';
const admin = new pg.Pool({ connectionString: `${base}postgres` });
const pools: pg.Pool[] = [];
const clientClosures: Promise<void>[] = [];
const directory = await mkdtemp(join(tmpdir(), 'kikit-restore-'));
const dump = join(directory, 'backup.dump');
let app: Awaited<ReturnType<typeof createServer>> | undefined;
const databases: string[] = [];
let roleCreated = false;

function poolError() {
  // An unhandled pool event can dump a client including its connection credentials.
  console.error('Restore drill database connection failed.');
  process.exitCode = 1;
}
admin.on('error', poolError);

function poolFor(database: string, runtime = false) {
  const pool = new pg.Pool({ connectionString: runtime
    ? `postgres://${role}:${password}@127.0.0.1:54329/${database}` : `${base}${database}` });
  pool.on('error', poolError);
  pool.on('connect', client => {
    clientClosures.push(new Promise<void>(resolve => client.once('end', resolve)));
  });
  pools.push(pool);
  return pool;
}
async function databaseTool(args: string[], mode: 'dump' | 'restore') {
  const file = await open(dump, mode === 'dump' ? 'w' : 'r', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
        stdio: mode === 'dump' ? ['ignore', file.fd, 'pipe'] : [file.fd, 'ignore', 'pipe'],
      });
      child.stderr?.resume(); // Database tool errors may contain data; report only exit status.
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Database ${mode} failed (${code}).`)));
    });
  } finally { await file.close(); }
}
async function fingerprint(pool: pg.Pool) {
  const tables = ['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'pages', 'page_grants', 'document_updates', 'receipts', 'schema_versions', '__drizzle_migrations'];
  const contents: unknown[] = [];
  for (const table of tables) {
    const result = await pool.query(`SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY row_to_json(t)::text`);
    // Compare exact rows without exposing session tokens or note bytes on failure.
    contents.push([table, createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')]);
  }
  return contents;
}

async function verifyRestore() {
  try {
    process.env.NODE_ENV = 'test'; process.env.KIKIT_DEV_FIXTURE = '0';
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
    for (const database of [source, target]) {
      await admin.query(`CREATE DATABASE "${database}"`);
      databases.push(database);
    }
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    roleCreated = true;
    const privileged = poolFor(source);
    await migrateDatabase(privileged);
    await privileged.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO "${role}";
      GRANT SELECT ON schema_versions TO "${role}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user, auth_session, auth_account, auth_verification,
        pages, page_grants, document_updates, receipts TO "${role}";`);
    const runtime = poolFor(source, true);
    await assert.rejects(runtime.query('CREATE TABLE must_not_create (id int)'), /permission denied/);
    let link = '';
    const origin = 'http://127.0.0.1:5199';
    app = await createServer({ databaseUrl: runtime.options.connectionString, origin, sendMagicLink: async ({ url }) => { link = url; } });
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { origin }, payload: { email: 'restore-drill@example.test', callbackURL: '/' } })).statusCode, 200);
    const verification = new URL(link);
    const redemption = await app.inject({ url: verification.pathname + verification.search });
    assert.equal(redemption.statusCode, 302);
    const headers = redemption.headers['set-cookie'];
    const cookie = (Array.isArray(headers) ? headers : [headers]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const accountId = (await app.inject({ url: '/api/session', headers: { cookie } })).json().accountId as string;
    const sessionId = (await runtime.query('SELECT id FROM auth_session WHERE user_id=$1', [accountId])).rows[0].id as string;
    const pageId = randomUUID();
    assert.equal((await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie }, payload: { id: pageId } })).statusCode, 200);
    const loaded = await loadPage(runtime, pageId, accountId, sessionId);
    const before = Y.encodeStateVector(loaded.doc);
    (loaded.doc.getXmlFragment('title').get(0) as Y.XmlElement).insert(0, [new Y.XmlText('Restore drill')]);
    const update = Y.encodeStateAsUpdate(loaded.doc, before);
    loaded.doc.destroy();
    const batchId = randomUUID();
    const receipt = await commitUpdate(runtime, pageId, accountId, batchId, update, { sessionId, projectTitle: () => 'Restore drill' });
    assert.equal(receipt.sequence, 1);
    await app.close(); app = undefined;
    const original = await fingerprint(privileged);
    await databaseTool(['pg_dump', '-U', 'kikit', '-Fc', source], 'dump');
    await databaseTool(['pg_restore', '-U', 'kikit', '--exit-on-error', '-d', target], 'restore');
    const restored = poolFor(target);
    assert.deepEqual(await fingerprint(restored), original);
    await migrateDatabase(restored); // Restored checksums/history still accept this release.
    const restoredRuntime = poolFor(target, true);
    await assert.rejects(restoredRuntime.query('CREATE TABLE must_not_create (id int)'), /permission denied/);
    app = await createServer({ databaseUrl: restoredRuntime.options.connectionString, origin, sendMagicLink: async () => undefined });
    assert.equal((await app.inject({ url: '/api/session', headers: { cookie } })).json().accountId, accountId);
    const duplicate = await commitUpdate(restoredRuntime, pageId, accountId, batchId, update, { sessionId });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.sequence, receipt.sequence);
    const recovered = await loadPage(restoredRuntime, pageId, accountId, sessionId);
    assert.equal(recovered.doc.getXmlFragment('title').toString(), '<paragraph>Restore drill</paragraph>');
    const vector = Y.encodeStateVector(recovered.doc);
    (recovered.doc.getXmlFragment('title').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' continued')]);
    const continued = Y.encodeStateAsUpdate(recovered.doc, vector);
    recovered.doc.destroy();
    assert.equal((await commitUpdate(restoredRuntime, pageId, accountId, randomUUID(), continued, { sessionId })).sequence, 2);
  } finally {
    await app?.close();
    await Promise.all(pools.map(pool => pool.end()));
    // pg-pool can settle end() before removed clients finish disconnecting.
    // Wait for their actual end events and never force-terminate a closing client.
    await Promise.all(clientClosures);
    for (const database of databases) await admin.query(`DROP DATABASE "${database}"`);
    if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await verifyRestore();
  if (!process.exitCode) console.log('Local backup restore passed: account/session, exact binary records and receipt identity, continued writes, and runtime DDL denial.');
} catch {
  // Driver/assertion errors may contain cookies, passwords, or note records.
  console.error('Local backup restore failed. Raw error details are omitted.');
  process.exitCode = 1;
}
