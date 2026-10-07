import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { createSeed } from './document.js';
import { commitUpdate, loadPage, migrateDatabase } from './persistence.js';
import { compactPage } from './document-snapshots.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;
type Phase = 'before-commit' | 'after-commit' | 'before-snapshot-commit' | 'after-snapshot-commit' | 'before-prune-commit';

/** Real TCP forwarding until COMMIT, then blackhole server replies only. */
async function commitResponseBlackhole(targetUrl: string) {
  const target = new URL(targetUrl);
  const upstreamHost = target.hostname;
  const upstreamPort = Number(target.port || 5432);
  const sockets = new Set<net.Socket>();
  let intercepted!: () => void;
  const interceptedCommit = new Promise<void>(resolve => { intercepted = resolve; });
  const proxy = net.createServer(client => {
    const upstream = net.connect(upstreamPort, upstreamHost);
    sockets.add(client); sockets.add(upstream);
    let startup = true;
    let input = Buffer.alloc(0);
    let blackhole = false;
    client.on('data', data => {
      input = Buffer.concat([input, data]);
      while (input.length >= (startup ? 4 : 5)) {
        const size = startup ? input.readInt32BE(0) : input.readInt32BE(1) + 1;
        if (size < 4 || size > 8 * 1024 * 1024) { client.destroy(); upstream.destroy(); return; }
        if (input.length < size) break;
        const packet = input.subarray(0, size); input = input.subarray(size);
        if (!startup && packet[0] === 81 && packet.subarray(5).toString() === 'COMMIT\0') {
          blackhole = true; intercepted();
        }
        startup = false;
        upstream.write(packet);
      }
    });
    upstream.on('data', data => { if (!blackhole) client.write(data); });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);
  });
  target.hostname = '127.0.0.1'; target.port = String((proxy.address() as net.AddressInfo).port);
  return {
    url: target.toString(), interceptedCommit,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    },
  };
}

