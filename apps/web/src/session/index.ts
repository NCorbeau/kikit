import * as Y from 'yjs';
import {
  DEV_ACCOUNT_ID,
  DEV_PAGE_ID,
  DOCUMENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  decodeUpdate,
  encodeUpdate,
  MAX_UPDATE_BYTES,
  parseRecoveryFile,
  validateRecoveryState,
  validateRepairableDocument,
  type ClientMessage,
  type ServerMessage,
} from '@kikit/contracts';
import {
  CacheCompatibilityError,
  LocalStore,
  type DocumentStore,
  type StoredUpdate,
} from './local-store';
import { SyncClient, type Connection } from './sync-client';
import { DocumentPresence } from './presence';

export interface SessionSnapshot {
  ready: boolean;
  editable: boolean;
  connection: Connection;
  local: 'saving' | 'saved' | 'error';
  pending: number;
  serverSaved: boolean;
  error: string | null;
}

export interface DocumentSession {
  doc: Y.Doc;
  presence: DocumentPresence;
  start(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionSnapshot;
  retry(): void;
  exportRecovery(): string;
  importRecovery(file: string, committedState: Uint8Array): Promise<void>;
  pause(): Promise<void>;
  destroy(): void;
}

interface Transport {
  start(): void;
  retry(): void;
  reconnect(): void;
  stopWithError(): void;
  send(message: ClientMessage): boolean;
  destroy(): void;
}

interface TransportCallbacks {
  connection(state: Connection): void;
  message(message: ServerMessage): Promise<void>;
  error(message: string, terminal: boolean): void;
  presence(update: Uint8Array): void;
}

/** Constructor dependencies keep failure tests independent of browser transport. */
export interface SessionDependencies {
  identity?: { accountId: string; pageId: string; fixture?: boolean };
  store?: DocumentStore;
  transport?: (callbacks: TransportCallbacks) => Transport;
}

const REMOTE_UPDATE_ORIGIN = Symbol('remote');
const RECEIPT_TIMEOUT_MS = 10_000;
type QueuedWrite = { record: StoredUpdate; initialized: boolean };
type CommittedStateMessage = Extract<ServerMessage, { type: 'sync' | 'committed' }>;
type AcknowledgementMessage = Extract<ServerMessage, { type: 'ack' }>;

export function createDocumentSession(dependencies: SessionDependencies = {}): DocumentSession {
  if (import.meta.env.PROD && (!dependencies.identity || dependencies.identity.fixture)) {
    throw new Error('The development identity fixture is disabled in production builds.');
  }
  return new Session(dependencies);
}

class Session implements DocumentSession {
  readonly doc = new Y.Doc();
  readonly presence: DocumentPresence;
  private readonly store: DocumentStore;
  private readonly transport: Transport;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = {
    ready: false,
    editable: false,
    connection: 'connecting',
    local: 'saved',
    pending: 0,
    serverSaved: false,
    error: null,
  };

  // A batch moves from queuedWrites to pendingBatches only after its local commit.
  private readonly pendingBatches = new Map<string, StoredUpdate>();
  private readonly queuedWrites: QueuedWrite[] = [];
  private flushPromise?: Promise<void>;
  private hydrationPromise?: Promise<void>;
  private started = false;
  private active = false;
  private destroyed = false;
  private cacheLoaded = false;
  private synchronized = false;
  private terminalError = false;
  private editingLocked = false;
  private editingAllowedBeforePause?: boolean;
  private connectionEpoch = 0;
  private incompatibleCache: StoredUpdate[] = [];
  private inFlightBatchId?: string;
  private receiptTimer?: ReturnType<typeof setTimeout>;
  private readonly identity: { accountId: string; pageId: string; fixture?: boolean };

  // Keep these failures separate: an older receipt must not clear a newer failed append.
  private appendError: string | null = null;
  private receiptError: string | null = null;
  private remoteError: string | null = null;

