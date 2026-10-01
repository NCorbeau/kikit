import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';

export interface StoredUpdate { id: string; update: Uint8Array; pending: boolean }
export interface StoredDocument { initialized: boolean; updates: StoredUpdate[] }
export interface DocumentStore {
  load(): Promise<StoredDocument>;
  append(record: StoredUpdate, initialized?: boolean): Promise<void>;
  acknowledge(id: string): Promise<void>;
  close(): void;
}

const LOCAL_FORMAT_VERSION = 1;
type Metadata = { key: 'document'; schemaVersion: number; formatVersion: number; initialized: boolean };
type OrderedUpdate = StoredUpdate & { ordinal: number };

/** An incompatible cache stays untouched and can still be exported without applying it. */
export class CacheCompatibilityError extends Error {
  constructor(readonly recovery: StoredDocument) {
    super('This cached page needs a different version of Kikit. Its data has been preserved.');
  }
}
function compatible(metadata: Metadata): boolean {
  return metadata.schemaVersion === DOCUMENT_SCHEMA_VERSION && metadata.formatVersion === LOCAL_FORMAT_VERSION;
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Atomic records keep update bytes and pending IDs together; the generated ordinal
 * gives causal insertion order even when independent tabs write the same journal. */
export class LocalStore implements DocumentStore {
  private opening: Promise<IDBDatabase> | undefined;
  private closed = false;
  constructor(private accountId: string, private pageId: string, private factory: IDBFactory = indexedDB) {}

  private database(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('Local store is closed.'));
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let rejected = false;
      const request = this.factory.open(`kikit:${JSON.stringify([this.accountId, this.pageId])}`, LOCAL_FORMAT_VERSION);
      request.onupgradeneeded = () => {
        const updates = request.result.createObjectStore('updates', { keyPath: 'ordinal', autoIncrement: true });
        updates.createIndex('id', 'id', { unique: true });
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected || this.closed) { db.close(); reject(new Error('Local store is closed.')); return; }
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
      request.onblocked = () => { rejected = true; reject(new Error('Local storage upgrade is blocked by another tab.')); };
    }).catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }

  async load(): Promise<StoredDocument> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['metadata', 'updates'], 'readonly');
      const metadata = transaction.objectStore('metadata').get('document');
      const updates = transaction.objectStore('updates').getAll();
      transaction.oncomplete = () => {
        const value = metadata.result as Metadata | undefined;
        // getAll follows the numeric primary key, not the random batch UUID.
        const cache = { initialized: value?.initialized ?? false, updates: (updates.result as OrderedUpdate[]).map(({ ordinal: _ordinal, ...record }) => record) };
        if (value && !compatible(value)) { reject(new CacheCompatibilityError(cache)); return; }
        resolve(cache);
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read local storage.'));
      transaction.onerror = () => { /* onabort reports the transaction outcome */ };
    });
  }

  async append(record: StoredUpdate, initialized = false): Promise<void> {
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      const transaction = db.transaction(['updates', 'metadata'], 'readwrite', { durability: 'strict' });
      const metadata = transaction.objectStore('metadata');
      const existing = metadata.get('document');
      existing.onsuccess = () => {
        const value = existing.result as Metadata | undefined;
        if (value && !compatible(value)) {
          failure = new CacheCompatibilityError({ initialized: false, updates: [] });
          transaction.abort(); return;
        }
        const updates = transaction.objectStore('updates');
        const sameId = updates.index('id').get(record.id);
        sameId.onsuccess = () => {
          const saved = sameId.result as OrderedUpdate | undefined;
          // Retrying an uncertain local transaction never creates another identity,
          // changes its payload, or turns an acknowledged record pending again.
          if (saved && !sameBytes(saved.update, record.update)) {
            failure = new Error('A local batch identity was reused with different content. Export your recovery file.');
            transaction.abort(); return;
          }
          if (!saved) updates.add(record);
          metadata.put({ key: 'document', schemaVersion: DOCUMENT_SCHEMA_VERSION, formatVersion: LOCAL_FORMAT_VERSION, initialized: initialized || value?.initialized || false } satisfies Metadata);
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Local save failed. Keep this tab open and export your recovery file.'));
      transaction.onerror = () => { /* request success does not mean committed */ };
    });
  }

  async acknowledge(id: string): Promise<void> {
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      const transaction = db.transaction(['updates', 'metadata'], 'readwrite', { durability: 'strict' });
      const metadata = transaction.objectStore('metadata').get('document');
      metadata.onsuccess = () => {
        const value = metadata.result as Metadata | undefined;
        if (value && !compatible(value)) {
          failure = new CacheCompatibilityError({ initialized: false, updates: [] });
          transaction.abort(); return;
        }
        const store = transaction.objectStore('updates');
        const request = store.index('id').get(id);
        request.onsuccess = () => {
          const record = request.result as OrderedUpdate | undefined;
          if (record) store.put({ ...record, pending: false });
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not save the server acknowledgement locally.'));
      transaction.onerror = () => {};
    });
  }

  close(): void {
    this.closed = true;
    void this.opening?.then(db => db.close(), () => {});
  }
}
