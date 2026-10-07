import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, encodeUpdate, type ClientMessage, type ServerMessage } from '@kikit/contracts';
import { createDocumentSession, type DocumentSession, type SessionDependencies } from './index';
import { LocalStore, type StoredUpdate } from './local-store';
import { prepareCommittedUpdate } from '../../../server/src/document-candidate';
import { DependencyMissing } from '../../../server/src/sync-protocol';

type Callbacks = Parameters<NonNullable<SessionDependencies['transport']>>[0];
const identity = { accountId: 'recovery-account', pageId: '00000000-0000-4000-8000-000000000007' };
const sessions: DocumentSession[] = [];
const stores: LocalStore[] = [];
const docs: Y.Doc[] = [];

class RecoveryTransport {
  sent: ClientMessage[] = [];
  constructor(readonly callbacks: Callbacks) { }
  start() { this.callbacks.connection('offline'); }
  retry() { this.callbacks.connection('connecting'); }
  reconnect() { this.callbacks.connection('offline'); }
  stopWithError() { this.callbacks.connection('error'); }
  send(message: ClientMessage) { this.sent.push(message); return true; }
  destroy() { }
  message(message: ServerMessage) { return this.callbacks.message(message); }
}

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.destroy();
  for (const store of stores.splice(0)) store.close();
  for (const doc of docs.splice(0)) doc.destroy();
  vi.unstubAllGlobals();
});

function title(doc: Y.Doc): Y.XmlText {
  return (doc.getXmlFragment('title').get(0) as Y.XmlElement).get(0) as Y.XmlText;
}

function source() {
  const doc = new Y.Doc({ gc: false });
  docs.push(doc);
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Original title');
  paragraph.insert(0, [text]);
  doc.getXmlFragment('title').insert(0, [paragraph]);
  const body = new Y.XmlElement('paragraph');
  body.setAttribute('id', 'stable-original-block');
  doc.getXmlFragment('body').insert(0, [body]);
  const seed = Y.encodeStateAsUpdate(doc);
  const pending: StoredUpdate[] = [];
  doc.on('update', (update: Uint8Array) => pending.push({ id: randomUUID(), update, pending: true }));
  text.insert(text.length, ' recovered');
  text.insert(text.length, ' writing');
  return {
    doc, seed, pending,
    file: () => JSON.stringify({ format: 'kikit-recovery', formatVersion: 2,
      schemaVersion: DOCUMENT_SCHEMA_VERSION, protocolVersion: PROTOCOL_VERSION,
      ...identity, exportedAt: '2026-10-07T12:00:00.000Z',
      update: encodeUpdate(Y.encodeStateAsUpdate(doc)), cachedUpdates: [],
      pending: pending.map(record => ({ batchId: record.id, update: encodeUpdate(record.update) })),
    }),
  };
}

async function openSession(store: LocalStore) {
  let transport!: RecoveryTransport;
  const session = createDocumentSession({ identity, store,
    transport: callbacks => (transport = new RecoveryTransport(callbacks)) });
  sessions.push(session);
  await session.start();
  return { store, session, transport };
}

async function harness(seed: Uint8Array, records: StoredUpdate[] = []) {
  const factory = new IDBFactory();
  const store = new LocalStore(identity.accountId, identity.pageId, factory);
  stores.push(store);
  await store.append({ id: randomUUID(), update: seed, pending: false }, true);
  for (const record of records) await store.append(record);
  return { ...await openSession(store), factory };
}

function committedState(seed: Uint8Array, records: StoredUpdate[] = []): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, seed);
    for (const record of records) Y.applyUpdate(doc, record.update);
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

function outbound(transport: RecoveryTransport) {
  return transport.sent.filter(message => message.type === 'update');
}

