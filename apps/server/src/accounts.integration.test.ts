import { randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { createServer } from './app.js';
import { migrateDatabase } from './migrations.js';
import { commitUpdate, loadPage } from './persistence.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('magic-link accounts and private notes on PostgreSQL', () => {
  const origin = 'http://127.0.0.1:5197';
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const mail = new Map<string, string>();
  const createdUsers: string[] = [];
  const createdPages: string[] = [];
  let app: Awaited<ReturnType<typeof createServer>>;
  let address: string;
  const sockets: WebSocket[] = [];
  let clientNumber = 1;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('KIKIT_DEV_FIXTURE', '0');
    vi.stubEnv('BETTER_AUTH_SECRET', 'account-integration-test-secret-not-used-in-production');
    await migrateDatabase(pool);
    app = await createServer({ databaseUrl, origin, sendMagicLink: async ({ email, url }) => { mail.set(email, url); } });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    for (const id of createdPages) {
      await pool.query('DELETE FROM receipts WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM document_updates WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM page_grants WHERE page_id=$1', [id]);
      await pool.query('DELETE FROM pages WHERE id=$1', [id]);
    }
    for (const id of createdUsers) await pool.query('DELETE FROM auth_user WHERE id=$1', [id]);
    await pool.end(); vi.unstubAllEnvs();
  });

  async function login() {
    const remoteAddress = `127.0.0.${++clientNumber}`;
    const email = `${randomUUID()}@example.test`;
    const result = await app.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', remoteAddress, headers: { origin }, payload: { email, callbackURL: '/' } });
    expect(result.statusCode).toBe(200);
    const url = mail.get(email)!;
    expect(url).toBeTruthy();
    const token = new URL(url).searchParams.get('token')!;
    const stored = await pool.query('SELECT identifier, value FROM auth_verification WHERE identifier LIKE $1', ['magic-link:%']);
    expect(stored.rows.every(row => !row.identifier.includes(token) && !row.value.includes(token))).toBe(true);
    const redeemed = await app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search, remoteAddress, headers: { origin } });
    expect(redeemed.statusCode).toBe(302);
    const setCookie = redeemed.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    // A failed attribute check must not print the session cookie value in CI.
    expect(String(setCookie).includes('HttpOnly')).toBe(true);
    expect(String(setCookie).includes('SameSite=Lax')).toBe(true);
    const active = await app.inject({ url: '/api/session', headers: { cookie } });
    expect(active.statusCode).toBe(200);
    const accountId = active.json().accountId as string;
    createdUsers.push(accountId);
    const [{ id: sessionId }] = (await pool.query('SELECT id FROM auth_session WHERE user_id=$1', [accountId])).rows;
    return { cookie, accountId, sessionId, url };
  }
  async function create(cookie: string) {
    const id = randomUUID(); createdPages.push(id);
    const response = await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie }, payload: { id } });
    expect(response.statusCode).toBe(200);
    return id;
  }
  async function connect(cookie: string, pageId: string) {
    const account = (await app.inject({ url: '/api/session', headers: { cookie } })).json();
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}/api/sync`, { origin, headers: { cookie } });
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', pageId, accountId: account?.accountId ?? 'expired-account', protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION }));
    return { socket, messages };
  }

  it('consumes magic links once and denies unauthenticated and foreign-origin access', async () => {
    expect((await app.inject({ url: '/api/session' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/dev/session' })).statusCode).toBe(404);
    const account = await login();
    expect((await app.inject({ url: new URL(account.url).pathname + new URL(account.url).search })).headers.location).toContain('INVALID_TOKEN');
    expect((await app.inject({ method: 'POST', url: '/api/pages', headers: { origin: 'https://foreign.example', cookie: account.cookie }, payload: { id: randomUUID() } })).statusCode).toBe(403);
    const foreignSocket = new WebSocket(`${address.replace('http:', 'ws:')}/api/sync`, { origin: 'https://foreign.example', headers: { cookie: account.cookie } });
    const status = await new Promise<number>(resolve => {
      foreignSocket.on('unexpected-response', (_request, response) => { response.resume(); foreignSocket.terminate(); resolve(response.statusCode!); });
      foreignSocket.on('error', () => undefined);
    });
    expect(status).toBe(403);
  });

  it('isolates two real accounts across listing, page creation retries, HTTP, WebSocket, and storage writes', async () => {
    const a = await login(); const b = await login(); const id = await create(a.cookie);
    const original = (await pool.query('SELECT initial_state FROM pages WHERE id=$1', [id])).rows[0].initial_state;
    expect((await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie: a.cookie }, payload: { id } })).statusCode).toBe(200);
    expect((await pool.query('SELECT initial_state FROM pages WHERE id=$1', [id])).rows[0].initial_state).toEqual(original);
    expect((await app.inject({ url: '/api/pages', headers: { cookie: b.cookie } })).json()).toEqual([]);
    expect((await app.inject({ url: `/api/pages/${id}/session`, headers: { cookie: b.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie: b.cookie }, payload: { id } })).statusCode).toBe(403);
    const denied = await connect(b.cookie, id);
    await vi.waitFor(() => expect(denied.messages.some(message => message.type === 'error' && message.code === 'ACCESS_DENIED')).toBe(true));
    await expect(loadPage(pool, id, b.accountId, b.sessionId)).rejects.toThrow('Page access denied');
    await expect(commitUpdate(pool, id, b.accountId, randomUUID(), new Uint8Array([0, 0]), { sessionId: b.sessionId })).rejects.toThrow('Page access denied');
  });

  it('synchronizes authenticated devices with receipts and closes an active socket on logout', async () => {
    const account = await login(); const id = await create(account.cookie);
    const first = await connect(account.cookie, id); const second = await connect(account.cookie, id);
    await vi.waitFor(() => expect(first.messages[0]?.type).toBe('sync'));
    await vi.waitFor(() => expect(second.messages[0]?.type).toBe('sync'));
    const sync = first.messages[0]; if (sync.type !== 'sync') throw new Error('Expected sync');
    const doc = new Y.Doc(); Y.applyUpdate(doc, decodeUpdate(sync.update));
    const before = Y.encodeStateVector(doc);
    (doc.getXmlFragment('title').get(0) as Y.XmlElement).insert(0, [new Y.XmlText('Private title')]);
    const update = encodeUpdate(Y.encodeStateAsUpdate(doc, before)); doc.destroy();
    const batchId = randomUUID();
    first.socket.send(JSON.stringify({ type: 'update', batchId, update }));
    await vi.waitFor(() => expect(first.messages.some(message => message.type === 'ack' && message.batchId === batchId)).toBe(true));
    await vi.waitFor(() => expect(second.messages.some(message => message.type === 'committed')).toBe(true));
    expect((await app.inject({ url: '/api/pages', headers: { cookie: account.cookie } })).json()[0].title).toBe('Private title');
    first.socket.send(JSON.stringify({ type: 'update', batchId, update }));
    await vi.waitFor(() => expect(first.messages.filter(message => message.type === 'ack').length).toBe(2));
    expect((await pool.query('SELECT sequence FROM pages WHERE id=$1', [id])).rows[0].sequence).toBe('1');
    const out = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { origin, cookie: account.cookie }, payload: {} });
    expect(out.statusCode).toBe(200);
    await vi.waitFor(() => expect(first.socket.readyState).toBe(WebSocket.CLOSED));
    expect((await app.inject({ url: '/api/session', headers: { cookie: account.cookie } })).statusCode).toBe(401);
    await expect(commitUpdate(pool, id, account.accountId, randomUUID(), new Uint8Array([0, 0]), { sessionId: account.sessionId })).rejects.toThrow('Session expired or revoked');
  });

  it('checks expiry on existing connections and renews a session through HTTP cookies', async () => {
    const account = await login(); const id = await create(account.cookie);
    await pool.query("UPDATE auth_session SET expires_at=now()+interval '2 days', updated_at=now()-interval '2 days' WHERE id=$1", [account.sessionId]);
    const renewed = await app.inject({ url: '/api/auth/get-session', headers: { cookie: account.cookie } });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.headers['set-cookie']).toBeTruthy();
    expect(new Date(renewed.json().session.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    const active = await connect(account.cookie, id);
    await vi.waitFor(() => expect(active.messages[0]?.type).toBe('sync'));
    await pool.query("UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE id=$1", [account.sessionId]);
    active.socket.send(JSON.stringify({ type: 'update', batchId: randomUUID(), update: encodeUpdate(new Uint8Array([0, 0])) }));
    await vi.waitFor(() => expect(active.socket.readyState).toBe(WebSocket.CLOSED));
    expect((await pool.query('SELECT sequence FROM pages WHERE id=$1', [id])).rows[0].sequence).toBe('0');
  });

  it('refuses a second account server for the same database', async () => {
    await expect(createServer({ databaseUrl, origin, sendMagicLink: async () => undefined })).rejects.toThrow('Another Kikit account server is active');
  });

  it('orders logout behind an admitted handshake with a database read in flight', async () => {
    const account = await login(); const id = await create(account.cookie);
    const blocker = await pool.connect();
    let logout: Promise<{ statusCode: number }> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [id]);
      const joining = await connect(account.cookie, id);
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pages%'");
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      logout = app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { origin, cookie: account.cookie }, payload: {} });
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%auth_session%'");
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      await blocker.query('COMMIT');
      expect((await logout)!.statusCode).toBe(200);
      await vi.waitFor(() => expect(joining.socket.readyState).toBe(WebSocket.CLOSED));
      expect((await app.inject({ url: '/api/session', headers: { cookie: account.cookie } })).statusCode).toBe(401);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await logout;
    }
  });

  it('recovers a deleted note as a private binary copy, binds retries, and rejects account/version/origin changes', async () => {
    const owner = await login(), outsider = await login();
    const source = await create(owner.cookie);
    const original = await loadPage(pool, source, owner.accountId, owner.sessionId);
    const initialCommitted = Y.encodeStateAsUpdate(original.doc);
    const title = (original.doc.getXmlFragment('title').get(0) as Y.XmlElement);
    const titleText = title.get(0) as Y.XmlText;
    const before = Y.encodeStateVector(original.doc);
    titleText.insert(0, 'Recovered binary note');
    const pending = { batchId: randomUUID(), update: encodeUpdate(Y.encodeStateAsUpdate(original.doc, before)) };
    const recovery = JSON.stringify({ format: 'kikit-recovery', formatVersion: 2, protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION, accountId: owner.accountId, pageId: source,
      exportedAt: new Date().toISOString(), update: encodeUpdate(Y.encodeStateAsUpdate(original.doc)), pending: [pending], cachedUpdates: [] });
    original.doc.destroy();
    const readRecovery = { url: `/api/pages/${source}/recovery-state`,
      headers: { cookie: owner.cookie, 'x-kikit-account': owner.accountId } };
    const committed = await app.inject(readRecovery);
    expect(committed.statusCode).toBe(200);
    expect(committed.headers['cache-control']).toBe('no-store');
    expect(committed.headers['x-kikit-account']).toBe(owner.accountId);
    expect(committed.json()).toMatchObject({ accountId: owner.accountId, pageId: source,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    // The read returns storage's locked boundary, excluding the unsent recovery edit.
    expect(decodeUpdate(committed.json().update)).toEqual(initialCommitted);
    const deniedReads = [
      { ...readRecovery, headers: {} },
      { ...readRecovery, headers: { cookie: owner.cookie } },
      { ...readRecovery, headers: { ...readRecovery.headers, 'x-kikit-account': outsider.accountId } },
      { ...readRecovery, headers: { cookie: outsider.cookie, 'x-kikit-account': outsider.accountId } },
    ];
    for (const [index, deniedRead] of deniedReads.entries()) {
      const denied = await app.inject(deniedRead);
      expect(denied.statusCode).toBe(index === 3 ? 403 : 401);
      expect(denied.headers['cache-control']).toBe('no-store');
      expect(denied.json()).not.toHaveProperty('update');
      expect(denied.headers['x-kikit-account']).toBeUndefined();
    }
    const deleted = await app.inject({ method: 'DELETE', url: `/api/pages/${source}`,
      headers: { origin, cookie: owner.cookie, 'x-kikit-account': owner.accountId } });
    expect(deleted.statusCode).toBe(200);
    const deletedRead = await app.inject(readRecovery);
    expect(deletedRead.statusCode).toBe(403);
    expect(deletedRead.headers['cache-control']).toBe('no-store');
    expect(deletedRead.json()).not.toHaveProperty('update');
    const id = randomUUID(); createdPages.push(id);
    const request = { method: 'POST' as const, url: '/api/recovery/copies',
      headers: { origin, cookie: owner.cookie, 'x-kikit-account': owner.accountId }, payload: { id, recovery } };
    expect((await app.inject({ ...request, headers: { ...request.headers, 'x-kikit-account': outsider.accountId } })).statusCode).toBe(401);
    expect((await app.inject({ ...request, headers: { ...request.headers, cookie: outsider.cookie, 'x-kikit-account': outsider.accountId } })).statusCode).toBe(400);
    expect((await app.inject({ ...request, headers: { ...request.headers, origin: 'https://foreign.example' } })).statusCode).toBe(403);
    const recovered = await app.inject(request);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ id, title: 'Recovered binary note', role: 'owner' });
    const saved = (await pool.query('SELECT initial_state, creation_input_hash FROM pages WHERE id=$1', [id])).rows[0];
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await pool.query('SELECT initial_state FROM pages WHERE id=$1', [id])).rows[0].initial_state).toEqual(saved.initial_state);
    expect(saved.creation_input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await pool.query('SELECT account_id, role FROM page_grants WHERE page_id=$1', [id])).rows).toEqual([{ account_id: owner.accountId, role: 'owner' }]);
    expect((await pool.query('SELECT 1 FROM receipts WHERE page_id=$1', [id])).rowCount).toBe(0);
    expect((await app.inject({ url: `/api/pages/${id}/session`, headers: { cookie: outsider.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/pages', headers: request.headers, payload: { id } })).statusCode).toBe(403);
    const changed = JSON.parse(recovery); changed.update = encodeUpdate(new Uint8Array([0, 0]));
    expect((await app.inject({ ...request, payload: { id, recovery: JSON.stringify(changed) } })).statusCode).toBe(400);
    const copied = await loadPage(pool, id, owner.accountId, owner.sessionId);
    expect(copied.doc.getXmlFragment('title').toString()).toContain('Recovered binary note');
    const nextVector = Y.encodeStateVector(copied.doc);
    (copied.doc.getXmlFragment('title').get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' continued')]);
    const write = Y.encodeStateAsUpdate(copied.doc, nextVector); copied.doc.destroy();
    expect((await commitUpdate(pool, id, owner.accountId, randomUUID(), write, { sessionId: owner.sessionId })).sequence).toBe(1);
    const fresh = await app.inject({ ...readRecovery, url: `/api/pages/${id}/recovery-state` });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers['cache-control']).toBe('no-store');
    expect(fresh.headers['x-kikit-account']).toBe(owner.accountId);
    expect(fresh.json()).toMatchObject({ accountId: owner.accountId, pageId: id,
      protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
    const current = await loadPage(pool, id, owner.accountId, owner.sessionId);
    try { expect(decodeUpdate(fresh.json().update)).toEqual(Y.encodeStateAsUpdate(current.doc)); }
    finally { current.doc.destroy(); }
    const erased = await app.inject({ method: 'DELETE', url: `/api/pages/${id}`, headers: request.headers });
    expect(erased.statusCode).toBe(200);
    expect((await pool.query('SELECT creation_input_hash FROM pages WHERE id=$1', [id])).rows[0].creation_input_hash).toBeNull();
    expect((await app.inject(request)).statusCode).toBe(403);
    const erasedRead = await app.inject({ ...readRecovery, url: `/api/pages/${id}/recovery-state` });
    expect(erasedRead.statusCode).toBe(403);
    expect(erasedRead.json()).not.toHaveProperty('update');
  });

  it('stops active connections after losing the database ownership connection', async () => {
    const account = await login(); const id = await create(account.cookie);
    const active = await connect(account.cookie, id);
    await vi.waitFor(() => expect(active.messages[0]?.type).toBe('sync'));
    const owner = await pool.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=719422 AND granted`);
    expect(owner.rows).toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [owner.rows[0].pid]);
    await vi.waitFor(() => expect(active.socket.readyState).toBe(WebSocket.CLOSED));
    await app.close();
    await expect(fetch(`${address}/api/health`)).rejects.toThrow();
  });

});
