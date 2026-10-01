import * as Y from 'yjs';
import {
  DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION,
  encodeUpdate, decodeUpdate, type ClientMessage, type ServerMessage,
} from '@kikit/contracts';
import { CacheCompatibilityError, LocalStore, type DocumentStore, type StoredUpdate } from './local-store';
import { SyncClient, type Connection } from './sync-client';

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
  start(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionSnapshot;
  retry(): void;
  exportRecovery(): string;
  destroy(): void;
}
interface Transport {
  start(): void; retry(): void; reconnect(): void; stopWithError(): void;
  send(message: ClientMessage): boolean; destroy(): void;
}
interface TransportCallbacks {
  connection(state: Connection): void;
  message(message: ServerMessage): Promise<void>;
  error(message: string, terminal: boolean): void;
}
/** Constructor dependencies keep failure tests independent of browser transport. */
export interface SessionDependencies {
  store?: DocumentStore;
  transport?: (callbacks: TransportCallbacks) => Transport;
}
const REMOTE = Symbol('remote');
type WaitingWrite = { record: StoredUpdate; initialized: boolean };

export function createDocumentSession(dependencies: SessionDependencies = {}): DocumentSession {
  if (import.meta.env.PROD) throw new Error('The development identity fixture is disabled in production builds.');
  return new Session(dependencies);
}

class Session implements DocumentSession {
  readonly doc = new Y.Doc();
  private store: DocumentStore;
  private transport: Transport;
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = { ready: false, editable: false, connection: 'connecting', local: 'saved', pending: 0, serverSaved: false, error: null };
  private pending = new Map<string, StoredUpdate>();
  private writes: WaitingWrite[] = [];
  private flushing?: Promise<void>;
  private started = false;
  private active = false;
  private loading?: Promise<void>;
  private destroyed = false;
  private loaded = false;
  private synced = false;
  private terminal = false;
  private locked = false;
  private connectionEpoch = 0;
  private incompatibleCache: StoredUpdate[] = [];
  private inFlight?: string;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private localError: string | null = null;
  private receiptError: string | null = null;
  private remoteError: string | null = null;
  private leave = (event: BeforeUnloadEvent) => {
    if (this.writes.length) { event.preventDefault(); event.returnValue = ''; }
  };

