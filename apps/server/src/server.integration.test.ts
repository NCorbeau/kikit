import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { AccessError, ReceiptConflict, commitUpdate, createPool, loadPage, migrateDatabase } from './persistence.js';
import { createSeed } from './document.js';
import { createServer } from './app.js';

// Opt-in real PostgreSQL tests; each test owns a unique page, never truncates fixtures.
const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL and WebSocket durable flow', () => {
  const pool = createPool(databaseUrl!);
  let pageId: string;
  let seed: Uint8Array;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    vi.stubEnv('KIKIT_TEST_FAULTS', '1');
    await migrateDatabase(pool);
  });

  beforeEach(async () => {
    pageId = randomUUID();
    seed = createSeed();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO pages(id,owner_id,schema_version,initial_state) VALUES($1,$2,$3,$4)', [pageId, DEV_ACCOUNT_ID, DOCUMENT_SCHEMA_VERSION, Buffer.from(seed)]);
      await client.query("INSERT INTO page_grants VALUES($1,$2,'owner')", [pageId, DEV_ACCOUNT_ID]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await pool.query('DELETE FROM receipts WHERE page_id=$1', [pageId]);
    await pool.query('DELETE FROM document_updates WHERE page_id=$1', [pageId]);
    await pool.query('DELETE FROM page_grants WHERE page_id=$1', [pageId]);
    await pool.query('DELETE FROM pages WHERE id=$1', [pageId]);
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function edit(value: string) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seed);
    const vector = Y.encodeStateVector(doc);
    ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, value);
    const update = Y.encodeStateAsUpdate(doc, vector);
    doc.destroy();
    return update;
  }

  it('commits bytes and receipts atomically; retries preserve sequence and reject reused identities', async () => {
    const batchId = randomUUID();
    const update = edit('Saved ');
    await expect(commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update, {
      beforeCommit: async () => {
        throw new Error('database failed');
      }
    })).rejects.toThrow('database failed');
    expect((await pool.query('SELECT * FROM receipts WHERE page_id=$1', [pageId])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM document_updates WHERE page_id=$1', [pageId])).rowCount).toBe(0);
    expect(await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: false });
    expect(await commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, update)).toEqual({ sequence: 1, duplicate: true });
    await expect(commitUpdate(pool, pageId, DEV_ACCOUNT_ID, batchId, edit('Different '))).rejects.toBeInstanceOf(ReceiptConflict);
    const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
    expect(loaded.sequence).toBe(1);
    expect(loaded.doc.getXmlFragment('body').toString()).toContain('Saved ');
    loaded.doc.destroy();
    await expect(loadPage(pool, pageId, 'other-account')).rejects.toBeInstanceOf(AccessError);
    await expect(commitUpdate(pool, pageId, 'other-account', randomUUID(), update)).rejects.toBeInstanceOf(AccessError);
  });

  it('serializes concurrent database commits behind the page row lock', async () => {
    const results = await Promise.all([commitUpdate(pool, pageId, DEV_ACCOUNT_ID, randomUUID(), edit('One ')), commitUpdate(pool, pageId, DEV_ACCOUNT_ID, randomUUID(), edit('Two '))]);
    expect(results.map(result => result.sequence).sort()).toEqual([1, 2]);
    const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
    expect(loaded.doc.getXmlFragment('body').toString()).toContain('One ');
    expect(loaded.doc.getXmlFragment('body').toString()).toContain('Two ');
    loaded.doc.destroy();
  });

  function inbox(socket: WebSocket) {
    const messages: ServerMessage[] = [];
    const waiters: ((message: ServerMessage) => void)[] = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(message); else messages.push(message);
    });
    return async () => {
      if (messages.length) return messages.shift()!;
      return new Promise<ServerMessage>(resolve => waiters.push(resolve));
    };
  }

  async function connect() {
    const address = app!.server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync`, { origin: 'http://127.0.0.1:5173' });
    const next = inbox(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello',
      pageId,
      accountId: DEV_ACCOUNT_ID,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION
    }));
    expect((await next()).type).toBe('sync');
    return { socket, next };
  }

  it('commits an empty-body repair atomically and replays its original bytes under the client payload hash', async () => {
    const base = new Y.Doc();
    Y.applyUpdate(base, seed);
    const second = new Y.XmlElement('paragraph');
    second.setAttribute('id', 'second');
    base.getXmlFragment('body').insert(1, [second]);
    seed = Y.encodeStateAsUpdate(base);
    await pool.query('UPDATE pages SET initial_state=$2 WHERE id=$1', [pageId, Buffer.from(seed)]);
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, seed);
    Y.applyUpdate(b, seed);
    const vector = Y.encodeStateVector(base);
    a.getXmlFragment('body').delete(0, 1);
    b.getXmlFragment('body').delete(1, 1);
    const firstUpdate = Y.encodeStateAsUpdate(a, vector);
    const lastUpdate = Y.encodeStateAsUpdate(b, vector);
    app = await createServer({ databaseUrl });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const first = await connect();
    const last = await connect();
    try {
      first.socket.send(JSON.stringify({
        type: 'update',
        batchId: randomUUID(),
        update: encodeUpdate(firstUpdate)
      }));
      expect(await first.next()).toMatchObject({ type: 'ack', sequence: 1 });
      expect(await last.next()).toMatchObject({ type: 'committed', sequence: 1 });
      const batchId = randomUUID();
      last.socket.send(JSON.stringify({
        type: 'update',
        batchId,
        update: encodeUpdate(lastUpdate)
      }));
      const repaired = await last.next();
      expect(repaired).toMatchObject({ type: 'committed', sequence: 2 });
      expect(await last.next()).toEqual({
        type: 'ack',
        batchId,
        sequence: 2
      });
      expect(await first.next()).toEqual(repaired);
      const stored = await pool.query(`SELECT r.payload_hash, u.payload FROM receipts r
        JOIN document_updates u ON u.page_id=r.page_id AND u.sequence=r.sequence
        WHERE r.page_id=$1 AND r.batch_id=$2`, [pageId, batchId]);
      expect(stored.rows[0].payload_hash).toBe(createHash('sha256').update(lastUpdate).digest('hex'));
      expect(repaired.type === 'committed' && Buffer.from(decodeUpdate(repaired.update)).equals(stored.rows[0].payload)).toBe(true);
      // Even without reconnecting, a duplicate must return the same repair and
      // original receipt, without inserting another paragraph or sequence.
      last.socket.send(JSON.stringify({
        type: 'update',
        batchId,
        update: encodeUpdate(lastUpdate)
      }));
      expect(await last.next()).toEqual(repaired);
      expect(await last.next()).toEqual({
        type: 'ack',
        batchId,
        sequence: 2
      });
      const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
      expect(loaded.sequence).toBe(2);
      expect(loaded.doc.getXmlFragment('body').length).toBe(1);
      expect((loaded.doc.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id')).toBeTruthy();
      loaded.doc.destroy();
      last.socket.send(JSON.stringify({
        type: 'update',
        batchId,
        update: encodeUpdate(firstUpdate)
      }));
      expect(await last.next()).toMatchObject({
        type: 'error',
        code: 'BATCH_CONFLICT',
        retryable: false
      });
    } finally {
      first.socket.close();
      last.socket.close();
      base.destroy();
      a.destroy();
      b.destroy();
    }
  });

  it('survives termination of its own idle PostgreSQL connection and reconnects for subsequent commits', async () => {
    const taggedUrl = new URL(databaseUrl!);
    const applicationName = `kikit-idle-error-test-${randomUUID()}`;
    taggedUrl.searchParams.set('application_name', applicationName);
    app = await createServer({ databaseUrl: taggedUrl.toString() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const first = await connect();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const idle = await pool.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle'", [applicationName]);
      expect(idle.rows).toHaveLength(1);
      expect((await pool.query('SELECT pg_terminate_backend($1) AS terminated', [idle.rows[0].pid])).rows[0].terminated).toBe(true);
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('PostgreSQL idle connection failed; the pool will reconnect on demand.'));
      const retry = await connect();
      try {
        const batchId = randomUUID();
        retry.socket.send(JSON.stringify({
          type: 'update',
          batchId,
          update: encodeUpdate(edit('After reconnect '))
        }));
        expect(await retry.next()).toEqual({
          type: 'ack',
          batchId,
          sequence: 1
        });
        const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
        expect(loaded.doc.getXmlFragment('body').toString()).toContain('After reconnect ');
        loaded.doc.destroy();
      } finally {
        retry.socket.close();
      }
    } finally {
      warning.mockRestore();
      first.socket.close();
    }
  });

  it('resolves an acknowledgement lost after COMMIT through the original receipt on reconnect', async () => {
    app = await createServer({ databaseUrl });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const first = await connect();
    const batchId = randomUUID();
    const update = edit('Durable ');
    await app.inject({
      method: 'POST',
      url: '/api/test/faults',
      payload: { dropNextAck: true }
    });
    const closed = new Promise<void>(resolve => first.socket.once('close', () => resolve()));
    first.socket.send(JSON.stringify({
      type: 'update',
      batchId,
      update: encodeUpdate(update)
    }));
    await closed;
    expect((await pool.query('SELECT * FROM receipts WHERE page_id=$1 AND batch_id=$2', [pageId, batchId])).rowCount).toBe(1);
    const retry = await connect();
    retry.socket.send(JSON.stringify({
      type: 'update',
      batchId,
      update: encodeUpdate(update)
    }));
    expect(await retry.next()).toEqual({
      type: 'ack',
      batchId,
      sequence: 1
    });
    expect((await pool.query('SELECT * FROM document_updates WHERE page_id=$1', [pageId])).rowCount).toBe(1);
    retry.socket.close();
  });

  it('invalidates every live peer after an uncertain COMMIT and reloads before another edit', async () => {
    app = await createServer({ databaseUrl });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const first = await connect();
    const peer = await connect();
    const firstClosed = new Promise<void>(resolve => first.socket.once('close', () => resolve()));
    const peerClosed = new Promise<void>(resolve => peer.socket.once('close', () => resolve()));
    const firstBatch = randomUUID();
    const firstUpdate = edit('Unknown outcome ');
    await app.inject({
      method: 'POST',
      url: '/api/test/faults',
      payload: { postCommitError: true }
    });
    first.socket.send(JSON.stringify({
      type: 'update',
      batchId: firstBatch,
      update: encodeUpdate(firstUpdate)
    }));
    expect(await first.next()).toMatchObject({
      type: 'error',
      code: 'STORAGE_UNAVAILABLE',
      retryable: true
    });
    await Promise.all([firstClosed, peerClosed]);
    const retry = await connect();
    retry.socket.send(JSON.stringify({
      type: 'update',
      batchId: firstBatch,
      update: encodeUpdate(firstUpdate)
    }));
    expect(await retry.next()).toEqual({
      type: 'ack',
      batchId: firstBatch,
      sequence: 1
    });
    const secondBatch = randomUUID();
    retry.socket.send(JSON.stringify({
      type: 'update',
      batchId: secondBatch,
      update: encodeUpdate(edit('Independent peer '))
    }));
    expect(await retry.next()).toEqual({
      type: 'ack',
      batchId: secondBatch,
      sequence: 2
    });
    const loaded = await loadPage(pool, pageId, DEV_ACCOUNT_ID);
    expect(loaded.doc.getXmlFragment('body').toString()).toContain('Unknown outcome ');
    expect(loaded.doc.getXmlFragment('body').toString()).toContain('Independent peer ');
    loaded.doc.destroy();
    retry.socket.close();
  });

  it('checks origin and versions and rejects unsupported content without a receipt', async () => {
    app = await createServer({ databaseUrl });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = await connect();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seed);
    const vector = Y.encodeStateVector(doc);
    ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).format(0, 1, { bold: true });
    client.socket.send(JSON.stringify({
      type: 'update',
      batchId: randomUUID(),
      update: encodeUpdate(Y.encodeStateAsUpdate(doc, vector))
    }));
    doc.destroy();
    expect(await client.next()).toMatchObject({
      type: 'error',
      code: 'INVALID_DOCUMENT',
      retryable: false
    });
    expect((await pool.query('SELECT * FROM receipts WHERE page_id=$1', [pageId])).rowCount).toBe(0);
    expect((await app.inject({
      method: 'GET',
      url: '/api/sync',
      headers: { origin: 'https://hostile.example' }
    })).statusCode).toBe(403);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync`, { origin: 'http://127.0.0.1:5173' });
    const next = inbox(socket);
    await new Promise<void>(resolve => socket.once('open', resolve));
    socket.send(JSON.stringify({
      type: 'hello',
      pageId,
      protocolVersion: 999,
      schemaVersion: DOCUMENT_SCHEMA_VERSION
    }));
    expect(await next()).toMatchObject({
      type: 'error',
      code: 'INCOMPATIBLE',
      retryable: false
    });
  });
});
