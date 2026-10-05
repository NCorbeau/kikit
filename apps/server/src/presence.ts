import { MAX_PRESENCE_BYTES } from '@kikit/contracts';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { WebSocket } from 'ws';
import type { Principal } from './pages.js';
import { InvalidDocument } from './sync-protocol.js';
import { decodePresenceFrame, encodePresenceFrame } from './presence-frame.js';

const MAX_FRAMES_PER_SECOND = 20;
const MAX_RETIRED_CLIENTS = 256;
type SocketBinding = { clientId: number; accountId: string };
type FrameRate = { started: number; frames: number };
type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/** Transient, socket-owned awareness. Authorization and ordering belong to SyncRooms. */
export class RoomPresence {
  private readonly awareness: Awareness;
  private readonly bindings = new Map<WebSocket, SocketBinding>();
  private readonly owners = new Map<number, WebSocket>();
  private readonly rates = new Map<WebSocket, FrameRate>();
  private readonly retired = new Map<number, true>();
  private destroyed = false;

  constructor(doc: Y.Doc, private readonly broadcast: (update: Uint8Array) => void) {
    this.awareness = new Awareness(doc);
    // The server never appears as a participant or refreshes a local heartbeat.
    this.awareness.setLocalState(null);
    this.awareness.on('update', this.broadcastChanges);
    this.awareness.on('destroy', this.disposeAwareness);
  }

  /** Over-budget cursor motion is dropped; malformed or impersonating frames fail. */
  accept(socket: WebSocket, principal: Principal, update: Uint8Array): void {
    if (this.destroyed) return;
    if (update.byteLength > MAX_PRESENCE_BYTES) throw new InvalidDocument();
    if (!this.admitFrame(socket)) return;

    const frame = decodePresenceFrame(update, principal);
    this.reserveClientId(socket, principal, frame.clientId);
    applyAwarenessUpdate(this.awareness, encodePresenceFrame(frame), socket);
  }

  remove(socket: WebSocket): void {
    this.rates.delete(socket);
    const binding = this.bindings.get(socket);
    if (!binding) return;

    this.bindings.delete(socket);
    this.owners.delete(binding.clientId);
    removeAwarenessStates(this.awareness, [binding.clientId], 'socket-removed');
    this.retainDepartedClock(binding.clientId);
  }

  encodeState(): Uint8Array | null {
    const clients = [...this.awareness.getStates().keys()];
    return !this.destroyed && clients.length ? encodeAwarenessUpdate(this.awareness, clients) : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()], 'room-destroyed');
    this.awareness.destroy();
  }

  private admitFrame(socket: WebSocket): boolean {
    const now = Date.now();
    let rate = this.rates.get(socket);
    if (!rate || now - rate.started >= 1000 || now < rate.started) {
      rate = { started: now, frames: 0 };
      this.rates.set(socket, rate);
    }
    return ++rate.frames <= MAX_FRAMES_PER_SECOND;
  }

  private reserveClientId(socket: WebSocket, principal: Principal, clientId: number): void {
    const binding = this.bindings.get(socket);
    if (clientId === this.awareness.clientID) throw new InvalidDocument();
    if (binding && (binding.clientId !== clientId || binding.accountId !== principal.accountId)) throw new InvalidDocument();
    if (this.owners.has(clientId) && this.owners.get(clientId) !== socket) throw new InvalidDocument();

    // A null state or timeout does not release a live socket's reserved ID.
    if (!binding) {
      this.bindings.set(socket, { clientId, accountId: principal.accountId });
      this.owners.set(clientId, socket);
      this.retired.delete(clientId);
    }
  }

  private retainDepartedClock(clientId: number): void {
    // Awareness retains clocks for departed clients. Keep a bounded recent tail,
    // while every currently reserved ID keeps its metadata until socket removal.
    this.retired.delete(clientId);
    this.retired.set(clientId, true);
    while (this.retired.size > MAX_RETIRED_CLIENTS) {
      const oldest = this.retired.keys().next().value!;
      this.retired.delete(oldest);
      this.awareness.meta.delete(oldest);
    }
  }

  private readonly broadcastChanges = ({ added, updated, removed }: AwarenessChange): void => {
    if (this.destroyed) return;
    const clients = [...added, ...updated, ...removed];
    if (clients.length) this.broadcast(encodeAwarenessUpdate(this.awareness, clients));
  };

  private readonly disposeAwareness = (): void => {
    this.destroyed = true;
    this.bindings.clear();
    this.owners.clear();
    this.rates.clear();
    this.retired.clear();
    this.awareness.states.clear();
    this.awareness.meta.clear();
    this.awareness.off('update', this.broadcastChanges);
  };
}
