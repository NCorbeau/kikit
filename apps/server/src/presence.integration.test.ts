import { randomUUID } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import pg from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { createServer } from './app.js';
import { migrateDatabase } from './migrations.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;
interface Account { accountId: string; cookie: string; sessionId: string; name: string }
interface State { user: { accountId: string; name: string; color: string }; cursor?: unknown }
interface Frame { clientId: number; clock: number; state: State | null }
type Message = ServerMessage | { type: 'presence'; update: string };
interface Connection { socket: WebSocket; messages: Message[]; frames: Frame[]; states: Map<number, State> }

function presenceFrame(clientId: number, clock: number, state: unknown): string {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encodeUpdate(encoding.toUint8Array(encoder));
}

function decodePresence(update: string): Frame[] {
  const decoder = decoding.createDecoder(decodeUpdate(update));
  const count = decoding.readVarUint(decoder);
  return Array.from({ length: count }, () => ({
    clientId: decoding.readVarUint(decoder), clock: decoding.readVarUint(decoder),
    state: JSON.parse(decoding.readVarString(decoder)) as State | null,
  }));
}

describe.skipIf(!databaseUrl)('authenticated transient presence through real WebSockets and PostgreSQL', () => {
  const origin = 'http://127.0.0.1:5200';
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const mail = new Map<string, string>();
  const users: Account[] = [];
  const pages: string[] = [];
  const sockets: WebSocket[] = [];
  let peer = 100;
  let app: Awaited<ReturnType<typeof createServer>>;
  let address: string;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('KIKIT_DEV_FIXTURE', '0');
    vi.stubEnv('BETTER_AUTH_SECRET', 'presence-test-secret-never-used-in-production');
    await migrateDatabase(pool);
    app = await createServer({ databaseUrl, origin, sendMagicLink: async ({ email, url }) => { mail.set(email, url); } });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    for (const id of pages) {
      await pool.query('DELETE FROM page_invitations WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM receipts WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM document_updates WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM page_grants WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM pages WHERE id=$1', [id]);
    }
    for (const account of users) await pool.query('DELETE FROM auth_user WHERE id=$1', [account.accountId]);
    await pool.end(); vi.unstubAllEnvs();
  });

  async function login(): Promise<Account> {
    const email = `${randomUUID()}@example.test`; const remoteAddress = `127.0.3.${++peer}`;
    const sent = await app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', remoteAddress, headers: { origin }, payload: { email, callbackURL: '/' } });
    expect(sent.statusCode).toBe(200);
    const link = new URL(mail.get(email)!);
    const verified = await app.inject({ url: link.pathname + link.search, remoteAddress });
    expect(verified.statusCode).toBe(302);
    const cookies = verified.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const identity = await app.inject({ url: '/api/session', headers: { cookie } });
    expect(identity.statusCode).toBe(200);
    const accountId = identity.json().accountId as string;
    const name = `Presence reader ${peer}`;
    // The canonical label must come from the trusted user row, not the wire payload.
    await pool.query('UPDATE auth_user SET name=$2 WHERE id=$1', [accountId, name]);
    const sessionId = (await pool.query('SELECT id FROM auth_session WHERE user_id=$1', [accountId])).rows[0].id as string;
    const account = { accountId, cookie, sessionId, name }; users.push(account); return account;
  }

  async function create(owner: Account): Promise<string> {
    const id = randomUUID(); pages.push(id);
    expect((await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie: owner.cookie }, payload: { id } })).statusCode).toBe(200);
    return id;
  }

  async function share(owner: Account, member: Account, pageId: string): Promise<void> {
    const invitation = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/invitation`, headers: { origin, cookie: owner.cookie } });
    expect(invitation.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/invitations/join', headers: { origin, cookie: member.cookie }, payload: invitation.json() })).statusCode).toBe(200);
  }

  async function connect(account: Account, pageId: string, protocolVersion = PROTOCOL_VERSION, expectedAccountId = account.accountId): Promise<Connection> {
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}/api/sync`, { origin, headers: { cookie: account.cookie } });
    sockets.push(socket);
    const connection: Connection = { socket, messages: [], frames: [], states: new Map() };
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as Message;
      connection.messages.push(message);
      if (message.type === 'presence') for (const frame of decodePresence(message.update)) {
        connection.frames.push(frame);
        if (frame.state) connection.states.set(frame.clientId, frame.state);
        else connection.states.delete(frame.clientId);
      }
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', accountId: expectedAccountId, pageId, protocolVersion, schemaVersion: DOCUMENT_SCHEMA_VERSION }));
    return connection;
  }

  async function synchronized(connection: Connection): Promise<void> {
    await vi.waitFor(() => expect(connection.messages.some(message => message.type === 'sync')).toBe(true));
  }

  function announce(connection: Connection, clientId: number, clock: number, state: unknown = {}): void {
    connection.socket.send(JSON.stringify({ type: 'presence', update: presenceFrame(clientId, clock, state) }));
  }

  async function durableState(pageId: string) {
    const page = (await pool.query('SELECT owner_id, title, sequence, initial_state FROM pages WHERE id=$1', [pageId])).rows;
    const updates = (await pool.query('SELECT sequence, payload FROM document_updates WHERE page_id=$1 ORDER BY sequence', [pageId])).rows;
    const receipts = (await pool.query('SELECT batch_id, sequence, payload_hash FROM receipts WHERE page_id=$1 ORDER BY sequence', [pageId])).rows;
    const invitation = (await pool.query('SELECT token_hash, disabled, created_at FROM page_invitations WHERE page_id=$1', [pageId])).rows;
    return { page, updates, receipts, invitation };
  }

  it('broadcasts canonical authenticated identity/cursors, seeds reconnects, and leaves durable page/invitation state unchanged', async () => {
    expect(PROTOCOL_VERSION).toBe(2);
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await share(owner, member, pageId);
    const before = await durableState(pageId);
    const first = await connect(owner, pageId); const second = await connect(member, pageId);
    await synchronized(first); await synchronized(second);
    announce(first, 1001, 1);
    await vi.waitFor(() => expect(second.states.has(1001)).toBe(true));
    const cursor = { anchor: { tname: 'body', assoc: 0 }, head: { tname: 'body', assoc: -1 } };
    announce(second, 2001, 1, { user: { accountId: owner.accountId, name: 'Spoofed owner', color: 'red' }, cursor });
    await vi.waitFor(() => expect(first.states.get(2001)).toEqual({ user: {
      accountId: member.accountId, name: member.name, color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    }, cursor }));
    expect(JSON.stringify(first.states.get(2001))).not.toContain('Spoofed owner');
    const third = await connect(owner, pageId); await synchronized(third);
    await vi.waitFor(() => expect([...third.states.keys()].sort()).toEqual([1001, 2001]));
    second.socket.close();
    await vi.waitFor(() => expect(second.socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(first.states.has(2001)).toBe(false));
    expect(first.frames.some(frame => frame.clientId === 2001 && frame.state === null)).toBe(true);
    const reconnected = await connect(member, pageId); await synchronized(reconnected);
    await vi.waitFor(() => expect(reconnected.states.has(1001)).toBe(true));
    announce(reconnected, 2002, 1, { cursor: null });
    await vi.waitFor(() => expect(first.states.get(2002)?.user.accountId).toBe(member.accountId));
    expect(first.states.has(2001)).toBe(false);
    expect(await durableState(pageId)).toEqual(before);
    expect(first.messages.some(message => message.type === 'committed' || message.type === 'ack')).toBe(false);
  });

  it('closes only a socket attempting another active client ID and keeps authorized peers usable', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await share(owner, member, pageId);
    const before = await durableState(pageId);
    const first = await connect(owner, pageId); const second = await connect(member, pageId);
    await synchronized(first); await synchronized(second);
    announce(first, 1002, 1);
    await vi.waitFor(() => expect(second.states.has(1002)).toBe(true));
    announce(second, 2003, 1);
    await vi.waitFor(() => expect(first.states.has(2003)).toBe(true));
    // Both accounts are authorized for this page; identity binding must still reject
    // a cookie switch after the HTTP session check but before the socket upgrade.
    const switched = await connect(member, pageId, PROTOCOL_VERSION, owner.accountId);
    await vi.waitFor(() => expect(switched.messages.some(message => message.type === 'error' && message.code === 'ACCESS_DENIED')).toBe(true));
    await vi.waitFor(() => expect(switched.socket.readyState).toBe(WebSocket.CLOSED));
    expect(switched.messages.some(message => message.type === 'sync' || message.type === 'presence')).toBe(false);
    const impersonator = await connect(member, pageId); await synchronized(impersonator);
    announce(impersonator, 1002, 2, { user: { accountId: owner.accountId } });
    await vi.waitFor(() => expect(impersonator.messages.some(message => message.type === 'error' && message.code === 'INVALID_DOCUMENT')).toBe(true));
    await vi.waitFor(() => expect(impersonator.socket.readyState).toBe(WebSocket.CLOSED));
    expect(first.socket.readyState).toBe(WebSocket.OPEN); expect(second.socket.readyState).toBe(WebSocket.OPEN);
    announce(first, 1002, 2, { cursor: null });
    await vi.waitFor(() => expect(second.frames.some(frame => frame.clientId === 1002 && frame.clock === 2)).toBe(true));
    expect(second.states.get(1002)?.user.accountId).toBe(owner.accountId);
    expect(await durableState(pageId)).toEqual(before);
  });

  it('denies private-page presence and older protocol handshakes without disclosing active participants', async () => {
    const owner = await login(); const outsider = await login(); const pageId = await create(owner);
    const before = await durableState(pageId);
    const first = await connect(owner, pageId); await synchronized(first);
    announce(first, 1003, 1);
    await vi.waitFor(() => expect(first.states.has(1003)).toBe(true));
    const denied = await connect(outsider, pageId);
    announce(denied, 3001, 1);
    await vi.waitFor(() => expect(denied.messages.some(message => message.type === 'error' && message.code === 'ACCESS_DENIED')).toBe(true));
    await vi.waitFor(() => expect(denied.socket.readyState).toBe(WebSocket.CLOSED));
    expect(denied.messages.some(message => message.type === 'sync' || message.type === 'presence')).toBe(false);
    const old = await connect(owner, pageId, 1);
    await vi.waitFor(() => expect(old.messages.some(message => message.type === 'error' && message.code === 'INCOMPATIBLE')).toBe(true));
    expect(old.messages.some(message => message.type === 'sync' || message.type === 'presence')).toBe(false);
    announce(first, 1003, 2);
    await vi.waitFor(() => expect(first.frames.some(frame => frame.clientId === 1003 && frame.clock === 2)).toBe(true));
    expect([...first.states.values()].map(state => state.user.accountId)).toEqual([owner.accountId]);
    expect(await durableState(pageId)).toEqual(before);
  });

  it('removes revoked presence before the membership mutation returns and denies reconnects', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await share(owner, member, pageId); const before = await durableState(pageId);
    const first = await connect(owner, pageId); const second = await connect(member, pageId);
    await synchronized(first); await synchronized(second);
    announce(first, 1004, 1); announce(second, 2004, 1);
    await vi.waitFor(() => expect(first.states.has(2004)).toBe(true));
    const removed = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/members/${member.accountId}`, headers: { origin, cookie: owner.cookie } });
    expect(removed.statusCode).toBe(200);
    await vi.waitFor(() => expect(second.socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(first.states.has(2004)).toBe(false));
    expect(first.frames.some(frame => frame.clientId === 2004 && frame.state === null)).toBe(true);
    const presenceBefore = second.frames.length;
    announce(first, 1004, 2);
    await vi.waitFor(() => expect(first.frames.some(frame => frame.clientId === 1004 && frame.clock === 2)).toBe(true));
    expect(second.frames).toHaveLength(presenceBefore);
    const denied = await connect(member, pageId);
    await vi.waitFor(() => expect(denied.messages.some(message => message.type === 'error' && message.code === 'ACCESS_DENIED')).toBe(true));
    expect(denied.messages.some(message => message.type === 'presence' || message.type === 'sync')).toBe(false);
    expect(await durableState(pageId)).toEqual(before);
  });

  it('clears presence on logout and validates session expiry before accepting another transient frame', async () => {
    const owner = await login(); const member = await login(); const expiring = await login(); const pageId = await create(owner);
    await share(owner, member, pageId); await share(owner, expiring, pageId);
    const before = await durableState(pageId);
    const first = await connect(owner, pageId); const second = await connect(member, pageId); const third = await connect(expiring, pageId);
    await synchronized(first); await synchronized(second); await synchronized(third);
    announce(first, 1005, 1); announce(second, 2005, 1); announce(third, 2006, 1);
    await vi.waitFor(() => expect([...first.states.keys()].sort()).toEqual([1005, 2005, 2006]));
    expect((await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { origin, cookie: member.cookie }, payload: {} })).statusCode).toBe(200);
    await vi.waitFor(() => expect(second.socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(first.states.has(2005)).toBe(false));
    await pool.query("UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE id=$1", [expiring.sessionId]);
    announce(third, 2006, 2);
    await vi.waitFor(() => expect(third.socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(first.states.has(2006)).toBe(false));
    expect(first.frames.some(frame => frame.clientId === 2006 && frame.clock === 2 && frame.state !== null)).toBe(false);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    expect(await durableState(pageId)).toEqual(before);
  });
});
