import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';

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
type OrderedUpdate = StoredUpdate & { ordinal: number };

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
  private opening?: Promise<IDBDatabase>;
  private closed = false;

  constructor(
    private readonly accountId: string,
    private readonly pageId: string,
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private database(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('Local store is closed.'));
    this.opening ??= this.openDatabase().catch(error => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  private openDatabase(): Promise<IDBDatabase> {
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
        resolve(database);
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
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['metadata', 'updates'], 'readonly');
      const metadataRequest = transaction.objectStore('metadata').get('document');
      const updatesRequest = transaction.objectStore('updates').getAll();
      transaction.oncomplete = () => {
        const metadata = metadataRequest.result as Metadata | undefined;
        // getAll follows the numeric primary key, not the random batch UUID.
        const updates = (updatesRequest.result as OrderedUpdate[])
          .map(({ ordinal: _ordinal, ...record }) => record);
        const cache = { initialized: metadata?.initialized ?? false, updates };
        if (metadata && !isCompatible(metadata)) {
          reject(new CacheCompatibilityError(cache));
          return;
        }
        resolve(cache);
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read local storage.'));
      transaction.onerror = () => { /* onabort reports the transaction outcome */ };
    });
  }

  async append(record: StoredUpdate, initialized = false): Promise<void> {
    await this.writeTransaction(
      'Local save failed. Keep this tab open and export your recovery file.',
      (transaction, metadata, abort) => {
        const updates = transaction.objectStore('updates');
        const existingRequest = updates.index('id').get(record.id);
        existingRequest.onsuccess = () => {
          const saved = existingRequest.result as OrderedUpdate | undefined;
          // An uncertain transaction retry must keep the same payload and must
          // never turn an acknowledged record pending again.
          if (saved && !sameBytes(saved.update, record.update)) {
            abort(new Error(
              'A local batch identity was reused with different content. Export your recovery file.',
            ));
            return;
          }
          if (!saved) updates.add(record);
          transaction.objectStore('metadata').put({
            key: 'document',
            schemaVersion: DOCUMENT_SCHEMA_VERSION,
            formatVersion: LOCAL_FORMAT_VERSION,
            initialized: initialized || metadata?.initialized || false,
          } satisfies Metadata);
        };
      },
    );
  }

  async acknowledge(id: string): Promise<void> {
    await this.writeTransaction('Could not save the server acknowledgement locally.', transaction => {
      const updates = transaction.objectStore('updates');
      const request = updates.index('id').get(id);
      request.onsuccess = () => {
        const record = request.result as OrderedUpdate | undefined;
        if (record) updates.put({ ...record, pending: false });
      };
    });
  }

  // Each write validates metadata within the same strict-durability transaction.
  // Success resolves only at oncomplete, after all requests have committed.
  private async writeTransaction(
    failureMessage: string,
    enqueueRequests: (
      transaction: IDBTransaction,
      metadata: Metadata | undefined,
      abort: (error: Error) => void,
    ) => void,
  ): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['updates', 'metadata'], 'readwrite', {
        durability: 'strict',
      });
      let failure: Error | undefined;
      const abort = (error: Error): void => {
        failure = error;
        transaction.abort();
      };
      const metadataRequest = transaction.objectStore('metadata').get('document');
      metadataRequest.onsuccess = () => {
        const metadata = metadataRequest.result as Metadata | undefined;
        if (metadata && !isCompatible(metadata)) {
          abort(new CacheCompatibilityError({ initialized: false, updates: [] }));
          return;
        }
        enqueueRequests(transaction, metadata, abort);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(
        failure ?? transaction.error ?? new Error(failureMessage),
      );
      transaction.onerror = () => { /* request success does not mean committed */ };
    });
  }

  close(): void {
    this.closed = true;
    void this.opening?.then(database => database.close(), () => {});
  }
}
