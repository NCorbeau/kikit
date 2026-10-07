import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import pg from 'pg';
import * as Y from 'yjs';
import { BODY_FRAGMENT, DATABASE_SCHEMA_VERSION, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION } from '@kikit/contracts';
import { createServer } from '../apps/server/src/app';
import { createSeed, validateDocument } from '../apps/server/src/document';
import { migrateDatabase } from '../apps/server/src/migrations';
import { showSyncDetails } from '../tests/e2e/header-actions';

const ROUNDS = 20;
const WARMUP_ROUNDS = 3;
const OFFLINE_ROUNDS = 10;
const CONTENT_BYTES = [1024, 32 * 1024, 128 * 1024];
const LOCAL_ADMIN_URL = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/postgres';
let measurementPhase = 'setup';

interface InputSample {
  start: number;
  domMutationMs?: number;
  nextFrameMs?: number;
  localCommitMs?: number;
  durableAckMs?: number;
  acknowledgementSavedMs?: number;
}
interface BrowserMeasurement { editorReadyMs?: number; samples: InputSample[] }
declare global { interface Window { kikitPerf: BrowserMeasurement } }

// Instrument only synthetic typing and durability boundaries, never document text,
// cookies, invitation tokens or complete network payloads in the output artifact.
function installBrowserMeasurement() {
  const measurement: BrowserMeasurement = { samples: [] };
  window.kikitPerf = measurement;
  let current: InputSample | undefined;
  const batches = new Map<string, InputSample>();
  document.addEventListener('beforeinput', event => {
    const input = event as InputEvent;
    if (!(input.target instanceof Element) || !input.target.closest('[aria-label="Page body"]')
      || input.inputType !== 'insertText') return;
    current = { start: performance.now() };
    measurement.samples.push(current);
    const sample = current;
    requestAnimationFrame(() => { sample.nextFrameMs = performance.now() - sample.start; });
  }, true);
  const observer = new MutationObserver(() => {
    const body = document.querySelector('[aria-label="Page body"][contenteditable="true"]');
    if (body) {
      measurement.editorReadyMs ??= performance.now();
      observer.disconnect();
      new MutationObserver(() => {
        if (current && current.domMutationMs === undefined) current.domMutationMs = performance.now() - current.start;
      }).observe(body, { subtree: true, childList: true, characterData: true });
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable'] });

  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
    const result = add.call(this, value, key);
    const record = value as { id?: string; pending?: boolean } | null;
    if (this.name === 'updates' && current && record?.pending && typeof record.id === 'string') {
      const sample = current;
      batches.set(record.id, sample);
      this.transaction.addEventListener('complete', () => {
        sample.localCommitMs = performance.now() - sample.start;
      }, { once: true });
    }
    return result;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    const result = put.call(this, value, key);
    const record = value as { id?: string; pending?: boolean } | null;
    const sample = record?.id ? batches.get(record.id) : undefined;
    if (this.name === 'updates' && sample && record?.pending === false) {
      this.transaction.addEventListener('complete', () => {
        sample.acknowledgementSavedMs = performance.now() - sample.start;
      }, { once: true });
    }
    return result;
  };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data) as { type?: string; batchId?: string };
        const sample = message.batchId ? batches.get(message.batchId) : undefined;
        if (message.type === 'ack' && sample) sample.durableAckMs = performance.now() - sample.start;
      });
    }
  };
}

async function treeDigest(directories: string[]): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) { hash.update(filename); hash.update(await readFile(filename)); }
    }
  }
  for (const directory of directories) await visit(directory);
  return hash.digest('hex');
}

