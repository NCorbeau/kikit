import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ClientMessage, type ServerMessage } from '@kikit/contracts';
import { createDocumentSession, type DocumentSession, type SessionDependencies } from './index';
import { CacheCompatibilityError, LocalStore, type DocumentStore, type StoredDocument, type StoredUpdate } from './local-store';

type Callbacks = Parameters<NonNullable<SessionDependencies['transport']>>[0];

class FakeTransport {
  sent: ClientMessage[] = [];
  starts = 0;
  retries = 0;
  reconnects = 0;
  constructor(readonly callbacks: Callbacks) { }
  start() {
    this.starts++;
    this.callbacks.connection('offline');
  }
  retry() {
    this.retries++;
    this.callbacks.connection('connecting');
  }
  reconnect() {
    this.reconnects++;
    this.callbacks.connection('offline');
  }
  stopWithError() {
    this.callbacks.connection('error');
  }
  send(message: ClientMessage) {
    this.sent.push(message);
    return true;
  }
  destroy() { }
  message(message: ServerMessage) {
    return this.callbacks.message(message);
  }
}

class MemoryStore implements DocumentStore {
  records: StoredUpdate[] = [];
  initialized = false;
  saveError = false;
  ackError = false;
  gate?: Promise<void>;
  async load(): Promise<StoredDocument> {
    return { initialized: this.initialized, updates: this.records };
  }
  async append(record: StoredUpdate, initialized = false) {
    await this.gate;
    if (this.saveError) throw new Error('Device storage failed.');
    if (!this.records.some(saved => saved.id === record.id)) this.records.push(record);
    this.initialized ||= initialized;
  }
  async acknowledge(id: string) {
    if (this.ackError) throw new Error('Device receipt storage failed.');
    this.records = this.records.map(record => record.id === id ? { ...record, pending: false } : record);
  }
  close() { }
}
const sessions: DocumentSession[] = [];
let browserWindow: EventTarget;
let serverDoc: Y.Doc;

beforeEach(() => {
  browserWindow = new EventTarget();
  serverDoc = initializedDoc();
  vi.stubGlobal('window', browserWindow);
});

