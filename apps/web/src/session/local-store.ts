import { DOCUMENT_SCHEMA_VERSION } from '@kikit/contracts';
import { wrap, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import * as Y from 'yjs';

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
  importUpdates(records: StoredUpdate[], prerequisite?: StoredUpdate, expected?: StoredDocument): Promise<StoredUpdate[]>;
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
type ReadTransaction = IDBPTransaction<LocalDatabase, ['updates', 'metadata'], 'readonly'>;

/** An incompatible cache stays untouched and can still be exported without applying it. */
export class CacheCompatibilityError extends Error {
  constructor(readonly recovery: StoredDocument, message = 'This cached page needs a different version of Kikit. Its data has been preserved.') {
    super(message);
  }
}

async function readJournal(transaction: ReadTransaction | WriteTransaction): Promise<{
  metadata: Metadata | undefined;
  cache: StoredDocument;
}> {
  const [metadata, records] = await Promise.all([
    transaction.objectStore('metadata').get('document'),
    transaction.objectStore('updates').getAll(),
  ]);
  // getAll follows the numeric primary key, not the random batch UUID.
  const updates = records.map(({ ordinal: _ordinal, ...record }) => record);
  return { metadata, cache: { initialized: metadata?.initialized ?? false, updates } };
}

function isCompatible(metadata: Metadata): boolean {
  return metadata.schemaVersion === DOCUMENT_SCHEMA_VERSION
    && metadata.formatVersion === LOCAL_FORMAT_VERSION;
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

function batchIdentity(id: string): string {
  // PostgreSQL UUID receipts ignore spelling case. Keep the original local ID
  // and leave non-UUID legacy/test identities unchanged.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : id;
}

/** Version 1 never contained lists. Check the merged legacy view before advancing
 * metadata; recovery retains original journal bytes even for malformed caches. */
function isLegacyDocument(updates: StoredUpdate[]): boolean {
  const doc = new Y.Doc();
  try {
    for (const record of updates) Y.applyUpdate(doc, record.update);
    if (doc.store.pendingStructs || doc.store.pendingDs) return false;
    if ([...doc.share.keys()].some(name => name !== 'title' && name !== 'body')) return false;
    const title = doc.getXmlFragment('title');
    if (title.length !== 1) return false;
    for (const fragment of [title, doc.getXmlFragment('body')]) {
      for (const block of fragment.toArray()) {
        const allowed = fragment === title ? ['paragraph'] : ['paragraph', 'heading'];
        if (!(block instanceof Y.XmlElement) || !allowed.includes(block.nodeName)) return false;
        const attributes = block.getAttributes();
        const allowedAttributes = fragment === title ? [] : ['id', ...(block.nodeName === 'heading' ? ['level'] : [])];
        if (Object.keys(attributes).some(key => !allowedAttributes.includes(key))) return false;
        if (fragment !== title && (typeof attributes.id !== 'string' || attributes.id.length < 1 || attributes.id.length > 128)) return false;
        if (block.nodeName === 'heading' && ![1, 2, 3].includes(Number(attributes.level))) return false;
        for (const text of block.toArray()) {
          if (!(text instanceof Y.XmlText)
            || text.toDelta().some((part: { insert: unknown; attributes?: Record<string, unknown> }) => typeof part.insert !== 'string' || Object.keys(part.attributes ?? {}).length)) return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    doc.destroy();
  }
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
    // Hydration and recovery remain readable even when the browser denies writes.
    const read = database.transaction(['updates', 'metadata'], 'readonly');
    const [{ metadata, cache }] = await Promise.all([readJournal(read), read.done]);
    if (!metadata || isCompatible(metadata)) return cache;
    if (metadata.schemaVersion !== 1 || metadata.formatVersion !== LOCAL_FORMAT_VERSION) {
      throw new CacheCompatibilityError(cache);
    }
    return this.upgradeLegacyCache(database, cache);
  }

  private async upgradeLegacyCache(database: IDBPDatabase<LocalDatabase>, recovery: StoredDocument): Promise<StoredDocument> {
    // The document schema is metadata, separate from the unchanged IDB format.
    // Re-read under the exclusive transaction: another tab may have appended
    // legacy edits or completed its upgrade after our first readonly snapshot.
    let transaction: WriteTransaction | undefined;
    let settled: Promise<void> | undefined;
    try {
      transaction = database.transaction(['updates', 'metadata'], 'readwrite', { durability: 'strict' });
      settled = transaction.done.catch(() => {});
      const { metadata, cache } = await readJournal(transaction);
      recovery = cache;
      if (metadata && !isCompatible(metadata)) {
        if (metadata.schemaVersion !== 1 || metadata.formatVersion !== LOCAL_FORMAT_VERSION
          || ((cache.initialized || cache.updates.length > 0) && !isLegacyDocument(cache.updates))) throw new CacheCompatibilityError(cache);
        await transaction.objectStore('metadata').put({ ...metadata, schemaVersion: DOCUMENT_SCHEMA_VERSION });
      }
      await transaction.done;
      return cache;
    } catch (error) {
      try { transaction?.abort(); } catch { /* already completed or aborted */ }
      await settled;
      if (error instanceof CacheCompatibilityError) throw error;
      throw new CacheCompatibilityError(recovery,
        'This cached page could not be upgraded on this device. Its data has been preserved; retry or export recovery.');
    }
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

  /** The complete import commits together; existing receipts never become pending again. */
  async importUpdates(records: StoredUpdate[], prerequisite?: StoredUpdate, expected?: StoredDocument): Promise<StoredUpdate[]> {
    let journal: StoredUpdate[] = [];
    await this.writeTransaction('Could not save recovery on this device. Keep the file and try again.', async (transaction, metadata) => {
      const current = (await readJournal(transaction)).cache;
      if (expected) {
        if (current.initialized !== expected.initialized || current.updates.length !== expected.updates.length
          || current.updates.some((record, index) => {
            const previous = expected.updates[index];
            return record.id !== previous.id || record.pending !== previous.pending || !sameBytes(record.update, previous.update);
          })) {
          throw new Error('This note changed in another tab during recovery. Keep the file and try importing again.');
        }
      }
      const updates = transaction.objectStore('updates');
      const identities = new Map<string, StoredUpdate>();
      for (const record of current.updates) {
        const identity = batchIdentity(record.id);
        const previous = identities.get(identity);
        if (previous && !sameBytes(previous.update, record.update)) throw new Error('A recovery batch conflicts with this device. Keep the file and recover a private copy.');
        if (!previous) identities.set(identity, record);
      }
      if (prerequisite) {
        const identity = batchIdentity(prerequisite.id);
        const saved = identities.get(identity);
        if (saved && !sameBytes(saved.update, prerequisite.update)) throw new Error('A recovery batch conflicts with this device. Keep the file and recover a private copy.');
        if (!saved) {
          // Explicit numeric keys may be zero/negative. Preserve every existing
          // ordinal while making history repair the first durable outbound batch
          // even after reload, ahead of already queued dependent device edits.
          const first = await updates.openCursor();
          await updates.add({ ...prerequisite, ordinal: (first?.primaryKey ?? 1) - 1 });
          identities.set(identity, prerequisite);
        }
      }
      for (const record of records) {
        const identity = batchIdentity(record.id);
        const saved = identities.get(identity);
        if (saved && !sameBytes(saved.update, record.update)) throw new Error('A recovery batch conflicts with this device. Keep the file and recover a private copy.');
        if (!saved) {
          await updates.add(record);
          identities.set(identity, record);
        }
      }
      await transaction.objectStore('metadata').put({ key: 'document', schemaVersion: DOCUMENT_SCHEMA_VERSION,
        formatVersion: LOCAL_FORMAT_VERSION, initialized: metadata?.initialized ?? false });
      journal = (await readJournal(transaction)).cache.updates;
    });
    return journal;
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
