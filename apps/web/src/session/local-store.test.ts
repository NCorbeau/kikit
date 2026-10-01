import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { CacheCompatibilityError, LocalStore } from './local-store';

const stores: LocalStore[] = [];
function store(factory: IDBFactory, account = 'writer', page = 'page') {
  const value = new LocalStore(account, page, factory); stores.push(value); return value;
}
afterEach(() => { vi.restoreAllMocks(); for (const item of stores.splice(0)) item.close(); });

describe('local update journal', () => {
  it('replays insertion order across tab connections and retains binary history after acknowledgement', async () => {
    const factory = new IDBFactory();
    const a = store(factory), b = store(factory);
    await a.append({ id: 'z-first', update: new Uint8Array([1, 2]), pending: true }, true);
    await b.append({ id: 'a-second', update: new Uint8Array([3, 4]), pending: true });
    await a.append({ id: 'm-third', update: new Uint8Array([5]), pending: false });
    expect((await b.load()).updates.map(record => record.id)).toEqual(['z-first', 'a-second', 'm-third']);
    await b.acknowledge('z-first');
    const reloaded = await store(factory).load();
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.updates).toEqual([
      { id: 'z-first', update: new Uint8Array([1, 2]), pending: false },
      { id: 'a-second', update: new Uint8Array([3, 4]), pending: true },
      { id: 'm-third', update: new Uint8Array([5]), pending: false },
    ]);
  });

  it('rolls back update bytes and initialization together when a transaction aborts', async () => {
    const value = store(new IDBFactory());
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = add.apply(this, args);
      if (this.name === 'updates') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(value.append({ id: 'one', update: new Uint8Array([7]), pending: true }, true)).rejects.toThrow();
    expect(await value.load()).toEqual({ initialized: false, updates: [] });
  });

  it('keeps batch retries idempotent and rejects an identity with changed bytes', async () => {
    const value = store(new IDBFactory());
    const record = { id: 'same', update: new Uint8Array([1, 2]), pending: true };
    await value.append(record);
    await value.acknowledge(record.id);
    await value.append(record);
    await expect(value.append({ ...record, update: new Uint8Array([9]) }, true)).rejects.toThrow('different content');
    expect(await value.load()).toEqual({ initialized: false, updates: [{ ...record, pending: false }] });
  });

  it('isolates identical page IDs by account and separate pages within an account', async () => {
    const factory = new IDBFactory();
    await store(factory).append({ id: 'private', update: new Uint8Array([8]), pending: true }, true);
    expect(await store(factory, 'other').load()).toEqual({ initialized: false, updates: [] });
    expect(await store(factory, 'writer', 'other').load()).toEqual({ initialized: false, updates: [] });
  });

  it('fails closed for incompatible cached schema and preserves bytes for recovery', async () => {
    const factory = new IDBFactory();
    const value = store(factory);
    const record = { id: 'draft', update: new Uint8Array([4, 5]), pending: true };
    await value.append(record, true);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('kikit:["writer","page"]', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({ key: 'document', schemaVersion: 99, formatVersion: 1, initialized: true });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    const error = await value.load().catch(reason => reason as unknown);
    expect(error).toBeInstanceOf(CacheCompatibilityError);
    expect((error as CacheCompatibilityError).recovery.updates).toEqual([record]);
    await expect(value.append({ id: 'new', update: new Uint8Array([6]), pending: true })).rejects.toBeInstanceOf(CacheCompatibilityError);
    await expect(value.acknowledge(record.id)).rejects.toBeInstanceOf(CacheCompatibilityError);
    const again = await value.load().catch(reason => reason as CacheCompatibilityError);
    expect((again as CacheCompatibilityError).recovery.updates).toEqual([record]);
  });
});