  constructor(dependencies: SessionDependencies) {
    this.store = dependencies.store ?? new LocalStore(DEV_ACCOUNT_ID, DEV_PAGE_ID);
    const callbacks: TransportCallbacks = {
      connection: state => {
        if (state !== 'online') {
          this.connectionEpoch++;
          this.synced = false;
          this.inFlight = undefined;
          clearTimeout(this.ackTimer);
        }
        this.publish({ connection: state });
      },
      message: message => this.receive(message),
      error: (message, terminal) => this.failRemote(message, terminal),
    };
    this.transport = dependencies.transport?.(callbacks) ?? new SyncClient(callbacks);
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(changes: Partial<SessionSnapshot> = {}): void {
    if (this.destroyed) return;
    const next: SessionSnapshot = {
      ...this.snapshot, ...changes,
      pending: this.pending.size + this.writes.filter(write => write.record.pending).length,
      local: (this.localError || this.receiptError) ? 'error' : this.writes.length ? 'saving' : 'saved',
      error: this.localError ?? this.receiptError ?? this.remoteError,
    };
    next.editable = next.ready && !this.locked;
    next.serverSaved = this.synced && next.connection === 'online' && next.local === 'saved' && next.pending === 0 && !next.error;
    if (Object.keys(next).every(key => next[key as keyof SessionSnapshot] === this.snapshot[key as keyof SessionSnapshot])) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    window.addEventListener('beforeunload', this.leave);
    await this.load();
    this.activate();
  }

  private activate(): void {
    if (this.destroyed || !this.loaded || this.active) return;
    this.active = true;
    this.doc.on('update', this.changed);
    this.transport.start();
  }

  private load(): Promise<void> {
    this.loading ??= this.hydrate().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async hydrate(): Promise<void> {
    try {
      const cache = await this.store.load();
      if (this.destroyed) return;
      for (const record of cache.updates) {
        Y.applyUpdate(this.doc, record.update, REMOTE);
        if (record.pending) this.pending.set(record.id, record);
      }
      this.loaded = true;
      this.localError = null;
      this.publish({ ready: cache.initialized });
    } catch (error) {
      if (error instanceof CacheCompatibilityError) {
        this.incompatibleCache = error.recovery.updates;
        this.locked = true;
      }
      this.localError = this.describe(error, 'Could not open local storage.');
      this.publish({ connection: 'error' });
    }
  }

  private changed = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE || this.destroyed) return;
    this.writes.push({ record: { id: crypto.randomUUID(), update: update.slice(), pending: true }, initialized: false });
    this.publish();
    if (!this.localError) void this.flush();
  };

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.writes.length && !this.destroyed) {
        const write = this.writes[0];
        try {
          await this.store.append(write.record, write.initialized);
          this.writes.shift();
          if (write.record.pending) this.pending.set(write.record.id, write.record);
          this.localError = null;
          this.publish();
          this.pump();
        } catch (error) {
          if (error instanceof CacheCompatibilityError) { this.locked = true; this.terminal = true; this.transport.stopWithError(); }
          this.localError = this.describe(error, 'Local save failed. Keep this tab open or export your recovery file.');
          this.publish();
          return;
        }
      }
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private pump(): void {
    if (this.destroyed || !this.synced || this.terminal || this.localError || this.receiptError || this.inFlight) return;
    const next = this.pending.values().next().value as StoredUpdate | undefined;
    if (!next) return;
    this.inFlight = next.id;
    if (!this.transport.send({ type: 'update', batchId: next.id, update: encodeUpdate(next.update) })) {
      this.inFlight = undefined;
      return;
    }
    // A missing acknowledgement is an unknown outcome; resend the same identity after reconnect.
    this.ackTimer = setTimeout(() => this.transport.reconnect(), 10000);
  }

  private async receive(message: ServerMessage): Promise<void> {
    if (this.destroyed || this.terminal) return;
    if (message.type === 'error') {
      this.failRemote(message.message, !message.retryable);
      if (message.retryable) this.transport.reconnect();
      else this.transport.stopWithError();
      return;
    }
    if (message.type === 'sync' || message.type === 'committed') {
      const epoch = this.connectionEpoch;
      if (message.type === 'sync' && (message.protocolVersion !== PROTOCOL_VERSION || message.schemaVersion !== DOCUMENT_SCHEMA_VERSION)) {
        this.failRemote('This page needs a different version of Kikit. Your local work has been preserved.', true);
        this.transport.stopWithError();
        return;
      }
      const update = decodeUpdate(message.update);
      Y.applyUpdate(this.doc, update, REMOTE);
      this.writes.push({ record: { id: crypto.randomUUID(), update, pending: false }, initialized: true });
      this.publish({ ready: true });
      if (!this.localError) await this.flush();
      if (message.type === 'sync' && epoch === this.connectionEpoch) {
        this.locked = false;
        this.synced = true;
        this.remoteError = null;
        this.publish({ connection: 'online' });
        this.pump();
      }
      return;
    }
    // Ignore unsolicited/stale ack identities. Only a receipt for our journal can clear it.
    if (!this.pending.has(message.batchId)) return;
    if (this.inFlight === message.batchId) clearTimeout(this.ackTimer);
    await this.flushing;
    try {
      await this.store.acknowledge(message.batchId);
      this.pending.delete(message.batchId);
      if (this.inFlight === message.batchId) this.inFlight = undefined;
      this.receiptError = null;
      this.publish();
      this.pump();
    } catch (error) {
      if (error instanceof CacheCompatibilityError) { this.locked = true; this.terminal = true; this.transport.stopWithError(); }
      this.receiptError = this.describe(error, 'Could not store the server acknowledgement. Your pending work has been preserved.');
      this.inFlight = undefined;
      this.publish();
    }
  }

  private failRemote(message: string, terminal: boolean): void {
    this.remoteError = message;
    this.terminal = terminal;
    if (terminal) this.locked = true;
    this.inFlight = undefined;
    clearTimeout(this.ackTimer);
    this.synced = false;
    this.publish({ connection: 'error' });
  }

  retry(): void {
    if (this.destroyed) return;
    if (!this.started) { void this.start(); return; }
    if (!this.loaded) {
      void this.load().then(() => this.activate());
      return;
    }
    this.localError = null;
    this.receiptError = null;
    this.remoteError = null;
    this.terminal = false;
    this.synced = false;
    this.inFlight = undefined;
    clearTimeout(this.ackTimer);
    this.publish();
    void this.flush().then(() => {
      if (!this.destroyed && !this.localError) this.transport.retry();
    });
  }

  exportRecovery(): string {
    return JSON.stringify({
      format: 'kikit-recovery', formatVersion: 1, schemaVersion: DOCUMENT_SCHEMA_VERSION,
      accountId: DEV_ACCOUNT_ID, pageId: DEV_PAGE_ID, exportedAt: new Date().toISOString(),
      update: encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
      cachedUpdates: this.incompatibleCache.map(record => ({ batchId: record.id, update: encodeUpdate(record.update), pending: record.pending })),
      pending: [...this.pending.values(), ...this.writes.filter(write => write.record.pending).map(write => write.record)]
        .map(record => ({ batchId: record.id, update: encodeUpdate(record.update) })),
    }, null, 2);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.ackTimer);
    this.transport.destroy();
    window.removeEventListener('beforeunload', this.leave);
    this.doc.off('update', this.changed);
    this.doc.destroy();
    this.listeners.clear();
    void (this.flushing ?? Promise.resolve()).finally(() => this.store.close());
  }

  private describe(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
}