  constructor(dependencies: SessionDependencies) {
    this.identity = dependencies.identity ?? { accountId: DEV_ACCOUNT_ID, pageId: DEV_PAGE_ID, fixture: true };
    this.store = dependencies.store ?? new LocalStore(this.identity.accountId, this.identity.pageId);
    this.presence = new DocumentPresence(this.doc, {
      accountId: this.identity.accountId,
      send: update => this.transport.send({ type: 'presence', update: encodeUpdate(update) }),
    });
    const callbacks: TransportCallbacks = {
      connection: state => this.connectionChanged(state),
      message: message => this.receive(message),
      error: (message, terminal) => this.failRemote(message, terminal),
      presence: update => this.presence.receive(update),
    };
    this.transport = dependencies.transport?.(callbacks) ?? new SyncClient(callbacks, this.identity);
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private warnBeforeLeaving = (event: BeforeUnloadEvent): void => {
    if (this.queuedWrites.length === 0) return;
    event.preventDefault();
    event.returnValue = '';
  };

  private connectionChanged(state: Connection): void {
    if (state !== 'online') {
      this.presence.disconnect();
      this.connectionEpoch++;
      this.synchronized = false;
      this.clearInFlightBatch();
    }
    this.publish({ connection: state });
  }

  private publish(changes: Partial<SessionSnapshot> = {}): void {
    if (this.destroyed) return;
    const unpersistedBatches = this.queuedWrites.filter(write => write.record.pending).length;
    const next: SessionSnapshot = {
      ...this.snapshot,
      ...changes,
      pending: this.pendingBatches.size + unpersistedBatches,
      local: this.appendError || this.receiptError
        ? 'error'
        : this.queuedWrites.length > 0 ? 'saving' : 'saved',
      error: this.appendError ?? this.receiptError ?? this.remoteError,
    };
    next.editable = next.ready && !this.editingLocked;
    next.serverSaved = this.synchronized
      && next.connection === 'online'
      && next.local === 'saved'
      && next.pending === 0
      && !next.error;

    const unchanged = Object.keys(next).every(key => {
      const field = key as keyof SessionSnapshot;
      return next[field] === this.snapshot[field];
    });
    if (unchanged) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    window.addEventListener('beforeunload', this.warnBeforeLeaving);
    await this.loadCache();
    this.activate();
  }

  private activate(): void {
    if (this.destroyed || !this.cacheLoaded || this.active) return;
    this.active = true;
    this.doc.on('update', this.localDocumentChanged);
    this.transport.start();
  }

  private loadCache(): Promise<void> {
    this.hydrationPromise ??= this.hydrate().finally(() => {
      this.hydrationPromise = undefined;
    });
    return this.hydrationPromise;
  }

  private async hydrate(): Promise<void> {
    try {
      const cache = await this.store.load();
      if (this.destroyed) return;
      for (const record of cache.updates) {
        Y.applyUpdate(this.doc, record.update, REMOTE_UPDATE_ORIGIN);
        if (record.pending) this.pendingBatches.set(record.id, record);
      }
      this.cacheLoaded = true;
      this.appendError = null;
      this.publish({ ready: cache.initialized });
    } catch (error) {
      if (error instanceof CacheCompatibilityError) {
        this.incompatibleCache = error.recovery.updates;
        this.editingLocked = true;
      }
      this.appendError = describeError(error, 'Could not open local storage.');
      this.publish({ connection: 'error' });
    }
  }

  private localDocumentChanged = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_UPDATE_ORIGIN || this.destroyed) return;
    this.queuedWrites.push({
      record: { id: crypto.randomUUID(), update: update.slice(), pending: true },
      initialized: false,
    });
    this.publish();
    if (!this.appendError) void this.flush();
  };

