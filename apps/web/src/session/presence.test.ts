import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { DocumentPresence } from './presence';
import { createDocumentSession, type SessionDependencies } from './index';
import type { DocumentStore, StoredUpdate } from './local-store';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, encodeUpdate, type ClientMessage } from '@kikit/contracts';

const resources: { destroy(): void }[] = [];
afterEach(() => { for (const resource of resources.splice(0).reverse()) resource.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  const doc = new Y.Doc(); resources.push(doc);
  const send = vi.fn((_update: Uint8Array) => true);
  const presence = new DocumentPresence(doc, { accountId: 'writer', send }); resources.push(presence);
  return { doc, presence, send };
}
function peer() {
  const doc = new Y.Doc(); resources.push(doc);
  const awareness = new Awareness(doc); resources.push(awareness);
  awareness.setLocalState({ user: { accountId: 'peer-account', name: 'Peer', color: '#2563eb' }, cursor: null });
  return { awareness, update: () => encodeAwarenessUpdate(awareness, [awareness.clientID]) };
}
function cursor(clock: number) {
  return { anchor: { tname: 'body', item: { client: 123, clock }, assoc: 0 }, head: { tname: 'body', item: { client: 123, clock }, assoc: 0 } };
}

it('keeps awareness outside Y.Doc updates and leaves participant snapshots stable during cursor motion', () => {
  const { doc, presence, send } = setup();
  const documentUpdate = vi.fn(); doc.on('update', documentUpdate);
  presence.connect();
  const snapshot = presence.getSnapshot();
  presence.awareness.setLocalStateField('cursor', cursor(1));
  expect(presence.getSnapshot()).toBe(snapshot);
  expect(documentUpdate).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
});

it('retains a peer snapshot received before durable hydration connects local presence', () => {
  const { presence, send } = setup(); const remote = peer();
  presence.receive(remote.update());
  expect(presence.getSnapshot()).toEqual({ connected: false, participants: [] });
  presence.connect();
  expect(presence.getSnapshot().participants.map(item => item.name)).toEqual(['You', 'Peer']);
  expect(send).toHaveBeenCalledOnce();
  remote.awareness.setLocalState(null);
  presence.receive(remote.update());
  expect(presence.getSnapshot().participants.map(item => item.name)).toEqual(['You']);
  // Peer updates and removals are never reflected back as another client's state.
  expect(send).toHaveBeenCalledOnce();
});

it('clears cursors and peers while offline, then reannounces local presence without stale peer clocks', () => {
  vi.useFakeTimers();
  const { presence, send } = setup(); const remote = peer();
  presence.connect(); presence.receive(remote.update());
  presence.awareness.setLocalStateField('cursor', cursor(1));
  presence.disconnect();
  expect(presence.awareness.getLocalState()).toBeNull();
  expect(presence.awareness.getStates().size).toBe(0);
  expect(presence.getSnapshot()).toEqual({ connected: false, participants: [] });
  const disconnectedSends = send.mock.calls.length;
  presence.awareness.setLocalStateField('cursor', cursor(2));
  vi.advanceTimersByTime(40_000);
  expect(send).toHaveBeenCalledTimes(disconnectedSends);
  presence.receive(remote.update()); presence.connect();
  expect(presence.getSnapshot().participants.map(item => item.name)).toEqual(['You', 'Peer']);
  expect(presence.awareness.getLocalState()?.cursor).toBeNull();
  expect(send).toHaveBeenCalledTimes(disconnectedSends + 1);
});

it('coalesces rapid cursor changes and sends only the latest local state', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { presence, send } = setup(); const recipient = peer();
  presence.connect();
  for (let clock = 0; clock < 50; clock++) presence.awareness.setLocalStateField('cursor', cursor(clock));
  expect(send).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(100);
  expect(send).toHaveBeenCalledTimes(2);
  applyAwarenessUpdate(recipient.awareness, send.mock.calls.at(-1)![0], 'server');
  expect(recipient.awareness.getStates().get(presence.awareness.clientID)?.cursor).toEqual(cursor(49));
});

it('removes an expired peer without affecting local presence and releases timers/listeners on destroy', () => {
  vi.useFakeTimers();
  const { presence, send } = setup(); const remote = peer();
  presence.connect(); presence.receive(remote.update());
  remote.awareness.destroy();
  // lib0 captures Date.now at import time, so age this heartbeat before running its real timeout sweep.
  presence.awareness.meta.get(remote.awareness.clientID)!.lastUpdated -= 33_000;
  vi.advanceTimersByTime(3_000);
  expect(presence.getSnapshot().participants.map(item => item.name)).toEqual(['You']);
  presence.destroy();
  const calls = send.mock.calls.length;
  vi.advanceTimersByTime(60_000);
  expect(send).toHaveBeenCalledTimes(calls);
  removeAwarenessStates(presence.awareness, [], 'ignored');
});

it('handles peer awareness while document persistence is blocked without adding journal records or changing save state', async () => {
  vi.stubGlobal('window', new EventTarget());
  let release!: () => void;
  let gate: Promise<void> | undefined = new Promise(resolve => { release = resolve; });
  const records: StoredUpdate[] = [];
  const store: DocumentStore = {
    load: async () => ({ initialized: false, updates: [] }),
    append: async record => { await gate; records.push(record); },
    acknowledge: async () => {}, close() {},
  };
  let callbacks!: Parameters<NonNullable<SessionDependencies['transport']>>[0];
  const sent: ClientMessage[] = [];
  const session = createDocumentSession({ store, transport: next => {
    callbacks = next;
    return { start() { callbacks.connection('connecting'); }, retry() {}, reconnect() {},
      stopWithError() { callbacks.connection('error'); }, send(message) { sent.push(message); return true; }, destroy() {} };
  } }); resources.push(session);
  const server = new Y.Doc(); resources.push(server);
  const paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText(); text.insert(0, 'Title'); paragraph.insert(0, [text]);
  server.getXmlFragment('title').insert(0, [paragraph]);
  const remote = peer();
  await session.start();
  const synchronization = callbacks.message({ type: 'sync', protocolVersion: PROTOCOL_VERSION,
    schemaVersion: DOCUMENT_SCHEMA_VERSION, sequence: 0, update: encodeUpdate(Y.encodeStateAsUpdate(server)) });
  callbacks.presence(remote.update());
  expect(session.presence.getSnapshot().connected).toBe(false);
  expect(sent.filter(message => message.type === 'presence')).toHaveLength(0);
  release(); await synchronization; gate = undefined;
  expect(session.presence.getSnapshot().participants).toHaveLength(2);
  expect(records).toHaveLength(1);
  gate = new Promise(resolve => { release = resolve; });
  ((session.doc.getXmlFragment('title').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'Pending ');
  const saving = session.getSnapshot();
  expect(saving.local).toBe('saving');
  remote.awareness.setLocalStateField('cursor', cursor(2));
  callbacks.presence(remote.update());
  expect(session.getSnapshot()).toBe(saving);
  expect(records).toHaveLength(1);
  release();
  await vi.waitFor(() => expect(session.getSnapshot().local).toBe('saved'));
  expect(records).toHaveLength(2);
  expect(sent.filter(message => message.type === 'update')).toHaveLength(1);
});