afterEach(() => {
  for (const value of sessions.splice(0)) value.destroy();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function harness(store: DocumentStore = new MemoryStore()) {
  let transport!: FakeTransport;
  const session = createDocumentSession({ store, transport: callbacks => (transport = new FakeTransport(callbacks)) });
  sessions.push(session);
  return {
    session,
    transport,
    store
  };
}

function initializedDoc(text = 'Server title') {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph'), content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  doc.getXmlFragment('title').insert(0, [paragraph]);
  const body = new Y.XmlElement('paragraph');
  body.setAttribute('id', 'server-block');
  doc.getXmlFragment('body').insert(0, [body]);
  return doc;
}

function title(doc: Y.Doc) {
  return (doc.getXmlFragment('title').get(0) as Y.XmlElement).get(0) as Y.XmlText;
}

function sync(doc: Y.Doc = serverDoc): ServerMessage {
  return {
    type: 'sync',
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    update: encodeUpdate(Y.encodeStateAsUpdate(doc)),
    sequence: 0
  };
}

async function settled(session: DocumentSession) {
  await vi.waitFor(() => expect(session.getSnapshot().local).not.toBe('saving'));
}

function outbound(transport: FakeTransport) {
  return transport.sent.filter(message => message.type === 'update');
}

describe('document sessions', () => {

  it('hydrates a cached page before transport and does not initialize a new offline page', async () => {
    const cache = new MemoryStore(), doc = initializedDoc('Cached title');
    cache.initialized = true;
    cache.records.push({
      id: 'cache',
      pending: false,
      update: Y.encodeStateAsUpdate(doc)
    });
    const cached = harness(cache);
    await cached.session.start();
    expect(title(cached.session.doc).toString()).toBe('Cached title');
    expect(cached.session.getSnapshot()).toMatchObject({
      ready: true,
      editable: true,
      connection: 'offline',
      serverSaved: false
    });
    const empty = harness();
    await empty.session.start();
    expect(empty.session.getSnapshot().ready).toBe(false);
    expect(empty.session.doc.getXmlFragment('body').length).toBe(0);
    expect(empty.session.getSnapshot()).toBe(empty.session.getSnapshot());
  });

  it('never sends uncommitted local work and exports the in-memory draft after storage failure', async () => {
    const { session, transport, store } = harness();
    await session.start();
    await transport.message(sync());
    expect(session.getSnapshot().serverSaved).toBe(true);
    const memory = store as MemoryStore;
    let release!: () => void;
    memory.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    memory.saveError = true;
    title(session.doc).insert(0, 'Local ');
    const before = JSON.parse(session.exportRecovery());
    expect(session.getSnapshot()).toMatchObject({
      local: 'saving',
      pending: 1,
      serverSaved: false
    });
    expect(outbound(transport)).toHaveLength(0);
    const leaving = new Event('beforeunload', { cancelable: true });
    browserWindow.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    release();
    await settled(session);
    expect(session.getSnapshot()).toMatchObject({
      local: 'error',
      pending: 1,
      serverSaved: false
    });
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, decodeUpdate(before.update));
    expect(title(recovered).toString()).toBe('Local Server title');
    memory.saveError = false;
    memory.gate = undefined;
    session.retry();
    await vi.waitFor(() => expect(transport.retries).toBe(1));
    await transport.message(sync());
    expect(outbound(transport)).toEqual([{
      type: 'update',
      batchId: before.pending[0].batchId,
      update: before.pending[0].update
    }]);
  });

  it('resends identical persisted batches after a lost acknowledgement and reload, clearing only pending state', async () => {
    const factory = new IDBFactory();
    const first = harness(new LocalStore('account', 'page', factory));
    await first.session.start();
    await first.transport.message(sync());
    title(first.session.doc).insert(0, 'Offline ');
    await settled(first.session);
    const batch = outbound(first.transport)[0];
    first.transport.reconnect();
    await first.transport.message(sync());
    expect(outbound(first.transport)).toEqual([batch, batch]);
    first.session.destroy();
    const reloaded = harness(new LocalStore('account', 'page', factory));
    await reloaded.session.start();
    expect(title(reloaded.session.doc).toString()).toBe('Offline Server title');
    await reloaded.transport.message(sync());
    expect(outbound(reloaded.transport)).toEqual([batch]);
    await reloaded.transport.message({
      type: 'ack',
      batchId: batch.batchId,
      sequence: 1
    });
    expect(reloaded.session.getSnapshot()).toMatchObject({ pending: 0, serverSaved: true });
    const history = await new LocalStore('account', 'page', factory).load();
    expect(history.updates.find(record => record.id === batch.batchId)).toMatchObject({ pending: false, update: decodeUpdate(batch.update) });
  });

  it('replays causal updates one receipt at a time rather than sorting random UUIDs', async () => {
    const factory = new IDBFactory(), store = new LocalStore('account', 'ordered', factory), doc = initializedDoc();
    await store.append({
      id: 'seed',
      update: Y.encodeStateAsUpdate(doc),
      pending: false
    }, true);
    const ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000001'];
    const changes: Uint8Array[] = [];
    doc.on('update', update => changes.push(update));
    title(doc).insert(0, 'First ');
    title(doc).insert(0, 'Second ');
    for (let index = 0; index < ids.length; index++) await store.append({
      id: ids[index],
      update: changes[index],
      pending: true
    });
    const { session, transport } = harness(store);
    await session.start();
    await transport.message(sync());
    expect(outbound(transport).map(batch => batch.batchId)).toEqual([ids[0]]);
    await transport.message({
      type: 'ack',
      batchId: ids[0],
      sequence: 1
    });
    expect(outbound(transport).map(batch => batch.batchId)).toEqual(ids);
    expect(session.getSnapshot().serverSaved).toBe(false);
    await transport.message({
      type: 'ack',
      batchId: ids[1],
      sequence: 2
    });
    expect(session.getSnapshot().serverSaved).toBe(true);
  });

  it('retains pending work on database failure and on failure to persist a receipt', async () => {
    const { session, transport, store } = harness();
    await session.start();
    await transport.message(sync());
    title(session.doc).insert(0, 'Draft ');
    await settled(session);
    const batch = outbound(transport)[0];
    await transport.message({
      type: 'error',
      code: 'DATABASE_UNAVAILABLE',
      message: 'Server save failed.',
      retryable: true,
      batchId: batch.batchId
    });
    expect(session.getSnapshot()).toMatchObject({
      pending: 1,
      editable: true,
      serverSaved: false
    });
    await transport.message(sync());
    (store as MemoryStore).ackError = true;
    await transport.message({
      type: 'ack',
      batchId: batch.batchId,
      sequence: 1
    });
    expect(session.getSnapshot()).toMatchObject({
      pending: 1,
      local: 'error',
      serverSaved: false
    });
    (store as MemoryStore).ackError = false;
    session.retry();
    await vi.waitFor(() => expect(transport.retries).toBe(1));
    await transport.message(sync());
    expect(outbound(transport).every(message => message.batchId === batch.batchId && message.update === batch.update)).toBe(true);
    await transport.message({
      type: 'ack',
      batchId: batch.batchId,
      sequence: 1
    });
    expect(session.getSnapshot()).toMatchObject({ pending: 0, serverSaved: true });
  });

  it('keeps a failed append actionable when an earlier batch receives its receipt', async () => {
    const { session, transport, store } = harness();
    await session.start();
    await transport.message(sync());
    title(session.doc).insert(0, 'First ');
    await settled(session);
    const first = outbound(transport)[0];
    (store as MemoryStore).saveError = true;
    title(session.doc).insert(0, 'Second ');
    await settled(session);
    await transport.message({
      type: 'ack',
      batchId: first.batchId,
      sequence: 1
    });
    expect(session.getSnapshot()).toMatchObject({
      local: 'error',
      pending: 1,
      error: 'Device storage failed.',
      serverSaved: false
    });
    expect(JSON.parse(session.exportRecovery()).pending).toHaveLength(1);
    expect(outbound(transport)).toHaveLength(1);
    (store as MemoryStore).saveError = false;
    session.retry();
    await vi.waitFor(() => expect(transport.retries).toBe(1));
    await transport.message(sync());
    expect(outbound(transport)).toHaveLength(2);
    expect(outbound(transport)[1].batchId).not.toBe(first.batchId);
  });

  it('locks terminal access failures through retry until authorized sync, retaining the recovery journal', async () => {
    const { session, transport } = harness();
    await session.start();
    await transport.message(sync());
    title(session.doc).insert(0, 'Recovery ');
    await settled(session);
    await transport.message({
      type: 'error',
      code: 'ACCESS_DENIED',
      message: 'Access was removed.',
      retryable: false
    });
    expect(session.getSnapshot()).toMatchObject({
      ready: true,
      editable: false,
      pending: 1,
      serverSaved: false
    });
    expect(JSON.parse(session.exportRecovery()).pending).toHaveLength(1);
    session.retry();
    await vi.waitFor(() => expect(transport.retries).toBe(1));
    expect(session.getSnapshot().editable).toBe(false);
    await transport.message(sync());
    expect(session.getSnapshot().editable).toBe(true);
  });

  it('resumes cached editing after canceling an offline departure but keeps terminal denial locked', async () => {
    const { session, transport } = harness();
    await session.start(); await transport.message(sync());
    transport.callbacks.connection('offline');
    await session.pause();
    expect(session.getSnapshot().editable).toBe(false);
    session.retry();
    await vi.waitFor(() => expect(transport.retries).toBe(1));
    transport.callbacks.connection('offline');
    expect(session.getSnapshot()).toMatchObject({ editable: true, connection: 'offline', serverSaved: false });
    title(session.doc).insert(0, 'Continued offline '); await settled(session);
    expect(JSON.parse(session.exportRecovery()).pending).toHaveLength(1);
    await transport.message({ type: 'error', code: 'ACCESS_DENIED', message: 'Access was removed.', retryable: false });
    await session.pause();
    session.retry();
    await vi.waitFor(() => expect(transport.retries).toBe(2));
    expect(session.getSnapshot().editable).toBe(false);
    expect(JSON.parse(session.exportRecovery()).pending).toHaveLength(1);
  });

  it('rejects incompatible server state before applying it and can export an incompatible cache untouched', async () => {
    const { session, transport } = harness();
    await session.start();
    await transport.message(sync());
    await transport.message({ ...sync(initializedDoc('Unsupported title')), schemaVersion: 99 } as ServerMessage);
    expect(session.getSnapshot()).toMatchObject({ editable: false, serverSaved: false });
    expect(title(session.doc).toString()).toBe('Server title');
    const record = {
      id: 'future',
      pending: true,
      update: Y.encodeStateAsUpdate(initializedDoc('Future cache'))
    };
    const store = new MemoryStore();
    store.load = () => Promise.reject(new CacheCompatibilityError({ initialized: true, updates: [record] }));
    const cached = harness(store);
    await cached.session.start();
    expect(cached.session.getSnapshot()).toMatchObject({
      ready: false,
      editable: false,
      connection: 'error'
    });
    expect(cached.transport.starts).toBe(0);
    expect(JSON.parse(cached.session.exportRecovery()).cachedUpdates).toEqual([{
      batchId: record.id,
      pending: true,
      update: encodeUpdate(record.update)
    }]);
  });

  it('keeps a disconnected handshake offline when local persistence completes later', async () => {
    const { session, transport, store } = harness();
    await session.start();
    let release!: () => void;
    (store as MemoryStore).gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const receiving = transport.message(sync());
    transport.reconnect();
    release();
    await receiving;
    expect(session.getSnapshot()).toMatchObject({
      ready: true,
      connection: 'offline',
      serverSaved: false
    });
  });

  it('reconnects for missing receipts without inventing a successful save', async () => {
    vi.useFakeTimers();
    const { session, transport } = harness();
    await session.start();
    await transport.message(sync());
    title(session.doc).insert(0, 'Unconfirmed ');
    await vi.advanceTimersByTimeAsync(0);
    expect(outbound(transport)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.reconnects).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      pending: 1,
      serverSaved: false,
      connection: 'offline'
    });
  });

  it('disables fixture construction in production builds', () => {
    vi.stubEnv('PROD', true);
    expect(() => createDocumentSession()).toThrow('disabled in production');
  });
});