describe('recovery import into the original document session', () => {
  it('commits exact original pending identities and bytes before changing the editor or sending', async () => {
    const recovery = source();
    const { session, store, transport } = await harness(recovery.seed);
    const file = recovery.file();
    await session.importRecovery(file, recovery.seed);
    const journal = await store.load();
    expect(journal.updates.filter(record => record.pending)).toEqual(recovery.pending);
    expect(title(session.doc).toString()).toBe('Original title recovered writing');
    expect((session.doc.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id')).toBe('stable-original-block');
    expect(session.getSnapshot()).toMatchObject({ ready: true, local: 'saved', pending: 2, serverSaved: false });
    expect(outbound(transport)).toEqual([]);
    await transport.message({ type: 'sync', update: encodeUpdate(recovery.seed), sequence: 0,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    expect(outbound(transport)).toEqual([{ type: 'update', batchId: recovery.pending[0].id,
      update: encodeUpdate(recovery.pending[0].update) }]);
    expect(file).toBe(recovery.file());
  });

  it('preserves an existing device draft while merging imported binary content', async () => {
    const recovery = source();
    const { session, store } = await harness(recovery.seed);
    title(session.doc).insert(0, 'Device draft ');
    await vi.waitFor(() => expect(session.getSnapshot().local).toBe('saved'));
    const draft = (await store.load()).updates.find(record => record.pending)!;
    await session.importRecovery(recovery.file(), recovery.seed);
    expect(title(session.doc).toString()).toBe('Device draft Original title recovered writing');
    expect((await store.load()).updates.find(record => record.id === draft.id)).toEqual(draft);
    expect(session.getSnapshot().pending).toBe(3);
  });

  it('does not requeue an imported identity already acknowledged in the local journal', async () => {
    const recovery = source();
    const acknowledged = { ...recovery.pending[0], pending: false };
    const { session, store } = await harness(recovery.seed, [acknowledged]);
    await session.importRecovery(recovery.file(), committedState(recovery.seed, [acknowledged]));
    const journal = await store.load();
    expect(journal.updates.find(record => record.id === acknowledged.id)).toEqual(acknowledged);
    expect(journal.updates.filter(record => record.pending)).toEqual([recovery.pending[1]]);
    expect(session.getSnapshot().pending).toBe(1);
    await session.importRecovery(recovery.file(), committedState(recovery.seed, [acknowledged]));
    expect((await store.load()).updates).toEqual(journal.updates);
  });

  it('does not create extra deletion-only batches when a deleted-history file is imported repeatedly', async () => {
    const recovery = source();
    title(recovery.doc).delete(0, 3);
    const { session, store, transport } = await harness(recovery.seed);
    const file = recovery.file();
    await session.importRecovery(file, recovery.seed);
    const first = await store.load();
    expect(first.updates.filter(record => record.pending)).toEqual(recovery.pending);
    await session.importRecovery(file, recovery.seed);
    expect((await store.load()).updates).toEqual(first.updates);
    await transport.message({ type: 'sync', update: encodeUpdate(recovery.seed), sequence: 0,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    for (let index = 0; index < recovery.pending.length; index++) {
      await transport.message({ type: 'ack', batchId: recovery.pending[index].id, sequence: index + 1 });
    }
    expect(session.getSnapshot().pending).toBe(0);
    const acknowledged = await store.load();
    await session.importRecovery(file, Y.encodeStateAsUpdate(recovery.doc));
    expect((await store.load()).updates).toEqual(acknowledged.updates);
    expect(session.getSnapshot().pending).toBe(0);
    expect(title(session.doc).toString()).toBe('ginal title recovered writing');
    expect(file).toBe(recovery.file());
  });

  it('rolls back earlier imported records when a later identity conflicts with a local receipt', async () => {
    const recovery = source();
    const conflicting = { id: recovery.pending[1].id, update: Uint8Array.from([0, 0]), pending: false };
    const { session, store, transport } = await harness(recovery.seed, [conflicting]);
    const before = await store.load();
    const editor = Y.encodeStateAsUpdate(session.doc);
    const file = recovery.file();
    await expect(session.importRecovery(file, recovery.seed)).rejects.toThrow('conflicts with this device');
    expect(await store.load()).toEqual(before);
    expect(Y.encodeStateAsUpdate(session.doc)).toEqual(editor);
    expect(outbound(transport)).toEqual([]);
    expect(file).toBe(recovery.file());
  });

  it('retains the editor, original journal and file when the whole IndexedDB import transaction aborts', async () => {
    const recovery = source();
    const { session, store, transport } = await harness(recovery.seed);
    title(session.doc).insert(0, 'Current draft ');
    await vi.waitFor(() => expect(session.getSnapshot().local).toBe('saved'));
    const before = await store.load();
    const editor = Y.encodeStateAsUpdate(session.doc);
    const file = recovery.file();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === 'metadata') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(session.importRecovery(file, recovery.seed)).rejects.toThrow();
    expect(await store.load()).toEqual(before);
    expect(Y.encodeStateAsUpdate(session.doc)).toEqual(editor);
    expect(session.getSnapshot().pending).toBe(1);
    expect(outbound(transport)).toEqual([]);
    expect(file).toBe(recovery.file());
  });

  it('rejects a cross-account file before pausing or changing the document', async () => {
    const recovery = source();
    const { session, store, transport } = await harness(recovery.seed);
    const file = JSON.stringify({ ...JSON.parse(recovery.file()), accountId: 'another-account' });
    const before = await store.load();
    const editor = Y.encodeStateAsUpdate(session.doc);
    await expect(session.importRecovery(file, recovery.seed)).rejects.toThrow('account that exported');
    expect(session.getSnapshot()).toMatchObject({ editable: true, connection: 'offline' });
    expect(await store.load()).toEqual(before);
    expect(Y.encodeStateAsUpdate(session.doc)).toEqual(editor);
    expect(outbound(transport)).toEqual([]);
  });

  it('keeps unpersisted current draft identities recoverable when device writes are failing', async () => {
    const recovery = source();
    const { session, store, transport } = await harness(recovery.seed);
    vi.spyOn(store, 'append').mockRejectedValue(new Error('Device storage failed.'));
    title(session.doc).insert(0, 'Unpersisted draft ');
    await vi.waitFor(() => expect(session.getSnapshot().local).toBe('error'));
    const current = JSON.parse(session.exportRecovery());
    const journal = await store.load();
    const file = recovery.file();
    await expect(session.importRecovery(file, recovery.seed)).rejects.toThrow('Save or download the current draft');
    const retained = JSON.parse(session.exportRecovery());
    expect(retained.pending).toEqual(current.pending);
    expect(retained.update).toBe(current.update);
    expect(await store.load()).toEqual(journal);
    expect(title(session.doc).toString()).toBe('Unpersisted draft Original title');
    expect(outbound(transport)).toEqual([]);
    expect(file).toBe(recovery.file());
  });

  it('preserves everything when missing committed history exceeds one wire batch and requires a private copy', async () => {
    const recovery = source();
    const { session, store, transport } = await harness(recovery.seed);
    title(recovery.doc).insert(0, 'x'.repeat(300 * 1024));
    const file = JSON.stringify({ ...JSON.parse(recovery.file()), pending: [] });
    const before = await store.load();
    const editor = Y.encodeStateAsUpdate(session.doc);
    await expect(session.importRecovery(file, recovery.seed)).rejects.toThrow('Recover it as a new private copy');
    expect(await store.load()).toEqual(before);
    expect(Y.encodeStateAsUpdate(session.doc)).toEqual(editor);
    expect(outbound(transport)).toEqual([]);
    expect(JSON.parse(file).pending).toEqual([]);
  });

  it.each(['fresh', 'cached'] as const)('repairs lost acknowledged server history before dependent batches on a %s device, including reload', async device => {
    const recovery = source();
    const lost = { ...recovery.pending[0], pending: false };
    const pending = recovery.pending[1];
    const file = JSON.stringify({ ...JSON.parse(recovery.file()),
      pending: [{ batchId: pending.id, update: encodeUpdate(pending.update) }] });
    const { session, store, factory } = await harness(recovery.seed, device === 'cached' ? [lost, pending] : []);
    const server = new Y.Doc(); docs.push(server); Y.applyUpdate(server, recovery.seed);
    expect(() => prepareCommittedUpdate(server, pending.update)).toThrow(DependencyMissing);
    await session.importRecovery(file, recovery.seed);
    const imported = await store.load();
    const prerequisite = imported.updates[0];
    expect(prerequisite.pending).toBe(true); expect(prerequisite.id).not.toBe(pending.id);
    expect(imported.updates.filter(record => record.pending).map(record => record.id)).toEqual([prerequisite.id, pending.id]);
    expect(imported.updates.find(record => record.id === pending.id)).toEqual(pending);
    if (device === 'cached') expect(imported.updates.find(record => record.id === lost.id)).toEqual(lost);
    expect(title(session.doc).toString()).toBe(title(recovery.doc).toString());
    session.destroy(); store.close();
    const reopenedStore = new LocalStore(identity.accountId, identity.pageId, factory); stores.push(reopenedStore);
    const reopened = await openSession(reopenedStore);
    await reopened.transport.message({ type: 'sync', update: encodeUpdate(recovery.seed), sequence: 0,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    for (const [index, expectedId] of [prerequisite.id, pending.id].entries()) {
      const batch = outbound(reopened.transport)[index];
      expect(batch.batchId).toBe(expectedId);
      const update = Uint8Array.from(Buffer.from(batch.update, 'base64'));
      const prepared = prepareCommittedUpdate(server, update);
      Y.applyUpdate(server, prepared.repairedUpdate ?? update);
      await reopened.transport.message({ type: 'ack', batchId: batch.batchId, sequence: index + 1 });
    }
    expect(reopened.session.getSnapshot()).toMatchObject({ pending: 0, serverSaved: true });
    expect(title(server).toString()).toBe(title(recovery.doc).toString());
    expect(title(reopened.session.doc).toString()).toBe(title(recovery.doc).toString());
    const acknowledged = await reopenedStore.load();
    await reopened.session.importRecovery(file, Y.encodeStateAsUpdate(server));
    expect(await reopenedStore.load()).toEqual(acknowledged);
    expect(JSON.parse(file).pending).toEqual([{ batchId: pending.id, update: encodeUpdate(pending.update) }]);
  });

  it('includes an uncommitted parent when recovering acknowledged remote child history lost by the server', async () => {
    const recovery = source();
    const parent = recovery.pending[0];
    const remote = new Y.Doc(); docs.push(remote);
    Y.applyUpdate(remote, recovery.seed); Y.applyUpdate(remote, parent.update);
    const vector = Y.encodeStateVector(remote); title(remote).insert(title(remote).length, ' Remote child');
    const child = { id: randomUUID(), update: Y.encodeStateAsUpdate(remote, vector), pending: false };
    const file = JSON.stringify({ ...JSON.parse(recovery.file()), update: encodeUpdate(Y.encodeStateAsUpdate(remote)),
      pending: [{ batchId: parent.id, update: encodeUpdate(parent.update) }] });
    const { session, store, transport } = await harness(recovery.seed, [parent, child]);
    const server = new Y.Doc(); docs.push(server); Y.applyUpdate(server, recovery.seed);
    await session.importRecovery(file, recovery.seed);
    const journal = await store.load(); const prerequisite = journal.updates[0];
    expect(prerequisite.pending).toBe(true); expect(prerequisite.id).not.toBe(parent.id);
    // The real server validator must accept the prerequisite without the parent
    // already being committed; hypothetical pending-vector subtraction fails.
    const prepared = prepareCommittedUpdate(server, prerequisite.update);
    Y.applyUpdate(server, prepared.repairedUpdate ?? prerequisite.update);
    expect(title(server).toString()).toBe(title(remote).toString());
    expect(journal.updates.find(record => record.id === parent.id)).toEqual(parent);
    expect(journal.updates.find(record => record.id === child.id)).toEqual(child);
    await transport.message({ type: 'sync', update: encodeUpdate(recovery.seed), sequence: 0,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    expect(outbound(transport)[0].batchId).toBe(prerequisite.id);
    await transport.message({ type: 'ack', batchId: prerequisite.id, sequence: 1 });
    expect(outbound(transport)[1].batchId).toBe(parent.id);
    expect(() => prepareCommittedUpdate(server, parent.update)).not.toThrow();
    await transport.message({ type: 'ack', batchId: parent.id, sequence: 2 });
    expect(session.getSnapshot().pending).toBe(0);
    expect(title(session.doc).toString()).toBe(title(remote).toString());
  });

  it('rejects damaged committed recovery context before pausing or mutating local state', async () => {
    const recovery = source(); const { session, store } = await harness(recovery.seed);
    const before = await store.load(); const snapshot = session.getSnapshot();
    await expect(session.importRecovery(recovery.file(), new Uint8Array([255]))).rejects.toThrow('damaged');
    expect(session.getSnapshot()).toEqual(snapshot); expect(await store.load()).toEqual(before);
  });

  it.each(['acknowledged parent', 'reversed source'] as const)('repairs every outbound dependency prefix with %s pending identities', async scenario => {
    const recovery = source();
    const parent = { ...recovery.pending[0], pending: false };
    const child = recovery.pending[1];
    const { session, store, transport } = await harness(recovery.seed,
      scenario === 'acknowledged parent' ? [parent, child] : []);
    const contents = JSON.parse(recovery.file());
    if (scenario === 'reversed source') contents.pending.reverse();
    const file = JSON.stringify(contents);
    const server = new Y.Doc(); docs.push(server); Y.applyUpdate(server, recovery.seed);
    expect(() => prepareCommittedUpdate(server, child.update)).toThrow(DependencyMissing);
    await session.importRecovery(file, recovery.seed);
    const journal = await store.load();
    const pending = journal.updates.filter(record => record.pending);
    expect(pending[0].id).not.toBe(parent.id); expect(pending[0].id).not.toBe(child.id);
    expect(pending.slice(1)).toEqual(scenario === 'acknowledged parent' ? [child] : [...recovery.pending].reverse());
    if (scenario === 'acknowledged parent') expect(journal.updates.find(record => record.id === parent.id)).toEqual(parent);
    await transport.message({ type: 'sync', update: encodeUpdate(recovery.seed), sequence: 0,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    for (const [index, record] of pending.entries()) {
      expect(outbound(transport)[index]).toMatchObject({ batchId: record.id, update: encodeUpdate(record.update) });
      const prepared = prepareCommittedUpdate(server, record.update);
      Y.applyUpdate(server, prepared.repairedUpdate ?? record.update);
      await transport.message({ type: 'ack', batchId: record.id, sequence: index + 1 });
    }
    expect(session.getSnapshot()).toMatchObject({ pending: 0, serverSaved: true });
    expect(title(server).toString()).toBe(title(recovery.doc).toString());
    const saved = await store.load();
    await session.importRecovery(file, Y.encodeStateAsUpdate(server));
    expect(await store.load()).toEqual(saved);
    expect(file).toBe(JSON.stringify(contents));
  });

  it('stages unseen same-account journal history before repairing its dependent pending work', async () => {
    const recovery = source(); const { session, store, factory } = await harness(recovery.seed);
    const other = new LocalStore(identity.accountId, identity.pageId, factory); stores.push(other);
    const parent = { ...recovery.pending[0], pending: false }; const child = recovery.pending[1];
    await other.append(parent); await other.append(child);
    expect(title(session.doc).toString()).toBe('Original title');
    const seedDoc = new Y.Doc(); docs.push(seedDoc); Y.applyUpdate(seedDoc, recovery.seed);
    const file = JSON.stringify({ ...JSON.parse(recovery.file()), update: encodeUpdate(recovery.seed), pending: [] });
    await session.importRecovery(file, recovery.seed);
    const journal = await store.load(); const prerequisite = journal.updates[0];
    const prepared = prepareCommittedUpdate(seedDoc, prerequisite.update);
    Y.applyUpdate(seedDoc, prepared.repairedUpdate ?? prerequisite.update);
    expect(() => prepareCommittedUpdate(seedDoc, child.update)).not.toThrow();
    expect(journal.updates.filter(record => record.pending)).toEqual([prerequisite, child]);
    expect(journal.updates.find(record => record.id === parent.id)).toEqual(parent);
    expect(title(session.doc).toString()).toBe(title(recovery.doc).toString());
  });

  it('rejects a cross-tab journal change between staging and atomic import without mutating the editor or clearing work', async () => {
    const recovery = source(); const { session, store, factory, transport } = await harness(recovery.seed);
    const other = new LocalStore(identity.accountId, identity.pageId, factory); stores.push(other);
    const before = await store.load(); const editor = Y.encodeStateAsUpdate(session.doc);
    const originalImport = store.importUpdates.bind(store);
    vi.spyOn(store, 'importUpdates').mockImplementationOnce(async (...arguments_) => {
      await other.append(recovery.pending[0]);
      return originalImport(...arguments_);
    });
    const file = recovery.file();
    await expect(session.importRecovery(file, recovery.seed)).rejects.toThrow('changed in another tab');
    expect((await store.load()).updates).toEqual([...before.updates, recovery.pending[0]]);
    expect(Y.encodeStateAsUpdate(session.doc)).toEqual(editor);
    expect(outbound(transport)).toEqual([]);
    expect(file).toBe(recovery.file());
    // A new staged read succeeds without resurrecting or replacing any IDs.
    await session.importRecovery(file, recovery.seed);
    expect((await store.load()).updates.filter(record => record.pending)).toEqual(recovery.pending);
    expect(title(session.doc).toString()).toBe(title(recovery.doc).toString());
  });

  it('recognizes an acknowledged UUID case alias while repairing a dependent pending batch after server restore', async () => {
    const recovery = source(); recovery.pending[0].id = 'abcdef12-abcd-4abc-8abc-abcdef123456';
    const parent = { ...recovery.pending[0], pending: false }; const child = recovery.pending[1];
    const contents = JSON.parse(recovery.file()); contents.pending[0].batchId = parent.id.toUpperCase();
    const file = JSON.stringify(contents);
    const { session, store } = await harness(recovery.seed, [parent, child]);
    await session.importRecovery(file, recovery.seed);
    const journal = await store.load(); const prerequisite = journal.updates[0];
    expect(journal.updates.filter(record => record.pending)).toEqual([prerequisite, child]);
    expect(journal.updates.find(record => record.id === parent.id)).toEqual(parent);
    expect(journal.updates.some(record => record.id === parent.id.toUpperCase())).toBe(false);
    const server = new Y.Doc(); docs.push(server); Y.applyUpdate(server, recovery.seed);
    const prepared = prepareCommittedUpdate(server, prerequisite.update);
    Y.applyUpdate(server, prepared.repairedUpdate ?? prerequisite.update);
    expect(() => prepareCommittedUpdate(server, child.update)).not.toThrow();
    expect(title(session.doc).toString()).toBe(title(recovery.doc).toString());
    expect(JSON.parse(file).pending[0].batchId).toBe(parent.id.toUpperCase());
  });
});