async function availablePort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function seededNote(contentBytes: number): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, createSeed('Synthetic performance note', ''));
    const body = doc.getXmlFragment(BODY_FRAGMENT);
    body.delete(0, body.length);
    for (let remaining = contentBytes; remaining > 0; remaining -= 1024) {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.setAttribute('id', randomUUID());
      const text = new Y.XmlText();
      text.insert(0, 'a'.repeat(Math.min(remaining, 1024)));
      paragraph.insert(0, [text]);
      body.insert(body.length, [paragraph]);
    }
    validateDocument(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

function distribution(values: number[]) {
  assert(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, median: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max: sorted.at(-1)! };
}

const METRICS = ['domMutationMs', 'nextFrameMs', 'localCommitMs', 'durableAckMs', 'acknowledgementSavedMs'] as const;
interface QueueSnapshot {
  admitted: number; completed: number; rejected: number; failures: number;
  waitMs: number; processingMs: number; pendingCount: number;
  snapshots: { attempted: number; completed: number; failures: number };
}

interface JournalRecord { id: string; bytes: number[]; pending: boolean }
async function readJournal(page: Page, accountId: string, pageId: string): Promise<JournalRecord[]> {
  return page.evaluate(async ({ accountId, pageId }) => {
    const opening = indexedDB.open(`kikit:${JSON.stringify([accountId, pageId])}`, 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      const transaction = database.transaction('updates', 'readonly');
      const request = transaction.objectStore('updates').getAll();
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return (request.result as { id: string; update: Uint8Array; pending: boolean }[])
        .map(record => ({ id: record.id, bytes: Array.from(record.update), pending: record.pending }));
    } finally { database.close(); }
  }, { accountId, pageId });
}

async function memorySnapshot(sessions: CDPSession[]) {
  const browserHeaps = await Promise.all(sessions.map(async session => {
    const result = await session.send('Performance.getMetrics');
    const metrics = new Map(result.metrics.map(metric => [metric.name, metric.value]));
    const usedBytes = metrics.get('JSHeapUsedSize');
    const totalBytes = metrics.get('JSHeapTotalSize');
    assert.equal(typeof usedBytes, 'number');
    assert.equal(typeof totalBytes, 'number');
    return { usedBytes: usedBytes!, totalBytes: totalBytes! };
  }));
  return { browserHeaps, node: process.memoryUsage() };
}

function xmlText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) return node.toString();
  return node.toArray().map(child => {
    assert(child instanceof Y.XmlElement || child instanceof Y.XmlText, 'Synthetic body must contain editor XML nodes');
    return xmlText(child);
  }).join('');
}

