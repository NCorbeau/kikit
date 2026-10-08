import { randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, MAX_DOCUMENT_BYTES, MAX_UPDATE_BYTES, MAX_WIRE_BYTES, PROTOCOL_VERSION,
  decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { createSeed } from './document.js';
import { loadPage, migrateDatabase } from './persistence.js';
import { SyncRooms } from './sync-room.js';
import { attachSyncConnection } from './sync-connection.js';
import { TestFaults } from './test-faults.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;

// Real TCP sockets, document queues and PostgreSQL. Temporary schema per case;
// no HTTP auth substitute is installed in the application or public fixtures.
describe.skipIf(!databaseUrl)('bounded WebSocket pressure and recovery', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool;
  let schema: string;
  let pageId: string;
  let seed: Uint8Array;
  let rooms: SyncRooms;
  let server: WebSocketServer;
  const clients = new Set<WebSocket>();
  const serverSockets: WebSocket[] = [];

  beforeEach(async () => {
    schema = `socket_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateDatabase(pool);
    pageId = randomUUID(); seed = createSeed('Socket fixture', 'Original.');
    await pool.query('INSERT INTO pages(id,owner_id,schema_version,initial_state) VALUES($1,$2,$3,$4)',
      [pageId, DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, Buffer.from(seed)]);
    await pool.query("INSERT INTO page_grants VALUES($1,$2,'owner')", [pageId, DEV_ACCOUNT_ID]);
    rooms = new SyncRooms(pool, new TestFaults());
    serverSockets.length = 0;
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_WIRE_BYTES });
    server.on('connection', socket => {
      serverSockets.push(socket);
      attachSyncConnection(socket, rooms, () => undefined, { accountId: DEV_ACCOUNT_ID });
    });
    await new Promise<void>(resolve => server.once('listening', resolve));
  });
  afterEach(async () => {
    for (const client of clients) client.terminate(); clients.clear();
    for (const socket of serverSockets) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rooms.queues.drain(); rooms.destroy();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  afterAll(async () => { await admin.end(); });

  async function connect() {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No socket address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); clients.add(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', pageId, accountId: DEV_ACCOUNT_ID,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION }));
    await vi.waitFor(() => expect(messages[0]?.type).toBe('sync'));
    return { socket, messages };
  }

  function acknowledged(messages: ServerMessage[], batchId: string) {
    return messages.find(message => message.type === 'ack' && message.batchId === batchId);
  }
  function send(socket: WebSocket, batchId: string, update: Uint8Array) {
    socket.send(JSON.stringify({ type: 'update', batchId, update: encodeUpdate(update) }));
  }

  it('rejects excess socket batches without receipts, keeps peer order, and retries the original identities', async () => {
    const author = await connect(); const peer = await connect();
    await vi.waitFor(() => expect(rooms.queues.metrics.pendingCount).toBe(0));
    const blocker = await pool.connect();
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [pageId]);
    const batches = Array.from({ length: 70 }, (_, index) => {
      const doc = new Y.Doc(); Y.applyUpdate(doc, seed); const vector = Y.encodeStateVector(doc);
      ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, `Batch ${index}. `);
      const update = Y.encodeStateAsUpdate(doc, vector); doc.destroy();
      return { batchId: randomUUID(), update };
    });
    try {
      for (const batch of batches) send(author.socket, batch.batchId, batch.update);
      await vi.waitFor(() => expect(rooms.queues.metrics.rejected).toBe(6));
      expect(rooms.queues.metrics.pendingCount).toBe(64);
      await vi.waitFor(() => expect(author.messages.filter(message => message.type === 'error')).toHaveLength(6));
      const rejected = author.messages.filter(message => message.type === 'error');
      for (const message of rejected) expect(message).toMatchObject({ type: 'error', code: 'OVERLOADED', retryable: true });
      expect((await pool.query('SELECT count(*)::int AS count FROM receipts')).rows[0].count).toBe(0);
      await blocker.query('COMMIT');
      await vi.waitFor(() => expect(author.messages.filter(message => message.type === 'ack')).toHaveLength(64), { timeout: 5_000 });
      await vi.waitFor(() => expect(peer.messages.filter(message => message.type === 'committed')).toHaveLength(64));
      for (const failure of rejected) {
        const batch = batches.find(item => item.batchId === (failure.type === 'error' ? failure.batchId : undefined));
        expect(batch).toBeDefined();
        send(author.socket, batch!.batchId, batch!.update);
        await vi.waitFor(() => expect(acknowledged(author.messages, batch!.batchId)).toBeDefined());
      }
      await vi.waitFor(() => expect(peer.messages.filter(message => message.type === 'committed')).toHaveLength(70));
      expect(peer.messages.flatMap(message => message.type === 'committed' ? [message.sequence] : [])).toEqual(
        Array.from({ length: 70 }, (_, index) => index + 1),
      );
      const receiptIds = (await pool.query('SELECT batch_id FROM receipts')).rows.map(row => row.batch_id).sort();
      expect(receiptIds).toEqual(batches.map(batch => batch.batchId).sort());
      expect((await pool.query('SELECT count(*)::int AS count FROM document_updates')).rows[0].count).toBe(70);
      const reconstructed = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
      const received = new Y.Doc();
      for (const message of peer.messages) if (message.type === 'sync' || message.type === 'committed') Y.applyUpdate(received, decodeUpdate(message.update));
      expect(Y.encodeStateAsUpdate(received)).toEqual(Y.encodeStateAsUpdate(reconstructed.doc));
      received.destroy(); reconstructed.doc.destroy();
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });

  it('bounds a paused recipient while healthy peers commit in order and reconnect obtains final state', async () => {
    const author = await connect(); const healthy = await connect(); const slow = await connect();
    const slowServer = serverSockets[2]!;
    slow.socket.pause();
    const doc = new Y.Doc(); Y.applyUpdate(doc, seed);
    const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const batchIds: string[] = [];
    // Deleted text is GC'd by the live room. Large historical snapshots may
    // safely fail their existing guard; no document or socket limit is changed.
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 48; index++) {
        const vector = Y.encodeStateVector(doc);
        doc.transact(() => { text.delete(0, text.length); text.insert(0, `${index}:` + 'x'.repeat(192 * 1024)); });
        const update = Y.encodeStateAsUpdate(doc, vector); const batchId = randomUUID(); batchIds.push(batchId);
        expect(update.byteLength).toBeLessThan(MAX_UPDATE_BYTES);
        expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(MAX_DOCUMENT_BYTES);
        send(author.socket, batchId, update);
        await vi.waitFor(() => expect(acknowledged(author.messages, batchId)).toBeDefined(), { interval: 5, timeout: 5_000 });
      }
      expect(slowServer.readyState).toBe(WebSocket.CLOSING);
      expect(slowServer.bufferedAmount).toBeLessThanOrEqual(4 * 1024 * 1024 + 256);
      await vi.waitFor(() => expect(healthy.messages.filter(message => message.type === 'committed')).toHaveLength(48));
      expect(healthy.messages.flatMap(message => message.type === 'committed' ? [message.sequence] : [])).toEqual(
        Array.from({ length: 48 }, (_, index) => index + 1),
      );
      const closed = new Promise<number>(resolve => slow.socket.once('close', code => resolve(code)));
      slow.socket.resume(); expect(await closed).toBe(1013);
      const retry = await connect();
      const hydration = retry.messages[0]!;
      expect(hydration).toMatchObject({ type: 'sync', sequence: 48 });
      const recovered = new Y.Doc();
      if (hydration.type !== 'sync') throw new Error('Expected committed hydration');
      Y.applyUpdate(recovered, decodeUpdate(hydration.update));
      expect(Y.encodeStateAsUpdate(recovered)).toEqual(Y.encodeStateAsUpdate(doc)); recovered.destroy();
      expect((await pool.query('SELECT batch_id FROM receipts')).rows.map(row => row.batch_id).sort()).toEqual([...batchIds].sort());
      for (const [warning] of warnings.mock.calls) expect(warning).toBe('Document compaction failed; committed state and receipts are retained.');
    } finally { warnings.mockRestore(); doc.destroy(); }
  }, 30_000);
});
