import { createHash } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Principal } from './pages.js';
import { InvalidDocument } from './sync-protocol.js';

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
export type PresenceFrame = { clientId: number; clock: number; state: PresenceState | null };

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
export function decodePresenceFrame(update: Uint8Array, principal: Principal): PresenceFrame {
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

export function encodePresenceFrame({ clientId, clock, state }: PresenceFrame): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}