  private flush(): Promise<void> {
    this.flushPromise ??= this.persistQueuedWrites().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  private async persistQueuedWrites(): Promise<void> {
    while (this.queuedWrites.length > 0 && !this.destroyed) {
      const write = this.queuedWrites[0];
      try {
        await this.store.append(write.record, write.initialized);
        this.queuedWrites.shift();
        if (write.record.pending) this.pendingBatches.set(write.record.id, write.record);
        this.appendError = null;
        this.publish();
        this.sendNextBatch();
      } catch (error) {
        this.stopForIncompatibleCache(error);
        this.appendError = describeError(
          error,
          'Local save failed. Keep this tab open or export your recovery file.',
        );
        this.publish();
        return;
      }
    }
  }

  private sendNextBatch(): void {
    const cannotSend = this.destroyed || !this.synchronized || this.terminalError
      || this.appendError || this.receiptError || this.inFlightBatchId;
    if (cannotSend) return;
    const next = this.pendingBatches.values().next().value as StoredUpdate | undefined;
    if (!next) return;

    this.inFlightBatchId = next.id;
    const sent = this.transport.send({
      type: 'update',
      batchId: next.id,
      update: encodeUpdate(next.update),
    });
    if (!sent) {
      this.inFlightBatchId = undefined;
      return;
    }
    // A missing receipt is an unknown outcome. Reconnect and resend the same identity.
    this.receiptTimer = setTimeout(() => this.transport.reconnect(), RECEIPT_TIMEOUT_MS);
  }

  private async receive(message: ServerMessage): Promise<void> {
    if (this.destroyed || this.terminalError) return;
    switch (message.type) {
      case 'error':
        this.failRemote(message.message, !message.retryable);
        if (message.retryable) this.transport.reconnect();
        else this.transport.stopWithError();
        return;
      case 'sync':
      case 'committed':
        await this.receiveCommittedState(message);
        return;
      case 'ack':
        await this.receiveAcknowledgement(message);
    }
  }

  private async receiveCommittedState(message: CommittedStateMessage): Promise<void> {
    const epoch = this.connectionEpoch;
    if (message.type === 'sync' && (
      message.protocolVersion !== PROTOCOL_VERSION
      || message.schemaVersion !== DOCUMENT_SCHEMA_VERSION
    )) {
      this.failRemote('This page needs a different version of Kikit. Your local work has been preserved.', true);
      this.transport.stopWithError();
      return;
    }

    const update = decodeUpdate(message.update);
    Y.applyUpdate(this.doc, update, REMOTE_UPDATE_ORIGIN);
    this.queuedWrites.push({
      record: { id: crypto.randomUUID(), update, pending: false },
      initialized: true,
    });
    this.publish({ ready: true });
    if (!this.appendError) await this.flush();

    // Persistence may have outlasted the connection that supplied this handshake.
    if (message.type === 'sync' && epoch === this.connectionEpoch) {
      this.editingLocked = false;
      this.synchronized = true;
      this.remoteError = null;
      this.publish({ connection: 'online' });
      this.presence.connect();
      this.sendNextBatch();
    }
  }

  private async receiveAcknowledgement(message: AcknowledgementMessage): Promise<void> {
    // Only a receipt for our durable journal can clear a pending batch.
    if (!this.pendingBatches.has(message.batchId)) return;
    if (this.inFlightBatchId === message.batchId) clearTimeout(this.receiptTimer);
    await this.flushPromise;
    try {
      await this.store.acknowledge(message.batchId);
      this.pendingBatches.delete(message.batchId);
      if (this.inFlightBatchId === message.batchId) this.inFlightBatchId = undefined;
      this.receiptError = null;
      this.publish();
      this.sendNextBatch();
    } catch (error) {
      this.stopForIncompatibleCache(error);
      this.receiptError = describeError(
        error,
        'Could not store the server acknowledgement. Your pending work has been preserved.',
      );
      this.inFlightBatchId = undefined;
      this.publish();
    }
  }

  private stopForIncompatibleCache(error: unknown): void {
    if (!(error instanceof CacheCompatibilityError)) return;
    this.lockEditingUntilVerifiedSync();
    this.terminalError = true;
    this.transport.stopWithError();
  }

  private lockEditingUntilVerifiedSync(): void {
    this.editingLocked = true;
    // A terminal denial supersedes any permission saved by voluntary navigation.
    this.editingAllowedBeforePause = false;
  }

  private clearInFlightBatch(): void {
    this.inFlightBatchId = undefined;
    clearTimeout(this.receiptTimer);
  }

  private failRemote(message: string, terminal: boolean): void {
    this.remoteError = message;
    this.terminalError = terminal;
    if (terminal) this.lockEditingUntilVerifiedSync();
    this.clearInFlightBatch();
    this.synchronized = false;
    this.presence.disconnect();
    this.publish({ connection: 'error' });
  }

  retry(): void {
    if (this.destroyed) return;
    if (!this.started) {
      void this.start();
      return;
    }
    if (!this.cacheLoaded) {
      void this.loadCache().then(() => this.activate());
      return;
    }
    this.appendError = null;
    this.receiptError = null;
    this.remoteError = null;
    this.restoreEditingAfterPause();
    this.terminalError = false;
    this.synchronized = false;
    this.clearInFlightBatch();
    this.publish();
    void this.flush().then(() => {
      if (!this.destroyed && !this.appendError) this.transport.retry();
    });
  }

  private restoreEditingAfterPause(): void {
    // Canceling a voluntary departure can resume cached writing offline. A
    // genuine access/compatibility denial still requires verified synchronization.
    if (this.editingAllowedBeforePause) this.editingLocked = false;
    this.editingAllowedBeforePause = undefined;
  }

  exportRecovery(): string {
    const unpersistedBatches = this.queuedWrites
      .filter(write => write.record.pending)
      .map(write => write.record);
    const pendingBatches = [...this.pendingBatches.values(), ...unpersistedBatches];
    return JSON.stringify({
      format: 'kikit-recovery',
      formatVersion: 2,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      accountId: this.identity.accountId,
      pageId: this.identity.pageId,
      exportedAt: new Date().toISOString(),
      update: encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
      cachedUpdates: this.incompatibleCache.map(record => ({
        batchId: record.id,
        update: encodeUpdate(record.update),
        pending: record.pending,
      })),
      pending: pendingBatches.map(record => ({
        batchId: record.id,
        update: encodeUpdate(record.update),
      })),
    }, null, 2);
  }

  async importRecovery(file: string, committedState: Uint8Array): Promise<void> {
    const recovery = parseRecoveryFile(file, this.identity);
    validateRecoveryState(committedState);
    if (!this.snapshot.ready || this.destroyed || this.incompatibleCache.length) {
      throw new Error('Open the original note before merging recovery. Keep the file.');
    }
    await this.pause();
    const candidate = new Y.Doc({ gc: false });
    const server = new Y.Doc({ gc: false });
    const prerequisiteCheck = new Y.Doc({ gc: false });
    try {
      if (this.queuedWrites.length || this.appendError || this.receiptError) {
        throw new Error('Save or download the current draft before importing recovery.');
      }
      const stagedJournal = await this.store.load();
      if (this.destroyed) return;
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.doc));
      for (const record of stagedJournal.updates) Y.applyUpdate(candidate, record.update);
      for (const record of recovery.pending) Y.applyUpdate(candidate, record.update);
      Y.applyUpdate(candidate, recovery.update);
      validateRepairableDocument(candidate);
      Y.applyUpdate(server, committedState);
      const committedVector = Y.encodeStateVector(server);
      // Test the actual outbound order. A final converged state alone can hide
      // an earlier batch whose parent appears later, or was already acknowledged
      // on this device but disappeared from restored server storage.
      const known = new Set(stagedJournal.updates.map(record => record.id.toLowerCase()));
      const replay = [...stagedJournal.updates.filter(record => record.pending),
        ...recovery.pending.filter(record => !known.has(record.batchId.toLowerCase()))];
      let ordered = true;
      for (const record of replay) {
        Y.applyUpdate(server, record.update);
        if (server.store.pendingStructs || server.store.pendingDs) ordered = false;
        else {
          try { validateRepairableDocument(server); } catch { ordered = false; }
        }
      }
      const before = Y.encodeStateAsUpdate(server);
      Y.applyUpdate(server, Y.encodeStateAsUpdate(candidate));
      const after = Y.encodeStateAsUpdate(server);
      const unchanged = before.length === after.length && before.every((byte, index) => byte === after[index]);
      // Include uncommitted parents when missing history exists. This first
      // batch must be independently applicable to actual committed storage.
      const missing = unchanged && ordered ? new Uint8Array([0, 0]) : Y.diffUpdate(after, committedVector);
      if (missing.byteLength > MAX_UPDATE_BYTES) {
        throw new Error('This recovery is too large to merge in one batch. Recover it as a new private copy.');
      }
      const records = recovery.pending.map(record => ({ id: record.batchId, update: record.update, pending: true }));
      let prerequisite: StoredUpdate | undefined;
      if (missing.length > 2) {
        Y.applyUpdate(prerequisiteCheck, committedState);
        Y.applyUpdate(prerequisiteCheck, missing);
        if (prerequisiteCheck.store.pendingStructs || prerequisiteCheck.store.pendingDs) {
          throw new Error('This recovery needs missing dependencies. Keep the file and recover a new private copy.');
        }
        validateRepairableDocument(prerequisiteCheck);
        prerequisite = { id: crypto.randomUUID(), update: missing, pending: true };
      }
      const journal = await this.store.importUpdates(records, prerequisite, stagedJournal);
      if (this.destroyed) return; // The committed journal remains recoverable after navigation.
      Y.applyUpdate(this.doc, recovery.update, REMOTE_UPDATE_ORIGIN);
      for (const record of journal) Y.applyUpdate(this.doc, record.update, REMOTE_UPDATE_ORIGIN);
      this.pendingBatches.clear();
      for (const record of journal) if (record.pending) this.pendingBatches.set(record.id, record);
      this.publish();
    } finally {
      candidate.destroy();
      server.destroy();
      prerequisiteCheck.destroy();
      this.retry();
    }
  }

  async pause(): Promise<void> {
    // Repeated pauses retain the original permission; terminal denial clears it.
    this.editingAllowedBeforePause ??= !this.editingLocked;
    this.presence.disconnect();
    this.editingLocked = true;
    this.terminalError = true;
    this.clearInFlightBatch();
    this.transport.stopWithError();
    this.publish();
    await this.flush();
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.receiptTimer);
    this.transport.destroy();
    this.presence.destroy();
    window.removeEventListener('beforeunload', this.warnBeforeLeaving);
    this.doc.off('update', this.localDocumentChanged);
    this.doc.destroy();
    this.listeners.clear();
    void (this.flushPromise ?? Promise.resolve()).finally(() => this.store.close());
  }
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
