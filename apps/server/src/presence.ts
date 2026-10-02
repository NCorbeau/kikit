import { createHash } from 'node:crypto';
import { MAX_PRESENCE_BYTES } from '@kikit/contracts';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
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

const MAX_FRAMES_PER_SECOND = 20;
const MAX_RETIRED_CLIENTS = 256;
const UINT32_MAX = 0xffff_ffff;
const COLORS = ['#2563eb', '#0f766e', '#9333ea', '#b45309', '#be123c', '#0369a1'];

type JsonObject = Record<string, unknown>;
type RelativeId = { client: number; clock: number };
type RelativePosition = {
  type?: RelativeId;
  tname?: 'title' | 'body';
  item?: RelativeId;
  assoc: number;
};
type Cursor = { anchor: RelativePosition; head: RelativePosition };
type ParticipantIdentity = { accountId: string; name: string; color: string };
type PresenceState = { user: ParticipantIdentity; cursor?: Cursor | null };
type PresenceFrame = { clientId: number; clock: number; state: PresenceState | null };
type SocketBinding = { clientId: number; accountId: string };
type FrameRate = { started: number; frames: number };
type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

function invalid(): never {
  throw new InvalidDocument();
}

function parseObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonObject;
}

function requireAllowedKeys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

function parseUint32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) invalid();
  return value;
}

function parseRelativeId(value: unknown): RelativeId {
  const parsed = parseObject(value);
  requireAllowedKeys(parsed, ['client', 'clock']);
  return { client: parseUint32(parsed.client), clock: parseUint32(parsed.clock) };
}

function parseRelativePosition(value: unknown): RelativePosition {
  const parsed = parseObject(value);
  requireAllowedKeys(parsed, ['type', 'tname', 'item', 'assoc']);
  const position: RelativePosition = { assoc: 0 };

  if (parsed.type != null) position.type = parseRelativeId(parsed.type);
  if (parsed.item != null) position.item = parseRelativeId(parsed.item);
  if (parsed.tname != null) {
    if (parsed.tname !== 'title' && parsed.tname !== 'body') invalid();
    position.tname = parsed.tname;
  }
  if (parsed.assoc != null) {
    if (typeof parsed.assoc !== 'number'
      || !Number.isInteger(parsed.assoc)
      || parsed.assoc < -1
      || parsed.assoc > 1) invalid();
    position.assoc = parsed.assoc;
  }

  const hasLocation = position.type || position.tname || position.item;
  if (!hasLocation || (position.type && position.tname)) invalid();
  return position;
}

function parseCursor(value: unknown): Cursor | null {
  if (value === null) return null;
  const parsed = parseObject(value);
  requireAllowedKeys(parsed, ['anchor', 'head']);
  return {
    anchor: parseRelativePosition(parsed.anchor),
    head: parseRelativePosition(parsed.head),
  };
}

function participantIdentity(principal: Principal): ParticipantIdentity {
  const name = (principal.name || principal.email || 'Participant')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 80) || 'Participant';
  const colorIndex = createHash('sha256').update(principal.accountId).digest().readUInt32BE(0) % COLORS.length;
  return { accountId: principal.accountId, name, color: COLORS[colorIndex]! };
}

function canonicalizeState(value: unknown, principal: Principal): PresenceState | null {
  if (value === null) return null;
  const parsed = parseObject(value);
  requireAllowedKeys(parsed, ['user', 'cursor']);
  // Claimed user data is discarded; only the authenticated principal supplies identity.
  return {
    user: participantIdentity(principal),
    ...('cursor' in parsed ? { cursor: parseCursor(parsed.cursor) } : {}),
  };
}

/** Validate the complete frame before reserving an ID or changing Awareness. */
function decodeFrame(update: Uint8Array, principal: Principal): PresenceFrame {
  try {
    const decoder = decoding.createDecoder(update);
    if (decoding.readVarUint(decoder) !== 1) invalid();
    const clientId = parseUint32(decoding.readVarUint(decoder));
    const clock = parseUint32(decoding.readVarUint(decoder));
    const state = canonicalizeState(JSON.parse(decoding.readVarString(decoder)), principal);
    if (decoding.hasContent(decoder)) invalid();
    return { clientId, clock, state };
  } catch {
    invalid();
  }
}

function encodeFrame({ clientId, clock, state }: PresenceFrame): Uint8Array {
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
    if (update.byteLength > MAX_PRESENCE_BYTES) invalid();
    if (!this.admitFrame(socket)) return;

    const frame = decodeFrame(update, principal);
    this.reserveClientId(socket, principal, frame.clientId);
    applyAwarenessUpdate(this.awareness, encodeFrame(frame), socket);
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
    if (clientId === this.awareness.clientID) invalid();
    if (binding && (binding.clientId !== clientId || binding.accountId !== principal.accountId)) invalid();
    if (this.owners.has(clientId) && this.owners.get(clientId) !== socket) invalid();

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
