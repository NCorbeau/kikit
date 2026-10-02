import { createHash } from 'node:crypto';
import { MAX_PRESENCE_BYTES } from '@kikit/contracts';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { WebSocket } from 'ws';
import type { Principal } from './pages.js';
import { InvalidDocument } from './sync-protocol.js';

const MAX_FRAMES_PER_SECOND = 20;
const MAX_RETIRED_CLIENTS = 256;
const UINT32_MAX = 0xffff_ffff;
const COLORS = ['#2563eb', '#0f766e', '#9333ea', '#b45309', '#be123c', '#0369a1'];

type JsonObject = Record<string, unknown>;
type RelativeId = { client: number; clock: number };
type RelativePosition = { type?: RelativeId; tname?: 'title' | 'body'; item?: RelativeId; assoc: number };
type Cursor = { anchor: RelativePosition; head: RelativePosition };
type Binding = { clientId: number; accountId: string };
type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

function invalid(): never { throw new InvalidDocument(); }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonObject;
}
function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function uint32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) invalid();
  return value;
}
function relativeId(value: unknown): RelativeId {
  const parsed = object(value);
  keys(parsed, ['client', 'clock']);
  return { client: uint32(parsed.client), clock: uint32(parsed.clock) };
}
function relativePosition(value: unknown): RelativePosition {
  const parsed = object(value);
  keys(parsed, ['type', 'tname', 'item', 'assoc']);
  const result: RelativePosition = { assoc: 0 };
  if (parsed.type != null) result.type = relativeId(parsed.type);
  if (parsed.item != null) result.item = relativeId(parsed.item);
  if (parsed.tname != null) {
    if (parsed.tname !== 'title' && parsed.tname !== 'body') invalid();
    result.tname = parsed.tname;
  }
  if (parsed.assoc != null) {
    if (typeof parsed.assoc !== 'number' || !Number.isInteger(parsed.assoc) || parsed.assoc < -1 || parsed.assoc > 1) invalid();
    result.assoc = parsed.assoc;
  }
  if ((!result.type && !result.tname && !result.item) || (result.type && result.tname)) invalid();
  return result;
}
function cursor(value: unknown): Cursor | null {
  if (value === null) return null;
  const parsed = object(value);
  keys(parsed, ['anchor', 'head']);
  return { anchor: relativePosition(parsed.anchor), head: relativePosition(parsed.head) };
}
function canonicalState(value: unknown, principal: Principal): JsonObject | null {
  if (value === null) return null;
  const parsed = object(value);
  keys(parsed, ['user', 'cursor']);
  const label = (principal.name || principal.email || 'Participant').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Participant';
  const color = COLORS[createHash('sha256').update(principal.accountId).digest().readUInt32BE(0) % COLORS.length]!;
  return {
    user: { accountId: principal.accountId, name: label, color },
    ...('cursor' in parsed ? { cursor: cursor(parsed.cursor) } : {}),
  };
}
function encodeFrame(clientId: number, clock: number, state: JsonObject | null): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

/** Transient, socket-owned awareness. Authorization and ordering belong to SyncRooms. */
export class RoomPresence {
  private readonly awareness: Awareness;
  private readonly bindings = new Map<WebSocket, Binding>();
  private readonly owners = new Map<number, WebSocket>();
  private readonly rates = new Map<WebSocket, { started: number; frames: number }>();
  private readonly retired = new Map<number, true>();
  private destroyed = false;

  constructor(doc: Y.Doc, private readonly broadcast: (update: Uint8Array) => void) {
    this.awareness = new Awareness(doc);
    // The server never appears as a participant or refreshes a local heartbeat.
    this.awareness.setLocalState(null);
    this.awareness.on('update', this.changed);
    this.awareness.on('destroy', this.destroyedAwareness);
  }

  private readonly changed = ({ added, updated, removed }: AwarenessChange) => {
    if (this.destroyed) return;
    const clients = [...added, ...updated, ...removed];
    if (clients.length) this.broadcast(encodeAwarenessUpdate(this.awareness, clients));
  };

  private readonly destroyedAwareness = () => {
    this.destroyed = true;
    this.bindings.clear(); this.owners.clear(); this.rates.clear(); this.retired.clear();
    this.awareness.states.clear(); this.awareness.meta.clear();
    this.awareness.off('update', this.changed);
  };

  /** Over-budget cursor motion is dropped; malformed or impersonating frames fail. */
  accept(socket: WebSocket, principal: Principal, update: Uint8Array): void {
    if (this.destroyed) return;
    if (update.byteLength > MAX_PRESENCE_BYTES) invalid();
    const now = Date.now();
    let rate = this.rates.get(socket);
    if (!rate || now - rate.started >= 1000 || now < rate.started) {
      rate = { started: now, frames: 0 };
      this.rates.set(socket, rate);
    }
    if (++rate.frames > MAX_FRAMES_PER_SECOND) return;

    let clientId: number;
    let clock: number;
    let state: JsonObject | null;
    try {
      const decoder = decoding.createDecoder(update);
      if (decoding.readVarUint(decoder) !== 1) invalid();
      clientId = uint32(decoding.readVarUint(decoder));
      clock = uint32(decoding.readVarUint(decoder));
      state = canonicalState(JSON.parse(decoding.readVarString(decoder)), principal);
      if (decoding.hasContent(decoder)) invalid();
    } catch { invalid(); }

    const binding = this.bindings.get(socket);
    if (clientId === this.awareness.clientID
      || (binding && (binding.clientId !== clientId || binding.accountId !== principal.accountId))
      || (this.owners.has(clientId) && this.owners.get(clientId) !== socket)) invalid();
    // A null state or timeout does not release a live socket's reserved ID.
    if (!binding) {
      this.bindings.set(socket, { clientId, accountId: principal.accountId });
      this.owners.set(clientId, socket);
      this.retired.delete(clientId);
    }
    applyAwarenessUpdate(this.awareness, encodeFrame(clientId, clock, state), socket);
  }

  remove(socket: WebSocket): void {
    this.rates.delete(socket);
    const binding = this.bindings.get(socket);
    if (!binding) return;
    this.bindings.delete(socket);
    this.owners.delete(binding.clientId);
    removeAwarenessStates(this.awareness, [binding.clientId], 'socket-removed');
    // Awareness retains clocks for departed clients. Keep a bounded recent tail,
    // while every currently reserved ID keeps its metadata until socket removal.
    this.retired.delete(binding.clientId);
    this.retired.set(binding.clientId, true);
    while (this.retired.size > MAX_RETIRED_CLIENTS) {
      const oldest = this.retired.keys().next().value!;
      this.retired.delete(oldest);
      this.awareness.meta.delete(oldest);
    }
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
}
