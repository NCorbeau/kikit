import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { IDBDatabase as FakeIDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { CacheCompatibilityError, LocalStore } from './local-store';
import * as Y from 'yjs';

const stores: LocalStore[] = [];

function store(factory: IDBFactory, account = 'writer', page = 'page') {
  const value = new LocalStore(account, page, factory);
  stores.push(value);
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@kikit/contracts');
  vi.resetModules();
  for (const item of stores.splice(0)) item.close();
});

describe('local update journal', () => {

  async function legacyCache(factory: IDBFactory, mutate?: (doc: Y.Doc) => void) {
    const doc = new Y.Doc();
    const title = new Y.XmlElement('paragraph');
    doc.getXmlFragment('title').insert(0, [title]);
    const body = new Y.XmlElement('paragraph');
    body.setAttribute('id', 'legacy-paragraph');
    const text = new Y.XmlText(); text.insert(0, 'Original'); body.insert(0, [text]);
    doc.getXmlFragment('body').insert(0, [body]);
    const initialized = Y.encodeStateAsUpdate(doc);
    const vector = Y.encodeStateVector(doc);
    text.insert(text.length, ' offline draft');
    mutate?.(doc);
    const pending = Y.encodeStateAsUpdate(doc, vector);
    doc.destroy();
    // Create the unchanged native IDB format, then simulate v1 schema metadata.
    const value = store(factory);
    await value.append({ id: 'z-initial', update: initialized, pending: false }, true);
    await value.append({ id: 'a-pending', update: pending, pending: true });
    const request = factory.open('kikit:["writer","page"]', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['metadata', 'updates'], 'readwrite');
    transaction.objectStore('metadata').put({ key: 'document', schemaVersion: 1, formatVersion: 1, initialized: true });
    const records = transaction.objectStore('updates').getAll();
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
    return { value, db, records: records.result };
  }

  it('atomically upgrades schema-1 metadata while retaining pending bytes, batch IDs and insertion order', async () => {
    const factory = new IDBFactory();
    const { value, db, records } = await legacyCache(factory);
    const loaded = await value.load();
    expect(loaded.initialized).toBe(true);
    expect(loaded.updates).toEqual(records.map(({ ordinal: _ordinal, ...record }) => record));
    expect(loaded.updates.map(record => record.id)).toEqual(['z-initial', 'a-pending']);
    const transaction = db.transaction(['metadata', 'updates']);
    const metadata = transaction.objectStore('metadata').get('document');
    const unchanged = transaction.objectStore('updates').getAll();
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    expect(metadata.result.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(unchanged.result).toEqual(records);
    expect(db.version).toBe(1);
    await value.acknowledge('a-pending');
    expect((await value.load()).updates[1]).toEqual({ ...loaded.updates[1], pending: false });
    db.close();
  });

  it('rolls back a failed schema metadata upgrade and preserves the legacy pending journal', async () => {
    const { value, db, records } = await legacyCache(new IDBFactory());
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === 'metadata') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    const error = await value.load().catch(reason => reason);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect(error.message).toContain('could not be upgraded');
    expect(error.recovery.updates).toEqual(records.map(({ ordinal: _ordinal, ...record }) => record));
    vi.restoreAllMocks();
    const transaction = db.transaction(['metadata', 'updates']);
    const metadata = transaction.objectStore('metadata').get('document');
    const updates = transaction.objectStore('updates').getAll();
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    expect(metadata.result.schemaVersion).toBe(1);
    expect(updates.result).toEqual(records);
    expect((await value.load()).updates[1].pending).toBe(true);
    db.close();
  });

  function denyWrites() {
    const transaction = FakeIDBDatabase.prototype.transaction;
    return vi.spyOn(FakeIDBDatabase.prototype, 'transaction').mockImplementation(function(this: InstanceType<typeof FakeIDBDatabase>, ...args) {
      if (args[1] === 'readwrite') throw new DOMException('Browser storage writes denied', 'QuotaExceededError');
      return transaction.apply(this, args);
    });
  }

  it('hydrates an existing current-version page using readonly storage when writes are denied', async () => {
    const value = store(new IDBFactory());
    const record = { id: 'readable-pending', update: new Uint8Array([2, 4]), pending: true };
    await value.append(record, true);
    denyWrites();
    expect(await value.load()).toEqual({ initialized: true, updates: [record] });
  });

  it('exports a newer incompatible cache through readonly storage when writes are denied', async () => {
    const { value, db, records } = await legacyCache(new IDBFactory());
    const transaction = db.transaction('metadata', 'readwrite');
    transaction.objectStore('metadata').put({ key: 'document', schemaVersion: 99, formatVersion: 1, initialized: true });
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    denyWrites();
    const error = await value.load().catch(reason => reason);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect(error.recovery.updates).toEqual(records.map(({ ordinal: _ordinal, ...record }) => record));
    db.close();
  });

  it('exports all legacy pending bytes if opening its upgrade transaction is denied', async () => {
    const { value, db, records } = await legacyCache(new IDBFactory());
    denyWrites();
    const error = await value.load().catch(reason => reason);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect(error.message).toContain('could not be upgraded');
    expect(error.recovery.updates).toEqual(records.map(({ ordinal: _ordinal, ...record }) => record));
    const transaction = db.transaction('metadata', 'readonly');
    const metadata = transaction.objectStore('metadata').get('document');
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    expect(metadata.result.schemaVersion).toBe(1);
    db.close();
  });

  it('preserves an initialized legacy cache missing its document bytes instead of upgrading it', async () => {
    const { value, db } = await legacyCache(new IDBFactory());
    const transaction = db.transaction('updates', 'readwrite');
    transaction.objectStore('updates').clear();
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    const error = await value.load().catch(reason => reason);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect(error.recovery).toEqual({ initialized: true, updates: [] });
    const read = db.transaction('metadata');
    const metadata = read.objectStore('metadata').get('document');
    await new Promise<void>(resolve => { read.oncomplete = () => resolve(); });
    expect(metadata.result.schemaVersion).toBe(1);
    db.close();
  });

  it.each(['task', 'attributes', 'heading', 'marks'])('preserves and rejects an unsupported legacy cache (%s)', async variation => {
    const { value, db, records } = await legacyCache(new IDBFactory(), doc => {
      const block = doc.getXmlFragment('body').get(0) as Y.XmlElement;
      if (variation === 'task') doc.getXmlFragment('body').insert(1, [new Y.XmlElement('taskList')]);
      if (variation === 'attributes') block.setAttribute('unsupported', 'value');
      if (variation === 'heading') {
        const heading = new Y.XmlElement('heading'); heading.setAttribute('id', 'heading'); heading.setAttribute('level', '4');
        doc.getXmlFragment('body').insert(1, [heading]);
      }
      if (variation === 'marks') (block.get(0) as Y.XmlText).format(0, 1, { bold: true });
    });
    const error = await value.load().catch(reason => reason);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect(error.recovery.updates).toEqual(records.map(({ ordinal: _ordinal, ...record }) => record));
    db.close();
  });

  it('blocks a still-open schema-1 writer and acknowledger after another tab upgrades its cache', async () => {
    const factory = new IDBFactory();
    const { value, db, records } = await legacyCache(factory);
    vi.resetModules();
    vi.doMock('@kikit/contracts', () => ({ DOCUMENT_SCHEMA_VERSION: 1 }));
    const { LocalStore: OldLocalStore, CacheCompatibilityError: OldCompatibilityError } = await import('./local-store');
    const oldTab = new OldLocalStore('writer', 'page', factory);
    stores.push(oldTab);
    expect((await oldTab.load()).updates).toHaveLength(2);
    await value.load();
    await expect(oldTab.append({ id: 'stale-new', update: new Uint8Array([4]), pending: true })).rejects.toBeInstanceOf(OldCompatibilityError);
    await expect(oldTab.acknowledge('a-pending')).rejects.toBeInstanceOf(OldCompatibilityError);
    const error = await oldTab.load().catch(reason => reason);
    expect(error.recovery.updates).toEqual(records.map(({ ordinal: _ordinal, ...record }) => record));
    db.close();
  });

  it('reads and acknowledges an existing native v1 cache without changing its schema or identity', async () => {
    const factory = new IDBFactory();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('kikit:["writer","page"]', 1);
      request.onupgradeneeded = () => {
        const updates = request.result.createObjectStore('updates', { keyPath: 'ordinal', autoIncrement: true });
        updates.createIndex('id', 'id', { unique: true });
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = { id: 'existing-batch', update: new Uint8Array([0, 255, 3]), pending: true };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['updates', 'metadata'], 'readwrite');
      tx.objectStore('updates').add({ ...record, ordinal: 7 });
      tx.objectStore('metadata').put({
        key: 'document', schemaVersion: DOCUMENT_SCHEMA_VERSION, formatVersion: 1, initialized: true,
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const value = store(factory);
    expect(await value.load()).toEqual({ initialized: true, updates: [record] });
    await value.acknowledge(record.id);
    const saved = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('updates');
      const request = tx.objectStore('updates').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
    expect(saved).toEqual([{ ...record, ordinal: 7, pending: false }]);
    expect(db.version).toBe(1);
    db.close();
  });

  it('replays insertion order across tab connections and retains binary history after acknowledgement', async () => {
    const factory = new IDBFactory();
    const firstTab = store(factory), secondTab = store(factory);
    await firstTab.append({
      id: 'z-first',
      update: new Uint8Array([1, 2]),
      pending: true
    }, true);
    await secondTab.append({
      id: 'a-second',
      update: new Uint8Array([3, 4]),
      pending: true
    });
    await firstTab.append({
      id: 'm-third',
      update: new Uint8Array([5]),
      pending: false
    });
    expect((await secondTab.load()).updates.map(record => record.id)).toEqual(['z-first', 'a-second', 'm-third']);
    await secondTab.acknowledge('z-first');
    const reloaded = await store(factory).load();
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.updates).toEqual([
      {
        id: 'z-first',
        update: new Uint8Array([1, 2]),
        pending: false
      },
      {
        id: 'a-second',
        update: new Uint8Array([3, 4]),
        pending: true
      },
      {
        id: 'm-third',
        update: new Uint8Array([5]),
        pending: false
      },
    ]);
  });

  it('rolls back update bytes and initialization together when a transaction aborts', async () => {
    const value = store(new IDBFactory());
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = add.apply(this, args);
      if (this.name === 'updates') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(value.append({
      id: 'one',
      update: new Uint8Array([7]),
      pending: true
    }, true)).rejects.toThrow('Local save failed');
    expect(await value.load()).toEqual({ initialized: false, updates: [] });
  });

  it('keeps batch retries idempotent and rejects an identity with changed bytes', async () => {
    const value = store(new IDBFactory());
    const record = {
      id: 'same',
      update: new Uint8Array([1, 2]),
      pending: true
    };
    await value.append(record);
    await value.acknowledge(record.id);
    await value.append(record);
    await expect(value.append({ ...record, update: new Uint8Array([9]) }, true)).rejects.toThrow('different content');
    expect(await value.load()).toEqual({ initialized: false, updates: [{ ...record, pending: false }] });
  });

  it('retains pending bytes after an acknowledgement write succeeds but its transaction aborts', async () => {
    const factory = new IDBFactory();
    const value = store(factory);
    const record = { id: 'unacknowledged', update: new Uint8Array([3, 7]), pending: true };
    await value.append(record, true);
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === 'updates') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(value.acknowledge(record.id)).rejects.toThrow('Could not save the server acknowledgement locally');
    value.close();
    expect(await store(factory).load()).toEqual({ initialized: true, updates: [record] });
  });

  it('isolates identical page IDs by account and separate pages within an account', async () => {
    const factory = new IDBFactory();
    await store(factory).append({
      id: 'private',
      update: new Uint8Array([8]),
      pending: true
    }, true);
    expect(await store(factory, 'other').load()).toEqual({ initialized: false, updates: [] });
    expect(await store(factory, 'writer', 'other').load()).toEqual({ initialized: false, updates: [] });
  });

  it('fails closed for incompatible cached schema and preserves bytes for recovery', async () => {
    const factory = new IDBFactory();
    const value = store(factory);
    const record = {
      id: 'draft',
      update: new Uint8Array([4, 5]),
      pending: true
    };
    await value.append(record, true);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('kikit:["writer","page"]', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({
        key: 'document',
        schemaVersion: 99,
        formatVersion: 1,
        initialized: true
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const error = await value.load().catch(reason => reason as unknown);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect((error as CacheCompatibilityError).recovery.updates).toEqual([record]);
    await expect(value.append({
      id: 'new',
      update: new Uint8Array([6]),
      pending: true
    })).rejects.toBeInstanceOf(CacheCompatibilityError);
    await expect(value.acknowledge(record.id)).rejects.toBeInstanceOf(CacheCompatibilityError);
    const again = await value.load().catch(reason => reason as CacheCompatibilityError);
    expect((again as CacheCompatibilityError).recovery.updates).toEqual([record]);
  });
});
