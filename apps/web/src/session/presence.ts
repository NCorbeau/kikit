import type { Doc } from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { MAX_PRESENCE_BYTES } from '@kikit/contracts';

export interface Participant { clientId: number; accountId: string; name: string; color: string; local: boolean }
export interface PresenceSnapshot { connected: boolean; participants: Participant[] }
type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };
const REMOTE_PRESENCE = Symbol('remote-presence');
const SEND_INTERVAL_MS = 100;

/** Transient awareness owns no document bytes, journal records, receipts, or save state. */
export class DocumentPresence {
  readonly awareness: Awareness;
  private connected = false;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: PresenceSnapshot = { connected: false, participants: [] };
  private sendTimer?: ReturnType<typeof setTimeout>;
  private lastSent = -Infinity;

  constructor(doc: Doc, private readonly options: { accountId: string; send(update: Uint8Array): boolean }) {
    this.awareness = new Awareness(doc);
    this.awareness.setLocalState(null);
    this.awareness.on('change', this.changed);
    this.awareness.on('update', this.updated);
  }

  getSnapshot = (): PresenceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly changed = (): void => {
    if (this.destroyed) return;
    const participants: Participant[] = [];
    if (this.connected) for (const [clientId, state] of this.awareness.getStates()) {
      const user = state.user;
      if (!user || typeof user.accountId !== 'string' || typeof user.name !== 'string') continue;
      participants.push({
        clientId, accountId: user.accountId, name: user.name.slice(0, 80),
        color: /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#5083b7',
        local: clientId === this.awareness.clientID,
      });
    }
    participants.sort((a, b) => Number(b.local) - Number(a.local) || a.clientId - b.clientId);
    if (this.snapshot.connected === this.connected && participants.length === this.snapshot.participants.length
      && participants.every((item, index) => {
        const previous = this.snapshot.participants[index]!;
        return item.clientId === previous.clientId && item.accountId === previous.accountId
          && item.name === previous.name && item.color === previous.color && item.local === previous.local;
      })) return;
    this.snapshot = { connected: this.connected, participants };
    for (const listener of this.listeners) listener();
  };

  private readonly updated = ({ added, updated, removed }: AwarenessChange, origin: unknown): void => {
    if (!this.connected || this.destroyed || origin === REMOTE_PRESENCE
      || ![...added, ...updated, ...removed].includes(this.awareness.clientID)) return;
    if (this.sendTimer) return;
    const wait = SEND_INTERVAL_MS - (Date.now() - this.lastSent);
    if (wait <= 0) this.sendLocal();
    else this.sendTimer = setTimeout(this.sendLocal, wait);
  };

  private readonly sendLocal = (): void => {
    this.sendTimer = undefined;
    if (!this.connected || this.destroyed) return;
    const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
    if (update.byteLength > MAX_PRESENCE_BYTES) return;
    this.lastSent = Date.now();
    this.options.send(update);
  };

  /** Keep any initial peer snapshot received while durable hydration was finishing. */
  connect(): void {
    if (this.destroyed || this.connected) return;
    this.connected = true;
    this.lastSent = -Infinity;
    this.awareness.setLocalState({ user: { accountId: this.options.accountId, name: 'You', color: '#5083b7' }, cursor: null });
    this.changed();
  }

  disconnect(): void {
    if (this.destroyed) return;
    const wasConnected = this.connected;
    this.connected = false;
    clearTimeout(this.sendTimer); this.sendTimer = undefined;
    this.awareness.setLocalState(null);
    if (wasConnected) this.options.send(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
    removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()], REMOTE_PRESENCE);
    // A new socket supplies a fresh snapshot; stale clocks must not suppress its peers.
    for (const clientId of this.awareness.meta.keys()) if (clientId !== this.awareness.clientID) this.awareness.meta.delete(clientId);
    this.changed();
  }

  receive(update: Uint8Array): void {
    if (!this.destroyed) applyAwarenessUpdate(this.awareness, update, REMOTE_PRESENCE);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.disconnect();
    this.destroyed = true;
    this.awareness.off('change', this.changed);
    this.awareness.off('update', this.updated);
    this.awareness.destroy();
    this.listeners.clear();
  }
}
