import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import { RoomPresence } from './presence.js';
import { InvalidDocument } from './sync-protocol.js';
import type { Principal } from './pages.js';

const owner: Principal = { accountId: 'account-owner', sessionId: 'session-owner', name: 'Owner' };
const editor: Principal = { accountId: 'account-editor', sessionId: 'session-editor', name: 'Editor' };
const position = { type: null, tname: 'body', item: null, assoc: 0 };
const cursor = { anchor: position, head: { ...position, assoc: -1 } };
const socket = () => ({}) as WebSocket;

function frame(clientId: number, clock: number, state: unknown, count = 1): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, count);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}
function decode(update: Uint8Array | null): { clientId: number; clock: number; state: Record<string, any> | null }[] {
  if (!update) return [];
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  return Array.from({ length: count }, () => ({
    clientId: decoding.readVarUint(decoder), clock: decoding.readVarUint(decoder),
    state: JSON.parse(decoding.readVarString(decoder)),
  }));
}

describe('authorized transient room presence', () => {
  const resources: (() => void)[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T12:00:00Z')); });
  afterEach(() => { for (const release of resources.splice(0)) release(); vi.useRealTimers(); });

  function harness() {
    const doc = new Y.Doc(); doc.clientID = 900;
    const broadcast = vi.fn();
    const presence = new RoomPresence(doc, broadcast);
    resources.push(() => { presence.destroy(); doc.destroy(); });
    return { doc, broadcast, presence };
  }

  it('broadcasts authenticated identity and compatible cursor bytes without changing document history', () => {
    const { doc, broadcast, presence } = harness();
    const documentUpdate = vi.fn(); doc.on('update', documentUpdate);
    const before = Y.encodeStateAsUpdate(doc);
    presence.accept(socket(), owner, frame(100, 1, {
      user: { accountId: 'forged', name: '<img onerror=alert(1)>', color: 'url(javascript:alert(1))' }, cursor,
    }));
    const state = decode(presence.encodeState())[0]!;
    expect(state).toMatchObject({ clientId: 100, clock: 1, state: {
      user: { accountId: owner.accountId, name: 'Owner', color: expect.stringMatching(/^#[0-9a-f]{6}$/) },
      cursor: { anchor: { tname: 'body', assoc: 0 }, head: { tname: 'body', assoc: -1 } },
    } });
    expect(JSON.stringify(state)).not.toContain('forged');
    expect(JSON.stringify(state)).not.toContain('onerror');
    expect(broadcast).toHaveBeenCalledTimes(1);
    const peerDoc = new Y.Doc(); peerDoc.clientID = 901;
    const peer = new Awareness(peerDoc); peer.setLocalState(null);
    applyAwarenessUpdate(peer, broadcast.mock.calls[0]![0], 'server');
    expect(peer.getStates().get(100)).toEqual(state.state);
    peer.destroy(); peerDoc.destroy();
    expect(documentUpdate).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('reserves one client ID per socket and prevents active identity impersonation', () => {
    const { presence } = harness();
    const first = socket(); const second = socket();
    presence.accept(first, owner, frame(100, 1, {}));
    expect(() => presence.accept(first, owner, frame(101, 2, {}))).toThrow(InvalidDocument);
    expect(() => presence.accept(second, editor, frame(100, 2, {}))).toThrow(InvalidDocument);
    expect(() => presence.accept(first, editor, frame(100, 2, {}))).toThrow(InvalidDocument);
    expect(() => presence.accept(second, editor, frame(900, 1, {}))).toThrow(InvalidDocument);
    expect(decode(presence.encodeState())).toHaveLength(1);
  });

  it('clears cursor/state on null and disconnect while retaining a live socket reservation', () => {
    const { presence, broadcast } = harness();
    const first = socket(); const second = socket();
    presence.accept(first, owner, frame(100, 1, { cursor }));
    presence.accept(first, owner, frame(100, 2, null));
    expect(presence.encodeState()).toBeNull();
    expect(decode(broadcast.mock.calls.at(-1)![0])).toEqual([{ clientId: 100, clock: 2, state: null }]);
    expect(() => presence.accept(second, editor, frame(100, 3, {}))).toThrow(InvalidDocument);
    presence.remove(first);
    presence.accept(second, editor, frame(100, 3, {}));
    expect(decode(presence.encodeState())[0]!.state!.user.accountId).toBe(editor.accountId);
    presence.remove(second);
    expect(presence.encodeState()).toBeNull();
    expect(decode(broadcast.mock.calls.at(-1)![0])[0]!.state).toBeNull();
  });

  it('expires an absent heartbeat and permits the same socket to resume with its next clock', () => {
    const { presence, broadcast } = harness();
    const first = socket();
    presence.accept(first, owner, frame(100, 1, {}));
    // lib0 captures the native Date.now at import. Age the actual last heartbeat
    // before advancing the real Awareness interval, without a 30-second sleep.
    const awareness = (presence as unknown as { awareness: Awareness }).awareness;
    awareness.meta.get(100)!.lastUpdated -= 31_000;
    vi.advanceTimersByTime(33_000);
    expect(presence.encodeState()).toBeNull();
    expect(decode(broadcast.mock.calls.at(-1)![0])[0]!.state).toBeNull();
    expect(() => presence.accept(socket(), editor, frame(100, 2, {}))).toThrow(InvalidDocument);
    presence.accept(first, owner, frame(100, 2, { cursor: null }));
    expect(decode(presence.encodeState())[0]!.state!.cursor).toBeNull();
  });

  it('preserves awareness clock ordering instead of rebroadcasting stale cursor frames', () => {
    const { presence, broadcast } = harness();
    const first = socket();
    presence.accept(first, owner, frame(100, 3, { cursor }));
    presence.accept(first, owner, frame(100, 2, { cursor: null }));
    presence.accept(first, owner, frame(100, 3, { cursor: null }));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(decode(presence.encodeState())[0]!.clock).toBe(3);
    presence.accept(first, owner, frame(100, 3, null));
    expect(presence.encodeState()).toBeNull();
  });

  it('validates the entire bounded frame before applying any participant state', () => {
    const { presence, broadcast } = harness();
    const first = socket();
    const valid = frame(100, 1, {});
    for (const malformed of [new Uint8Array(), frame(100, 1, {}, 2),
      new Uint8Array([...valid, 0]), frame(2 ** 32, 1, {}), frame(100, 2 ** 32, {}),
      frame(100, 1, { user: { name: 'x'.repeat(5000) } }),
    ]) expect(() => presence.accept(first, owner, malformed)).toThrow(InvalidDocument);
    expect(presence.encodeState()).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
    // A malformed frame never claims its client ID or poisons a later valid join.
    presence.accept(first, owner, valid);
    expect(decode(presence.encodeState())).toHaveLength(1);
  });

  it.each([
    { note: 'extra document field', state: { content: '<script>alert(1)</script>' } },
    { note: 'non-object state', state: 'html' },
    { note: 'non-object cursor', state: { cursor: '<img>' } },
    { note: 'unknown fragment', state: { cursor: { anchor: { tname: 'secret' }, head: position } } },
    { note: 'invalid item ID', state: { cursor: { anchor: { item: { client: 1, clock: 2 ** 32 } }, head: position } } },
    { note: 'fractional ID', state: { cursor: { anchor: { type: { client: 1.5, clock: 1 } }, head: position } } },
    { note: 'invalid association', state: { cursor: { anchor: { ...position, assoc: 2 }, head: position } } },
    { note: 'empty position', state: { cursor: { anchor: {}, head: position } } },
    { note: 'extra cursor field', state: { cursor: { ...cursor, html: '<script>' } } },
  ])('rejects $note without modifying an established participant', ({ state }) => {
    const { presence, broadcast } = harness();
    const first = socket();
    presence.accept(first, owner, frame(100, 1, { cursor }));
    const before = presence.encodeState();
    expect(() => presence.accept(first, owner, frame(100, 2, state))).toThrow(InvalidDocument);
    expect(presence.encodeState()).toEqual(before);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('drops excess transient frames and resumes without rewriting the client clock', () => {
    const { presence, broadcast } = harness();
    const first = socket();
    for (let clock = 1; clock <= 30; clock++) presence.accept(first, owner, frame(100, clock, {}));
    expect(broadcast).toHaveBeenCalledTimes(20);
    expect(decode(presence.encodeState())[0]!.clock).toBe(20);
    vi.advanceTimersByTime(1000);
    presence.accept(first, owner, frame(100, 31, {}));
    expect(decode(presence.encodeState())[0]!.clock).toBe(31);
  });

  it('keeps departed-client metadata bounded under repeated reconnect churn', () => {
    const { presence } = harness();
    for (let clientId = 1; clientId <= 400; clientId++) {
      const client = socket(); presence.accept(client, owner, frame(clientId, 1, {})); presence.remove(client);
    }
    expect(presence.encodeState()).toBeNull();
    const awareness = (presence as unknown as { awareness: Awareness }).awareness;
    expect(awareness.meta.size).toBeLessThanOrEqual(257);
  });

  it.each(['room', 'document'])('clears state and timers on $0 destruction', source => {
    const { doc, presence, broadcast } = harness();
    const first = socket(); presence.accept(first, owner, frame(100, 1, {}));
    if (source === 'room') presence.destroy(); else doc.destroy();
    expect(presence.encodeState()).toBeNull();
    if (source === 'room') expect(decode(broadcast.mock.calls.at(-1)![0])[0]!.state).toBeNull();
    const calls = broadcast.mock.calls.length;
    presence.accept(first, owner, frame(100, 2, {}));
    vi.advanceTimersByTime(60_000);
    expect(broadcast).toHaveBeenCalledTimes(calls);
    doc.destroy();
    expect(presence.encodeState()).toBeNull();
  });
});