async function run() {
  const databaseName = `kikit_perf_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(LOCAL_ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Pool({ connectionString: LOCAL_ADMIN_URL });
  const pool = new pg.Pool({ connectionString: databaseUrl.href });
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const mail = new Map<string, string>();
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let created = false;
  const scenarios = [];
  const sourceDirectories = ['apps/server/src', 'apps/web/src', 'packages/contracts/src'];
  const sourceDigest = await treeDigest(sourceDirectories);
  const assetsDigest = await treeDigest(['apps/web/dist']);
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    process.env.NODE_ENV = 'test';
    process.env.KIKIT_DEV_FIXTURE = '0';
    process.env.KIKIT_TEST_FAULTS = '1';
    process.env.BETTER_AUTH_SECRET = 'local-performance-secret-never-used-in-production';
    await migrateDatabase(pool);
    server = await createServer({ databaseUrl: databaseUrl.href, origin, serveWeb: true,
      sendMagicLink: async ({ email, url }) => { mail.set(email, url); } });
    await server.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) });
    browser = await chromium.launch();
    let peer = 100;
    async function authenticate(context: BrowserContext) {
      const email = `${randomUUID()}@example.test`;
      const remoteAddress = `127.0.1.${++peer}`;
      const signed = await server!.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', remoteAddress,
        headers: { origin }, payload: { email, callbackURL: '/' } });
      assert.equal(signed.statusCode, 200);
      const link = new URL(mail.get(email)!);
      const redeemed = await server!.inject({ url: link.pathname + link.search, remoteAddress });
      assert.equal(redeemed.statusCode, 302);
      const header = redeemed.headers['set-cookie'];
      const values = (Array.isArray(header) ? header : [header]).filter(Boolean).map(String);
      const cookie = values.map(value => value.split(';')[0]).join('; ');
      await context.addCookies(values.map(value => {
        const pair = value.split(';')[0]!;
        const split = pair.indexOf('=');
        return { name: pair.slice(0, split), value: pair.slice(split + 1), url: origin, httpOnly: true,
          sameSite: 'Lax' as const };
      }));
      const identity = await server!.inject({ url: '/api/session', headers: { cookie }, remoteAddress });
      assert.equal(identity.statusCode, 200);
      return { cookie, accountId: identity.json().accountId as string };
    }
    async function queueMetrics(): Promise<QueueSnapshot> {
      const response = await server!.inject('/api/test/metrics');
      assert.equal(response.statusCode, 200);
      return response.json() as QueueSnapshot;
    }
    async function idleQueueMetrics(): Promise<QueueSnapshot> {
      let snapshot: QueueSnapshot | undefined;
      await expect.poll(async () => {
        snapshot = await queueMetrics();
        return snapshot.pendingCount;
      }).toBe(0);
      return snapshot!;
    }
    async function waitSaved(pages: Page[]) {
      await Promise.all(pages.map(page => expect(page.getByTestId('save-status')).toHaveText('Saved to server')));
    }
    for (const contentBytes of CONTENT_BYTES) for (const editors of [1, 2]) {
      measurementPhase = `${contentBytes / 1024} KiB / ${editors} editor scenario`;
      const contexts: BrowserContext[] = [];
      try {
        const accounts: { cookie: string; accountId: string }[] = [];
        for (let editor = 0; editor < editors; editor++) {
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          context.setDefaultTimeout(10_000);
          contexts.push(context);
          await context.addInitScript(installBrowserMeasurement);
          accounts.push(await authenticate(context));
        }
        const owner = accounts[0]!;
        const pageId = randomUUID();
        const response: { statusCode: number } = await server.inject({ method: 'POST', url: '/api/pages', headers: { cookie: owner.cookie, origin }, payload: { id: pageId } });
        assert.equal(response.statusCode, 200);
        const binary = seededNote(contentBytes);
        // Fixture setup before any live room: this measurement does not time note creation/import.
        await pool.query('UPDATE pages SET initial_state=$2,title=$3 WHERE id=$1', [pageId, Buffer.from(binary), 'Synthetic performance note']);
        if (editors === 2) {
          const invitation: { statusCode: number; json(): { token: string } } = await server.inject({ method: 'POST', url: `/api/pages/${pageId}/invitation`,
            headers: { cookie: owner.cookie, origin, 'x-kikit-account': owner.accountId } });
          assert.equal(invitation.statusCode, 200);
          const member = accounts[1]!;
          const joined: { statusCode: number } = await server.inject({ method: 'POST', url: '/api/invitations/join',
            headers: { cookie: member.cookie, origin, 'x-kikit-account': member.accountId }, payload: { token: invitation.json().token } });
          assert.equal(joined.statusCode, 200);
        }
        const pages = await Promise.all(contexts.map(context => context.newPage()));
        const cdpSessions = await Promise.all(pages.map(page => page.context().newCDPSession(page)));
        await Promise.all(cdpSessions.map(session => session.send('Performance.enable')));
        await Promise.all(pages.map(async page => {
          await page.goto(`${origin}/#/page/${pageId}`);
          await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toBeVisible();
          await showSyncDetails(page);
          await page.getByRole('textbox', { name: 'Page body', exact: true }).focus();
          await page.keyboard.press('ControlOrMeta+End');
        }));
        await waitSaved(pages);
        for (let round = 0; round < WARMUP_ROUNDS; round++) {
          await Promise.all(pages.map(page => page.keyboard.insertText('w')));
          await waitSaved(pages);
        }
        const before = await idleQueueMetrics();
        const beforeTyping = await memorySnapshot(cdpSessions);
        for (let round = 0; round < ROUNDS; round++) {
          await Promise.all(pages.map(page => page.keyboard.insertText('z')));
          await waitSaved(pages);
        }
        const after = await idleQueueMetrics();
        const afterTyping = await memorySnapshot(cdpSessions);
        const captures = await Promise.all(pages.map(page => page.evaluate(() => window.kikitPerf)));
        const samples = captures.flatMap(capture => capture.samples.slice(WARMUP_ROUNDS));
        assert.equal(samples.length, ROUNDS * editors, 'Every synthetic input must have one browser sample');
        for (const sample of samples) for (const metric of METRICS) assert.equal(typeof sample[metric], 'number', `Missing ${metric}`);
        samples.forEach(sample => assert(sample.acknowledgementSavedMs! >= sample.durableAckMs!, 'Local receipt commit must follow its durable ACK'));
        const stats = Object.fromEntries(METRICS.map(metric => [metric, distribution(samples.map(sample => sample[metric]!))]));
        const admitted = after.admitted - before.admitted;
        assert(admitted > 0);
        assert.equal(after.completed - before.completed, admitted, 'Idle queue boundaries must cover the same admitted/completed work');
        assert.equal(after.failures - before.failures, 0);
        assert.equal(after.rejected - before.rejected, 0);
        // The backlog is generated through actual editor input and its strict local
        // journal commits. Keep identities/bytes in memory only for replay checks.
        await Promise.all(contexts.map(context => context.setOffline(true)));
        await Promise.all(pages.map(page => expect(page.getByTestId('connection-status')).toHaveText('Offline')));
        for (let round = 0; round < OFFLINE_ROUNDS; round++) {
          await Promise.all(pages.map(page => page.keyboard.insertText('o')));
          await Promise.all(pages.map(page => expect.poll(() => page.evaluate(() =>
            window.kikitPerf.samples.at(-1)?.localCommitMs !== undefined)).toBe(true)));
        }
        const backlog = await Promise.all(pages.map((page, index) => readJournal(page, accounts[index]!.accountId, pageId)));
        const pending = backlog.map(records => records.filter(record => record.pending));
        pending.forEach(records => assert.equal(records.length, OFFLINE_ROUNDS));
        const originalBatches = pending.flat();
        const originalIds = originalBatches.map(record => record.id);
        const storedBefore = await pool.query('SELECT sequence FROM pages WHERE id=$1', [pageId]);
        const sequenceBeforeReplay = Number(storedBefore.rows[0].sequence);
        const priorReceipts = await pool.query('SELECT batch_id FROM receipts WHERE page_id=$1 AND batch_id=ANY($2::uuid[])', [pageId, originalIds]);
        assert.equal(priorReceipts.rowCount, 0);
        const offlineCaptures = await Promise.all(pages.map(page => page.evaluate(() => window.kikitPerf)));
        for (const capture of offlineCaptures) {
          const offlineSamples = capture.samples.slice(WARMUP_ROUNDS + ROUNDS);
          assert.equal(offlineSamples.length, OFFLINE_ROUNDS);
          offlineSamples.forEach(sample => assert.equal(sample.durableAckMs, undefined));
        }
        const offlineBacklog = await memorySnapshot(cdpSessions);
        const reconnectStart = performance.now();
        const reconnectMarkers = await Promise.all(pages.map(async (page, index) => {
          const marker = await page.evaluate(() => performance.now());
          await contexts[index]!.setOffline(false);
          return marker;
        }));
        await waitSaved(pages);
        const allSavedWallMs = performance.now() - reconnectStart;
        const replayed = await memorySnapshot(cdpSessions);
        const restored = await Promise.all(pages.map((page, index) => readJournal(page, accounts[index]!.accountId, pageId)));
        restored.forEach((records, index) => {
          assert.equal(records.filter(record => record.pending).length, 0);
          for (const original of pending[index]!) {
            const committed = records.find(record => record.id === original.id);
            assert(committed);
            assert.equal(committed.pending, false);
            assert.deepEqual(committed.bytes, original.bytes);
          }
        });
        const receipts = await pool.query('SELECT batch_id,payload_hash,sequence FROM receipts WHERE page_id=$1 AND batch_id=ANY($2::uuid[])', [pageId, originalIds]);
        assert.equal(receipts.rowCount, originalBatches.length);
        assert.equal(new Set(receipts.rows.map(row => row.batch_id)).size, originalBatches.length);
        for (const original of originalBatches) {
          assert.equal(receipts.rows.find(row => row.batch_id === original.id)?.payload_hash,
            createHash('sha256').update(Uint8Array.from(original.bytes)).digest('hex'));
        }
        const stored = await pool.query('SELECT initial_state,snapshot_state,snapshot_sequence,sequence FROM pages WHERE id=$1', [pageId]);
        const persisted = stored.rows[0];
        assert.equal(Number(persisted.sequence) - sequenceBeforeReplay, originalBatches.length);
        const tail = await pool.query('SELECT payload FROM document_updates WHERE page_id=$1 AND sequence>$2 ORDER BY sequence', [pageId, persisted.snapshot_sequence]);
        const persistedDoc = new Y.Doc();
        try {
          Y.applyUpdate(persistedDoc, persisted.snapshot_state ?? persisted.initial_state);
          for (const update of tail.rows) Y.applyUpdate(persistedDoc, update.payload);
          const texts = await Promise.all(pages.map(page => page.getByRole('textbox', { name: 'Page body', exact: true }).evaluate(element =>
            (element as HTMLElement & { editor: { state: { doc: { textContent: string } } } }).editor.state.doc.textContent)));
          texts.forEach(text => assert.equal(text, xmlText(persistedDoc.getXmlFragment(BODY_FRAGMENT))));
          assert.equal(texts[0]!.length, contentBytes + (WARMUP_ROUNDS + ROUNDS + OFFLINE_ROUNDS) * editors);
        } finally { persistedDoc.destroy(); }
        const replayCaptures = await Promise.all(pages.map(page => page.evaluate(() => window.kikitPerf)));
        const replaySamples = replayCaptures.flatMap((capture, index) => capture.samples.slice(WARMUP_ROUNDS + ROUNDS).map(sample => {
          assert.equal(typeof sample.durableAckMs, 'number');
          assert.equal(typeof sample.acknowledgementSavedMs, 'number');
          assert(sample.acknowledgementSavedMs! >= sample.durableAckMs!, 'Replay receipt commit must follow its durable ACK');
          return { localCommitMs: sample.localCommitMs!,
            reconnectAckMs: sample.start + sample.durableAckMs! - reconnectMarkers[index]!,
            reconnectStoredAckMs: sample.start + sample.acknowledgementSavedMs! - reconnectMarkers[index]! };
        }));
        assert(replaySamples.every(sample => sample.reconnectAckMs >= 0 && sample.reconnectStoredAckMs >= 0));
        await idleQueueMetrics();
        scenarios.push({ contentBytes, paragraphs: contentBytes / 1024, initialBinaryBytes: binary.byteLength, editors,
          editorReadyMs: captures.map(capture => capture.editorReadyMs), inputRounds: ROUNDS, statisticsMs: stats,
          queue: { admitted, completed: after.completed - before.completed,
            meanWaitMs: (after.waitMs - before.waitMs) / admitted,
            meanProcessingMs: (after.processingMs - before.processingMs) / admitted,
            failures: after.failures - before.failures, rejected: after.rejected - before.rejected,
            snapshotAttempts: after.snapshots.attempted - before.snapshots.attempted }, samples,
          memory: { beforeTyping, afterTyping, offlineBacklog, replayed },
          replay: { pendingBatches: originalBatches.length, pendingBytes: originalBatches.reduce((sum, record) => sum + record.bytes.length, 0),
            offlineRoundsPerEditor: OFFLINE_ROUNDS, allSavedWallMs,
            statisticsMs: Object.fromEntries(['localCommitMs', 'reconnectAckMs', 'reconnectStoredAckMs'].map(metric =>
              [metric, distribution(replaySamples.map(sample => sample[metric as keyof typeof sample]))])),
            checks: { originalIdsAndBytesRetained: true, oneMatchingReceiptPerBatch: true, pendingClearedOnlyAfterAcknowledgement: true,
              exactSequenceIncrease: true, browserAndPostgresConvergence: true }, samples: replaySamples } });
        console.log(`Measured ${contentBytes / 1024} KiB / ${editors} editor(s), ${samples.length} paced inputs and ${originalBatches.length} verified offline replay batches.`);
      } finally { await Promise.all(contexts.map(context => context.close())); }
    }
    measurementPhase = 'production asset integrity check';
    assert.equal(await treeDigest(['apps/web/dist']), assetsDigest, 'Production assets changed during measurement; rerun against one build');
    measurementPhase = 'measurement output';
    const output = { measuredAt: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceDigest, sourceUnchangedDuringMeasurement: await treeDigest(sourceDirectories) === sourceDigest, assetsDigest,
      versions: { node: process.version, chromium: browser.version(), database: (await pool.query('SHOW server_version')).rows[0].server_version,
        document: DOCUMENT_SCHEMA_VERSION, databaseSchema: DATABASE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION },
      machine: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length, ramBytes: os.totalmem() },
      conditions: { headless: true, viewport: '1280x900', network: 'same-host loopback; no delay/loss/throttle injected',
        server: 'in-process Fastify with PostgreSQL over loopback; production web assets; actual Better Auth sessions',
        typing: 'one ASCII insertion per editor per round; editors issued concurrently; wait for all durable saves between rounds',
        replay: 'ten actual offline inputs per editor, each awaited local commit; simultaneous network restoration; exact original receipts/bytes and document convergence checked',
        memory: 'CDP Performance.getMetrics V8 heap per page and runner process.memoryUsage snapshots; no forced GC; neither browser total RSS nor peak/leak measurement',
        warmupRounds: WARMUP_ROUNDS, noteShape: 'plain paragraphs of 1024 ASCII characters; fresh page history and browser contexts' }, scenarios };
    await mkdir('.artifacts/performance', { recursive: true });
    const filename = `.artifacts/performance/${output.measuredAt.replaceAll(':', '-')}.json`;
    await writeFile(filename, JSON.stringify(output, null, 2) + '\n');
    console.log(`Saved synthetic measurements to ${filename}`);
  } finally {
    measurementPhase = `${measurementPhase}; resource cleanup`;
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally {
        try { await pool.end(); }
        finally {
          // Drop only the uniquely named database created by this run; no FORCE/termination.
          try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
          finally { await admin.end(); }
        }
      }
    }
  }
}

await run().catch(() => {
  // Driver and browser exceptions can contain source content or session URLs.
  console.error(`Local performance measurement failed during ${measurementPhase}; no successful measurement is claimed.`);
  process.exitCode = 1;
});