// Each case owns a schema, never resets public, and kills a separate OS process.
describe.skipIf(!databaseUrl)('durability across SIGKILL', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool;
  let schema: string;
  let pageId: string;
  let batchId: string;
  let update: Uint8Array;
  let expected: Uint8Array;
  let child: ChildProcess | undefined;

  beforeAll(async () => { await admin.query('SELECT 1'); });
  beforeEach(async () => {
    schema = `crash_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateDatabase(pool);
    pageId = randomUUID(); batchId = randomUUID();
    const seed = createSeed('Crash fixture', 'Original.');
    await pool.query('INSERT INTO pages(id,owner_id,schema_version,initial_state) VALUES($1,$2,$3,$4)',
      [pageId, DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, Buffer.from(seed)]);
    await pool.query("INSERT INTO page_grants VALUES($1,$2,'owner')", [pageId, DEV_ACCOUNT_ID]);
    const doc = new Y.Doc({ gc: false }); Y.applyUpdate(doc, seed);
    const vector = Y.encodeStateVector(doc);
    ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'Recovered. ');
    update = Y.encodeStateAsUpdate(doc, vector); expected = Y.encodeStateAsUpdate(doc); doc.destroy();
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
    child = undefined;
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
  afterAll(async () => { await admin.end(); });

  function startWorker(url = databaseUrl) {
    child = fork(fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, KIKIT_TEST_DATABASE_URL: url },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const worker = child;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      worker.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { worker, exited };
  }

  async function killAt(phase: Phase) {
    const { worker, exited } = startWorker();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Crash checkpoint timed out')), 8_000);
      const fail = () => { clearTimeout(timer); reject(new Error('Crash fixture exited before checkpoint')); };
      worker.once('error', fail); worker.once('exit', fail);
      worker.on('message', message => {
        if ((message as { checkpoint?: string }).checkpoint === phase) {
          clearTimeout(timer); worker.off('error', fail); worker.off('exit', fail); resolve();
        } else {
          clearTimeout(timer); reject(new Error('Crash fixture failed before checkpoint'));
        }
      });
      worker.send({ schema, pageId, batchId, update: Buffer.from(update).toString('base64'), phase });
    });
    expect(worker.kill('SIGKILL')).toBe(true);
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
    // New connections and a new Y.Doc reconstruct storage after the killed worker.
    await pool.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  }

  it.each(['before-commit', 'after-commit'] as const)('replays the original batch after a crash %s', async phase => {
    await killAt(phase);
    const committed = phase === 'after-commit';
    const before = (await pool.query(`SELECT sequence,
      (SELECT count(*)::int FROM receipts WHERE page_id=$1) AS receipts,
      (SELECT count(*)::int FROM document_updates WHERE page_id=$1) AS updates
      FROM pages WHERE id=$1`, [pageId])).rows[0];
    expect(before).toEqual({ sequence: committed ? '1' : '0', receipts: committed ? 1 : 0, updates: committed ? 1 : 0 });
    expect(await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: committed });
    expect(await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: true });
    const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
    expect(Y.encodeStateAsUpdate(loaded.doc)).toEqual(expected); loaded.doc.destroy();
    expect((await pool.query('SELECT batch_id, sequence FROM receipts')).rows).toEqual([{ batch_id: batchId, sequence: '1' }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM document_updates')).rows[0].count).toBe(1);
  });

  it('resolves a committed batch after its real TCP COMMIT response is blackholed', async () => {
    const proxy = await commitResponseBlackhole(databaseUrl!);
    const { worker, exited } = startWorker(proxy.url);
    let acknowledged = false;
    worker.on('message', message => { acknowledged ||= Boolean((message as { acknowledged?: boolean }).acknowledged); });
    let interceptionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      worker.send({ schema, pageId, batchId, update: Buffer.from(update).toString('base64'), phase: 'partition-commit' });
      await Promise.race([
        proxy.interceptedCommit,
        exited.then(() => { throw new Error('Partition fixture exited before COMMIT'); }),
        new Promise<never>((_, reject) => { interceptionTimer = setTimeout(() => reject(new Error('COMMIT interception timed out')), 5_000); }),
      ]);
      // Inspect through an independent, unpartitioned connection. COMMIT really
      // succeeded, while the application still has no PostgreSQL response.
      await expect.poll(async () => (await pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1 AND batch_id=$2',
        [pageId, batchId])).rows[0].count, { timeout: 5_000 }).toBe(1);
      expect(acknowledged).toBe(false);
      expect(worker.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      expect(await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: true });
      const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
      expect(loaded.sequence).toBe(1); expect(Y.encodeStateAsUpdate(loaded.doc)).toEqual(expected); loaded.doc.destroy();
      expect((await pool.query('SELECT count(*)::int AS count FROM document_updates')).rows[0].count).toBe(1);
      expect((await pool.query('SELECT batch_id FROM receipts')).rows).toEqual([{ batch_id: batchId }]);
    } finally { clearTimeout(interceptionTimer); await proxy.close(); }
  });

  it.each(['before-snapshot-commit', 'after-snapshot-commit', 'before-prune-commit'] as const)(
    'retains reconstructible state and receipts after a crash %s', async phase => {
      await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update);
      await killAt(phase);
      const page = (await pool.query('SELECT snapshot_state, snapshot_sequence FROM pages WHERE id=$1', [pageId])).rows[0];
      expect(page.snapshot_sequence).toBe(phase === 'before-snapshot-commit' ? '0' : '1');
      expect(page.snapshot_state === null).toBe(phase === 'before-snapshot-commit');
      // Interrupted DELETE is rolled back; committed snapshot is safe to reuse.
      expect((await pool.query('SELECT count(*)::int AS count FROM document_updates')).rows[0].count).toBe(1);
      const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
      expect(Y.encodeStateAsUpdate(loaded.doc)).toEqual(expected); loaded.doc.destroy();
      expect(await compactPage(pool, pageId, { accountId: DEV_ACCOUNT_ID })).toEqual({ snapshotSequence: 1, prunedUpdates: 1 });
      expect(await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: true });
      expect((await pool.query('SELECT count(*)::int AS count FROM document_updates')).rows[0].count).toBe(0);
      expect((await pool.query('SELECT batch_id FROM receipts')).rows).toEqual([{ batch_id: batchId }]);
    },
  );
});
