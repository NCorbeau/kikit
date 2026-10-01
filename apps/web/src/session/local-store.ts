import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { wrap, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';

export interface StoredUpdate {
  id: string;
  update: Uint8Array;
  pending: boolean;
}

export interface StoredDocument {
  initialized: boolean;
  updates: StoredUpdate[];
}

export interface DocumentStore {
  load(): Promise<StoredDocument>;
  append(record: StoredUpdate, initialized?: boolean): Promise<void>;
  acknowledge(id: string): Promise<void>;
  close(): void;
}

const LOCAL_FORMAT_VERSION = 1;
type Metadata = {
  key: 'document';
  schemaVersion: number;
  formatVersion: number;
  initialized: boolean;
};
type OrderedUpdate = StoredUpdate & { ordinal?: number };
interface LocalDatabase extends DBSchema {
  updates: { key: number; value: OrderedUpdate; indexes: { id: string } };
  metadata: { key: 'document'; value: Metadata };
}
type WriteTransaction = IDBPTransaction<LocalDatabase, ['updates', 'metadata'], 'readwrite'>;

/** An incompatible cache stays untouched and can still be exported without applying it. */
export class CacheCompatibilityError extends Error {
  constructor(readonly recovery: StoredDocument) {
    super('This cached page needs a different version of Kikit. Its data has been preserved.');
  }
}

function isCompatible(metadata: Metadata): boolean {
  return metadata.schemaVersion === DOCUMENT_SCHEMA_VERSION
    && metadata.formatVersion === LOCAL_FORMAT_VERSION;
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/** Atomic records keep update bytes and pending IDs together; the generated ordinal
 * gives causal insertion order even when independent tabs write the same journal. */
export class LocalStore implements DocumentStore {
  private opening?: Promise<IDBPDatabase<LocalDatabase>>;
  private closed = false;

  constructor(
    private readonly accountId: string,
    private readonly pageId: string,
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private database(): Promise<IDBPDatabase<LocalDatabase>> {
    if (this.closed) return Promise.reject(new Error('Local store is closed.'));
    this.opening ??= this.openDatabase().catch(error => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  private openDatabase(): Promise<IDBPDatabase<LocalDatabase>> {
    return new Promise((resolve, reject) => {
      let blocked = false;
      const namespace = JSON.stringify([this.accountId, this.pageId]);
      const request = this.factory.open(`kikit:${namespace}`, LOCAL_FORMAT_VERSION);
      request.onupgradeneeded = () => {
        const updates = request.result.createObjectStore('updates', {
          keyPath: 'ordinal',
          autoIncrement: true,
        });
        updates.createIndex('id', 'id', { unique: true });
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked || this.closed) {
          database.close();
          reject(new Error('Local store is closed.'));
          return;
        }
        database.onversionchange = () => {
          database.close();
          this.opening = undefined;
        };
        resolve(wrap(database) as IDBPDatabase<LocalDatabase>);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Local storage upgrade is blocked by another tab.'));
      };
    });
  }

  async load(): Promise<StoredDocument> {
    const database = await this.database();
    const transaction = database.transaction(['metadata', 'updates'], 'readonly');
    const [metadata, records] = await Promise.all([
      transaction.objectStore('metadata').get('document'),
      transaction.objectStore('updates').getAll(),
      transaction.done,
    ]);
    // getAll follows the numeric primary key, not the random batch UUID.
    const updates = records.map(({ ordinal: _ordinal, ...record }) => record);
    const cache = { initialized: metadata?.initialized ?? false, updates };
    if (metadata && !isCompatible(metadata)) throw new CacheCompatibilityError(cache);
    return cache;
  }

  async append(record: StoredUpdate, initialized = false): Promise<void> {
    await this.writeTransaction(
      'Local save failed. Keep this tab open and export your recovery file.',
      async (transaction, metadata) => {
        const updates = transaction.objectStore('updates');
        const saved = await updates.index('id').get(record.id);
        // An uncertain transaction retry must keep the same payload and must
        // never turn an acknowledged record pending again.
        if (saved && !sameBytes(saved.update, record.update)) {
          throw new Error(
            'A local batch identity was reused with different content. Export your recovery file.',
          );
        }
        if (!saved) await updates.add(record);
        await transaction.objectStore('metadata').put({
          key: 'document',
          schemaVersion: DOCUMENT_SCHEMA_VERSION,
          formatVersion: LOCAL_FORMAT_VERSION,
          initialized: initialized || metadata?.initialized || false,
        });
      },
    );
  }

  async acknowledge(id: string): Promise<void> {
    await this.writeTransaction('Could not save the server acknowledgement locally.', async transaction => {
      const updates = transaction.objectStore('updates');
      const record = await updates.index('id').get(id);
      if (record) await updates.put({ ...record, pending: false });
    });
  }

  // Each write validates metadata within the same strict-durability transaction.
  // Await only IndexedDB operations here; success requires transaction.done.
  private async writeTransaction(
    failureMessage: string,
    enqueueRequests: (
      transaction: WriteTransaction,
      metadata: Metadata | undefined,
    ) => Promise<void>,
  ): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['updates', 'metadata'], 'readwrite', {
      durability: 'strict',
    });
    // A request can fail before we await done, so attach its rejection handler now.
    const settled = transaction.done.catch(() => {});
    try {
      const metadata = await transaction.objectStore('metadata').get('document');
      if (metadata && !isCompatible(metadata)) {
        throw new CacheCompatibilityError({ initialized: false, updates: [] });
      }
      await enqueueRequests(transaction, metadata);
      await transaction.done;
    } catch (error) {
      // Semantic and synchronous request failures must also roll back any writes.
      try { transaction.abort(); } catch { /* already completed or aborted */ }
      await settled;
      if (error instanceof DOMException
        && ['AbortError', 'InvalidStateError', 'TransactionInactiveError'].includes(error.name)) {
        throw transaction.error ?? new Error(failureMessage, { cause: error });
      }
      throw error ?? new Error(failureMessage);
    }
  }

  close(): void {
    this.closed = true;
    void this.opening?.then(database => database.close(), () => {});
  }
}
