import { randomUUID } from 'node:crypto';
import * as encoding from 'lib0/encoding';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { encodeUpdate } from '@kikit/contracts';
import { createSeed } from './document.js';
import { canAccessPage } from './pages.js';
import { commitUpdate, loadPage } from './persistence.js';
import { SyncRooms } from './sync-room.js';
import { TestFaults } from './test-faults.js';

vi.mock('./persistence.js', async importOriginal => ({
  ...await importOriginal<typeof import('./persistence.js')>(), loadPage: vi.fn(), commitUpdate: vi.fn(),
}));
vi.mock('./pages.js', async importOriginal => ({
  ...await importOriginal<typeof import('./pages.js')>(), canAccessPage: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function client() {
  const transport = {
    readyState: 1, bufferedAmount: 0,
    send: vi.fn((_payload: string, callback: (error?: Error) => void) => callback()),
    close: vi.fn(() => { transport.readyState = 2; }), terminate: vi.fn(),
  };
  return { transport, socket: transport as unknown as WebSocket };
}
function presenceFrame(clientId: number): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, clientId); encoding.writeVarUint(encoder, 1);
  encoding.writeVarString(encoder, '{}');
  return encoding.toUint8Array(encoder);
}

describe('page queue ownership during transient/control overload', () => {
  let rooms: SyncRooms;
  beforeEach(() => {
    vi.mocked(loadPage).mockReset(); vi.mocked(commitUpdate).mockReset();
    vi.mocked(canAccessPage).mockReset().mockResolvedValue(true);
    rooms = new SyncRooms({} as pg.Pool, new TestFaults());
  });
  afterEach(() => { rooms.destroy(); });

  async function runningCommit() {
    const pageId = randomUUID();
    const seed = createSeed('', 'Original');
    const doc = new Y.Doc(); doc.clientID = 900; Y.applyUpdate(doc, seed);
    const destroyed = vi.fn(); doc.on('destroy', destroyed);
    vi.mocked(loadPage).mockImplementation(async () => {
      // Existing room joins discard their separately hydrated document.
      if (rooms.size) {
        const copy = new Y.Doc(); Y.applyUpdate(copy, seed);
        return { doc: copy, sequence: 0, snapshotSequence: 0, tailBytes: 0 };
      }
      return { doc, sequence: 0, snapshotSequence: 0, tailBytes: 0 };
    });
    const author = client(); const peer = client();
    await rooms.join(pageId, author.socket, { accountId: 'owner', sessionId: 'owner-session', name: 'Owner' });
    await rooms.join(pageId, peer.socket, { accountId: 'editor', sessionId: 'editor-session', name: 'Editor' });
    await rooms.presence(pageId, peer.socket, presenceFrame(100));

    const candidate = new Y.Doc(); Y.applyUpdate(candidate, seed);
    const vector = Y.encodeStateVector(candidate);
    const text = (candidate.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, 'Committed ');
    const update = Y.encodeStateAsUpdate(candidate, vector); candidate.destroy();
    const entered = deferred(); const finish = deferred();
    vi.mocked(commitUpdate).mockImplementation(async (_pool, _page, _account, _batch, _bytes, hooks) => {
      hooks?.validate?.(); entered.resolve(); await finish.promise;
      return { sequence: 1, duplicate: false };
    });
    const batchId = randomUUID();
    const commit = rooms.update(pageId, author.socket, { type: 'update', batchId, update: encodeUpdate(update) }, update);
    await entered.promise;
    // Fill the real admission limit behind the running commit. No task can
    // release its serialization slot while persistence is still unresolved.
    const waiting = Array.from({ length: 63 }, () => rooms.queues.run(pageId, 0, async () => undefined));
    return { pageId, doc, destroyed, author, peer, finish, commit, waiting, batchId };
  }

  it('closes transports on failed revalidation admission without destroying an in-flight commit', async () => {
    const running = await runningCommit();
    try {
      await rooms.revalidate();
      expect(running.author.transport.close).toHaveBeenCalled();
      expect(running.peer.transport.close).toHaveBeenCalled();
      expect(running.destroyed).not.toHaveBeenCalled();
      expect(rooms.size).toBe(1);
    } finally {
      running.finish.resolve(); await running.commit; await Promise.all(running.waiting);
    }
    expect(running.destroyed).not.toHaveBeenCalled();
    expect(running.doc.getXmlFragment('body').toString()).toContain('Committed Original');
    // Actual close events trigger cleanup only after accepted work has settled.
    rooms.leave(running.pageId, running.author.socket); rooms.leave(running.pageId, running.peer.socket);
    await rooms.queues.run(running.pageId, 0, async () => undefined);
    expect(running.destroyed).toHaveBeenCalledTimes(1);
  });

  it('drops an overloaded presence-removal broadcast while an accepted document commit completes', async () => {
    const running = await runningCommit();
    try {
      // Socket close removes transient awareness outside the queue. Its outgoing
      // notification cannot be admitted while all existing slots are occupied.
      rooms.leave(running.pageId, running.peer.socket);
      await Promise.resolve();
      expect(running.destroyed).not.toHaveBeenCalled();
      expect(running.author.transport.close).not.toHaveBeenCalled();
    } finally {
      running.finish.resolve(); await running.commit; await Promise.all(running.waiting);
    }
    expect(running.destroyed).not.toHaveBeenCalled();
    expect(running.doc.getXmlFragment('body').toString()).toContain('Committed Original');
    const messages = running.author.transport.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(messages).toContainEqual({ type: 'ack', batchId: running.batchId, sequence: 1 });
  });
});
