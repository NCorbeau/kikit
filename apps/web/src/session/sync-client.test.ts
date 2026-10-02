import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { SyncClient } from './sync-client';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const fixture = {
  accountId: DEV_ACCOUNT_ID,
  pageId: DEV_PAGE_ID,
  protocolVersion: PROTOCOL_VERSION,
  schemaVersion: DOCUMENT_SCHEMA_VERSION
};
const clients: SyncClient[] = [];

beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('location', new URL('http://127.0.0.1:5173/'));
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture))));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness() {
  const callbacks = {
    connection: vi.fn(),
    error: vi.fn(),
    presence: vi.fn(),
    message: vi.fn(async (_message: ServerMessage) => { })
  };
  const client = new SyncClient(callbacks);
  clients.push(client);
  return { client, callbacks };
}

async function connected() {
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0];
}

describe('sync transport', () => {

  it('verifies the live fixture before constructing a same-origin WebSocket', async () => {
    const { client, callbacks } = harness();
    client.start();
    const socket = await connected();
    socket.onopen?.();
    expect(socket.url.href).toBe('ws://127.0.0.1:5173/api/sync');
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'hello',
      pageId: DEV_PAGE_ID,
      accountId: DEV_ACCOUNT_ID,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION
    });
    expect(fetch).toHaveBeenCalledWith('/api/dev/session', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(callbacks.connection).not.toHaveBeenCalledWith('online');
  });

  it.each([{ ...fixture, accountId: 'other-account' }, { ...fixture, schemaVersion: 99 }, null])('rejects changed or malformed fixture identity without opening a socket (%j)', async value => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(value)));
    const { client, callbacks } = harness();
    client.start();
    await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('preserved'), true));
    expect(Socket.instances).toHaveLength(0);
    expect(callbacks.connection).toHaveBeenLastCalledWith('error');
  });

  it('serializes server frames while local persistence is awaiting its transaction', async () => {
    const { client, callbacks } = harness();
    let release!: () => void;
    callbacks.message.mockImplementationOnce(() => new Promise<void>(resolve => {
      release = resolve;
    }));
    client.start();
    const socket = await connected();
    socket.message({
      type: 'sync',
      ...{ protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION },
      update: 'AAA=',
      sequence: 0
    });
    socket.message({
      type: 'committed',
      update: 'AAA=',
      sequence: 1
    });
    await vi.waitFor(() => expect(callbacks.message).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(callbacks.message).toHaveBeenCalledTimes(2));
    expect(callbacks.message.mock.calls.map(([frame]) => frame.type)).toEqual(['sync', 'committed']);
  });

  it('stops on an unsupported response and leaves reconnection to explicit retry', async () => {
    const { client, callbacks } = harness();
    client.start();
    const socket = await connected();
    socket.message({ type: 'unknown' });
    await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('unsupported'), true));
    expect(socket.readyState).toBe(3);
    expect(callbacks.connection).toHaveBeenLastCalledWith('error');
    client.retry();
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
  });

  it('delivers presence without waiting for durable persistence and ignores an old socket after reconnect', async () => {
    const { client, callbacks } = harness();
    let release!: () => void;
    callbacks.message.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    client.start();
    const socket = await connected();
    socket.message({ type: 'sync', protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION, update: 'AAA=', sequence: 0 });
    await vi.waitFor(() => expect(callbacks.message).toHaveBeenCalledTimes(1));
    const update = Uint8Array.of(1, 2, 3);
    socket.message({ type: 'presence', update: encodeUpdate(update) });
    expect(callbacks.presence).toHaveBeenCalledWith(update);
    expect(callbacks.message).toHaveBeenCalledTimes(1);
    client.retry();
    socket.message({ type: 'presence', update: encodeUpdate(update) });
    expect(callbacks.presence).toHaveBeenCalledTimes(1);
    release();
  });

  it('waits offline and treats HTTP denial as terminal without claiming a durable save', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { client, callbacks } = harness();
    client.start();
    expect(fetch).not.toHaveBeenCalled();
    expect(callbacks.connection).toHaveBeenLastCalledWith('offline');
    vi.stubGlobal('navigator', { onLine: true });
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 403 }));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('access'), true));
    expect(Socket.instances).toHaveLength(0);
  });
});
