import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { createServer } from './app.js';
import { migrateDatabase } from './migrations.js';
import { commitUpdate, loadPage } from './persistence.js';
import { disableInvitation, findInvitationPage, joinInvitation, removeMember } from './sharing.js';
import { SyncRooms } from './sync-room.js';
import { TestFaults } from './test-faults.js';
import { deletePage } from './page-deletion.js';

const databaseUrl = process.env.KIKIT_TEST_DATABASE_URL;
interface Account { cookie: string; accountId: string; sessionId: string; email: string }
interface Connection { socket: WebSocket; messages: ServerMessage[] }

describe.skipIf(!databaseUrl)('shared pages with distinct authenticated accounts on PostgreSQL', () => {
  const origin = 'http://127.0.0.1:5199';
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const mail = new Map<string, string>();
  const accounts: Account[] = [];
  const pages: string[] = [];
  const sockets: WebSocket[] = [];
  let peer = 100;
  let app: Awaited<ReturnType<typeof createServer>>;
  let address: string;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '0');
    vi.stubEnv('KIKIT_TEST_FAULTS', '1');
    vi.stubEnv('BETTER_AUTH_SECRET', 'sharing-integration-test-secret-never-used-in-production');
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
    for (const account of accounts) await pool.query('DELETE FROM auth_user WHERE id=$1', [account.accountId]);
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function login(): Promise<Account> {
    const email = `${randomUUID()}@example.test`;
    const remoteAddress = `127.0.2.${++peer}`;
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
    const sessionId = (await pool.query('SELECT id FROM auth_session WHERE user_id=$1', [accountId])).rows[0].id as string;
    const account = { cookie, accountId, sessionId, email };
    accounts.push(account);
    return account;
  }

  async function create(owner: Account): Promise<string> {
    const id = randomUUID(); pages.push(id);
    const response = await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie: owner.cookie }, payload: { id } });
    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe('owner');
    return id;
  }

  async function invitation(owner: Account, pageId: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/invitation`, headers: { origin, cookie: owner.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-kikit-account']).toBe(owner.accountId);
    const token = response.json().token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return token;
  }

  async function join(account: Account, token: string, status = 200) {
    const response = await app.inject({ method: 'POST', url: '/api/invitations/join', headers: { origin, cookie: account.cookie }, payload: { token } });
    expect(response.statusCode).toBe(status);
    if (status === 200) expect(response.headers['x-kikit-account']).toBe(account.accountId);
    return response;
  }

  async function remove(owner: Account, pageId: string, member: Account) {
    const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/members/${member.accountId}`, headers: { origin, cookie: owner.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-kikit-account']).toBe(owner.accountId);
    return response;
  }

  async function connect(account: Account, pageId: string): Promise<Connection> {
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}/api/sync`, { origin, headers: { cookie: account.cookie } });
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', pageId, accountId: account.accountId, protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION }));
    return { socket, messages };
  }

  async function next<T extends ServerMessage['type']>(connection: Connection, type: T, batchId?: string): Promise<Extract<ServerMessage, { type: T }>> {
    const matches = (message: ServerMessage) => message.type === type && (!batchId || ('batchId' in message && message.batchId === batchId));
    await vi.waitFor(() => expect(connection.messages.some(matches)).toBe(true));
    return connection.messages.splice(connection.messages.findIndex(matches), 1)[0] as Extract<ServerMessage, { type: T }>;
  }

  function edit(sync: Extract<ServerMessage, { type: 'sync' }>, value: string): Uint8Array {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, decodeUpdate(sync.update));
      const vector = Y.encodeStateVector(doc);
      const paragraph = doc.getXmlFragment('body').get(0) as Y.XmlElement;
      paragraph.insert(0, [new Y.XmlText(value)]);
      return Y.encodeStateAsUpdate(doc, vector);
    } finally { doc.destroy(); }
  }

  async function storedEdit(account: Account, pageId: string, value: string): Promise<Uint8Array> {
    const loaded = await loadPage(pool, pageId, account.accountId, account.sessionId);
    try {
      return edit({ type: 'sync', protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION,
        sequence: loaded.sequence, update: encodeUpdate(Y.encodeStateAsUpdate(loaded.doc)) }, value);
    } finally { loaded.doc.destroy(); }
  }

  async function waitForPageLocks(count: number): Promise<void> {
    await vi.waitFor(async () => {
      const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pages%' AND query NOT LIKE '%pg_stat_activity%'");
      expect(waiting.rows[0].count).toBeGreaterThanOrEqual(count);
    });
  }

  it('keeps invitation secrets hashed and grants access only through an authenticated, idempotent join', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    const token = await invitation(owner, pageId);
    const stored = await pool.query('SELECT row_to_json(i) AS invitation FROM page_invitations i WHERE page_id=$1', [pageId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].invitation.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect((await app.inject({ url: `/api/pages/${pageId}/session`, headers: { cookie: member.cookie } })).statusCode).toBe(403);
    expect((await pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rowCount).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/invitations/join', headers: { origin }, payload: { token } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/invitations/join', headers: { origin: 'https://foreign.example', cookie: member.cookie }, payload: { token } })).statusCode).toBe(403);
    const switched = await app.inject({ method: 'POST', url: '/api/invitations/join',
      headers: { origin, cookie: member.cookie, 'x-kikit-account': owner.accountId }, payload: { token } });
    expect(switched.statusCode).toBe(401);
    expect((await pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rowCount).toBe(0);
    const joined = await Promise.all([join(member, token), join(member, token)]);
    expect(joined.map(response => response.json().id)).toEqual([pageId, pageId]);
    expect(joined.every(response => response.json().role === 'editor')).toBe(true);
    expect((await pool.query('SELECT role FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rows).toEqual([{ role: 'editor' }]);
    expect((await app.inject({ url: '/api/pages', headers: { cookie: member.cookie } })).json()).toEqual([expect.objectContaining({ id: pageId, role: 'editor' })]);
    expect((await join(owner, token)).json().role).toBe('owner');
    const sharing = await app.inject({ url: `/api/pages/${pageId}/sharing`, headers: { cookie: owner.cookie } });
    expect(sharing.statusCode).toBe(200);
    expect(sharing.headers['x-kikit-account']).toBe(owner.accountId);
    expect(sharing.json()).toEqual({ invitationActive: true, members: expect.arrayContaining([
      expect.objectContaining({ accountId: owner.accountId, role: 'owner' }),
      expect.objectContaining({ accountId: member.accountId, email: member.email, role: 'editor' }),
    ]) });
    expect(sharing.body).not.toContain(token);
  });

  it('permanently deletes only for the owner, revokes active access and never resurrects a retried create', async () => {
    const owner = await login(); const member = await login(); const outsider = await login();
    const pageId = await create(owner); const token = await invitation(owner, pageId);
    await join(member, token);
    const ownerConnection = await connect(owner, pageId); await next(ownerConnection, 'sync');
    const memberConnection = await connect(member, pageId); const sync = await next(memberConnection, 'sync');
    const bytes = edit(sync, 'Delete this committed content.'); const batchId = randomUUID();
    memberConnection.socket.send(JSON.stringify({ type: 'update', batchId, update: encodeUpdate(bytes) }));
    await next(memberConnection, 'ack', batchId);
    const url = `/api/pages/${pageId}`;
    const headers = { origin, cookie: owner.cookie, 'x-kikit-account': owner.accountId };
    expect((await app.inject({ method: 'DELETE', url, headers: { origin } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url, headers: { ...headers, origin: 'https://foreign.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: { ...headers, 'x-kikit-account': member.accountId } })).statusCode).toBe(401);
    for (const account of [member, outsider]) {
      expect((await app.inject({ method: 'DELETE', url, headers: { origin, cookie: account.cookie, 'x-kikit-account': account.accountId } })).statusCode).toBe(403);
    }
    const deleted = await app.inject({ method: 'DELETE', url, headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.headers['x-kikit-account']).toBe(owner.accountId);
    expect((await next(ownerConnection, 'error')).code).toBe('ACCESS_DENIED');
    expect((await next(memberConnection, 'error')).code).toBe('ACCESS_DENIED');
    const tombstone = (await pool.query('SELECT title, initial_state, deleted_at FROM pages WHERE id=$1', [pageId])).rows[0];
    expect(tombstone.title).toBe(''); expect(tombstone.initial_state).toHaveLength(0);
    expect(tombstone.deleted_at).toBeInstanceOf(Date);
    for (const table of ['document_updates', 'receipts', 'page_invitations', 'page_grants']) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE page_id=$1`, [pageId])).rows[0].count).toBe(0);
    }
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(200);
    expect((await pool.query('SELECT deleted_at FROM pages WHERE id=$1', [pageId])).rows[0].deleted_at).toEqual(tombstone.deleted_at);
    for (const account of [owner, member]) {
      expect((await app.inject({ url: `/api/pages/${pageId}/session`, headers: { cookie: account.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/pages', headers: { cookie: account.cookie } })).json()).not.toContainEqual(expect.objectContaining({ id: pageId }));
      await expect(commitUpdate(pool, pageId, account.accountId, batchId, bytes, { sessionId: account.sessionId })).rejects.toThrow('Page access denied');
      expect((await app.inject({ method: 'POST', url: '/api/pages', headers: { origin, cookie: account.cookie }, payload: { id: pageId } })).statusCode).toBe(403);
    }
    expect(await findInvitationPage(pool, token)).toBeNull(); await join(member, token, 410);
  });

  it('rolls back failed deletion and orders deletion behind an authorized in-flight commit', async () => {
    const owner = await login(); const pageId = await create(owner);
    const bytes = await storedEdit(owner, pageId, 'Retained if deletion fails.');
    await commitUpdate(pool, pageId, owner.accountId, randomUUID(), bytes, { sessionId: owner.sessionId });
    const functionName = `deny_delete_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected deletion failure'; END $$`);
    await pool.query(`CREATE TRIGGER ${functionName} BEFORE DELETE ON document_updates FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await expect(deletePage(pool, pageId, owner)).rejects.toThrow();
      expect((await pool.query('SELECT deleted_at FROM pages WHERE id=$1', [pageId])).rows[0].deleted_at).toBeNull();
      expect((await pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId])).rows[0].count).toBe(1);
      const loaded = await loadPage(pool, pageId, owner.accountId, owner.sessionId);
      expect(loaded.doc.getXmlFragment('body').toString()).toContain('Retained if deletion fails.'); loaded.doc.destroy();
    } finally {
      await pool.query(`DROP TRIGGER ${functionName} ON document_updates`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }
    const laterBytes = await storedEdit(owner, pageId, 'Commit before deletion.');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const committing = commitUpdate(pool, pageId, owner.accountId, randomUUID(), laterBytes, {
      sessionId: owner.sessionId, beforeCommit: async () => { entered(); await gate; },
    });
    await started;
    const deleting = deletePage(pool, pageId, owner);
    try { await waitForPageLocks(1); } finally { release(); }
    expect((await committing).duplicate).toBe(false); await deleting;
    await expect(loadPage(pool, pageId, owner.accountId, owner.sessionId)).rejects.toThrow('Page access denied');
    expect((await pool.query('SELECT count(*)::int AS count FROM document_updates WHERE page_id=$1', [pageId])).rows[0].count).toBe(0);
  });

  it('allows editor writes while denying private pages and owner-only sharing controls', async () => {
    const owner = await login(); const member = await login(); const outsider = await login();
    const sharedId = await create(owner); const privateId = await create(owner);
    await join(member, await invitation(owner, sharedId));
    const ownerConnection = await connect(owner, sharedId); await next(ownerConnection, 'sync');
    const editorConnection = await connect(member, sharedId); const editorSync = await next(editorConnection, 'sync');
    for (const account of [member, outsider]) {
      expect((await app.inject({ url: `/api/pages/${privateId}/session`, headers: { cookie: account.cookie } })).statusCode).toBe(403);
      await expect(loadPage(pool, privateId, account.accountId, account.sessionId)).rejects.toThrow('Page access denied');
      const denied = await connect(account, privateId);
      expect((await next(denied, 'error')).code).toBe('ACCESS_DENIED');
    }
    for (const account of [member, outsider]) {
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const route = method === 'GET' ? 'sharing' : 'invitation';
        expect((await app.inject({ method, url: `/api/pages/${sharedId}/${route}`, headers: { origin, cookie: account.cookie } })).statusCode).toBe(403);
      }
      expect((await app.inject({ method: 'DELETE', url: `/api/pages/${sharedId}/members/${owner.accountId}`, headers: { origin, cookie: account.cookie } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'DELETE', url: `/api/pages/${sharedId}/members/${owner.accountId}`, headers: { origin, cookie: owner.cookie } })).statusCode).toBe(403);
    expect(ownerConnection.socket.readyState).toBe(WebSocket.OPEN);
    expect(editorConnection.socket.readyState).toBe(WebSocket.OPEN);
    const batchId = randomUUID(); const bytes = edit(editorSync, 'Authorized editor.');
    editorConnection.socket.send(JSON.stringify({ type: 'update', batchId, update: encodeUpdate(bytes) }));
    expect((await next(editorConnection, 'ack', batchId)).sequence).toBe(1);
    await next(ownerConnection, 'committed');
    expect((await pool.query('SELECT count(*)::int AS count FROM page_grants WHERE page_id=$1 AND role=$2', [sharedId, 'owner'])).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [privateId])).rows[0].count).toBe(0);
  });

  it('replaces and disables invitations without removing members, and requires a valid invitation for reentry', async () => {
    const owner = await login(); const member = await login(); const newcomer = await login();
    const pageId = await create(owner); const old = await invitation(owner, pageId);
    await join(member, old);
    const replacement = await invitation(owner, pageId);
    expect(replacement).not.toBe(old);
    await join(newcomer, old, 410);
    expect((await app.inject({ url: `/api/pages/${pageId}/session`, headers: { cookie: member.cookie } })).statusCode).toBe(200);
    await remove(owner, pageId, member);
    await join(member, replacement);
    const disabled = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/invitation`, headers: { origin, cookie: owner.cookie } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.headers['x-kikit-account']).toBe(owner.accountId);
    await join(newcomer, replacement, 410);
    expect((await app.inject({ url: `/api/pages/${pageId}/session`, headers: { cookie: member.cookie } })).statusCode).toBe(200);
    await remove(owner, pageId, member);
    await remove(owner, pageId, member); // Retried owner mutation is harmless.
    await join(member, replacement, 410);
    await join(member, 'a'.repeat(43), 410);
    expect((await app.inject({ url: `/api/pages/${pageId}/sharing`, headers: { cookie: owner.cookie } })).json().invitationActive).toBe(false);
  });

  it('revokes active sockets and even duplicate receipt access, then recovers the same receipt after explicit valid rejoin', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    const token = await invitation(owner, pageId); await join(member, token);
    const ownerConnection = await connect(owner, pageId); await next(ownerConnection, 'sync');
    const editor = await connect(member, pageId); const sync = await next(editor, 'sync');
    const batchId = randomUUID(); const bytes = edit(sync, 'Member committed before removal.');
    editor.socket.send(JSON.stringify({ type: 'update', batchId, update: encodeUpdate(bytes) }));
    expect((await next(editor, 'ack', batchId)).sequence).toBe(1);
    await next(ownerConnection, 'committed');
    await remove(owner, pageId, member);
    await vi.waitFor(() => expect(editor.socket.readyState).toBe(WebSocket.CLOSED));
    expect((await app.inject({ url: `/api/pages/${pageId}/session`, headers: { cookie: member.cookie } })).statusCode).toBe(403);
    await expect(commitUpdate(pool, pageId, member.accountId, batchId, bytes, { sessionId: member.sessionId })).rejects.toThrow('Page access denied');
    const refused = await connect(member, pageId);
    expect((await next(refused, 'error')).code).toBe('ACCESS_DENIED');
    const count = editor.messages.filter(message => message.type === 'committed').length;
    const ownerBytes = edit(sync, 'Owner remains authorized.'); const ownerBatch = randomUUID();
    ownerConnection.socket.send(JSON.stringify({ type: 'update', batchId: ownerBatch, update: encodeUpdate(ownerBytes) }));
    await next(ownerConnection, 'ack', ownerBatch);
    expect(editor.messages.filter(message => message.type === 'committed')).toHaveLength(count);
    await join(member, token);
    expect(await commitUpdate(pool, pageId, member.accountId, batchId, bytes, { sessionId: member.sessionId })).toEqual({ duplicate: true, sequence: 1 });
    expect((await pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1 AND batch_id=$2', [pageId, batchId])).rows[0].count).toBe(1);
  });

  it('orders member removal behind an authorized transaction and denies subsequent writes', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await join(member, await invitation(owner, pageId));
    const bytes = await storedEdit(member, pageId, 'Write admitted before removal.');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const committing = commitUpdate(pool, pageId, member.accountId, randomUUID(), bytes, {
      sessionId: member.sessionId, beforeCommit: async () => { entered(); await blocked; },
    });
    let removal: Promise<unknown> | undefined;
    let removed = false;
    try {
      await admitted;
      removal = remove(owner, pageId, member).then(value => { removed = true; return value; });
      await waitForPageLocks(1);
      expect(removed).toBe(false);
      release();
      expect((await committing).sequence).toBe(1);
      await removal;
      await expect(commitUpdate(pool, pageId, member.accountId, randomUUID(), bytes, { sessionId: member.sessionId })).rejects.toThrow('Page access denied');
      const loaded = await loadPage(pool, pageId, owner.accountId, owner.sessionId);
      try { expect(loaded.doc.getXmlFragment('body').toString()).toContain('Write admitted before removal.'); }
      finally { loaded.doc.destroy(); }
      expect((await pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId])).rows[0].count).toBe(1);
    } finally { release(); await committing; await removal; }
  });

  it('revalidates an admitted handshake before the removal response returns', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await join(member, await invitation(owner, pageId));
    const blocker = await pool.connect();
    let removal: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [pageId]);
      const pending = await connect(member, pageId);
      await waitForPageLocks(1);
      removal = remove(owner, pageId, member);
      await blocker.query('COMMIT');
      await removal;
      await vi.waitFor(() => expect(pending.socket.readyState).toBe(WebSocket.CLOSED));
      expect((await pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rowCount).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await removal; }
  });

  it('serializes redemption with invalidation and rejects a stale pre-revocation lookup', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    const token = await invitation(owner, pageId);
    expect(await findInvitationPage(pool, token)).toBe(pageId);
    const blocker = await pool.connect();
    let redemption: ReturnType<typeof joinInvitation> | undefined;
    let invalidation: ReturnType<typeof disableInvitation> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [pageId]);
      redemption = joinInvitation(pool, pageId, token, member);
      await waitForPageLocks(1);
      invalidation = disableInvitation(pool, pageId, owner);
      await waitForPageLocks(2);
      await blocker.query('COMMIT');
      expect((await redemption).role).toBe('editor');
      await invalidation;
      expect((await pool.query('SELECT role FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rows).toEqual([{ role: 'editor' }]);
      const late = await login();
      await expect(joinInvitation(pool, pageId, token, late)).rejects.toThrow();
      expect((await pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, late.accountId])).rowCount).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await redemption; await invalidation; }
  });

  it('recovers lost acknowledgements and uncertain commits across two authenticated accounts without duplicate receipts', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await join(member, await invitation(owner, pageId));
    const peer = await connect(owner, pageId); await next(peer, 'sync');
    const author = await connect(member, pageId); const sync = await next(author, 'sync');
    const lostId = randomUUID(); const lostBytes = edit(sync, 'Lost acknowledgement.');
    expect((await app.inject({ method: 'POST', url: '/api/test/faults', payload: { dropNextAck: true }, headers: { origin } })).statusCode).toBe(200);
    author.socket.send(JSON.stringify({ type: 'update', batchId: lostId, update: encodeUpdate(lostBytes) }));
    await next(peer, 'committed');
    await vi.waitFor(() => expect(author.socket.readyState).toBe(WebSocket.CLOSED));
    expect(author.messages.some(message => message.type === 'ack')).toBe(false);
    const reconnected = await connect(member, pageId); const recovered = await next(reconnected, 'sync');
    reconnected.socket.send(JSON.stringify({ type: 'update', batchId: lostId, update: encodeUpdate(lostBytes) }));
    expect((await next(reconnected, 'ack', lostId)).sequence).toBe(1);
    const unknownId = randomUUID(); const unknownBytes = edit(recovered, 'Unknown commit outcome.');
    expect((await app.inject({ method: 'POST', url: '/api/test/faults', payload: { postCommitError: true }, headers: { origin } })).statusCode).toBe(200);
    reconnected.socket.send(JSON.stringify({ type: 'update', batchId: unknownId, update: encodeUpdate(unknownBytes) }));
    await vi.waitFor(() => expect(reconnected.socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(peer.socket.readyState).toBe(WebSocket.CLOSED));
    expect(reconnected.messages.some(message => message.type === 'ack' && message.batchId === unknownId)).toBe(false);
    const fresh = await connect(member, pageId); const freshState = await next(fresh, 'sync');
    expect(freshState.sequence).toBe(2);
    fresh.socket.send(JSON.stringify({ type: 'update', batchId: unknownId, update: encodeUpdate(unknownBytes) }));
    expect((await next(fresh, 'ack', unknownId)).sequence).toBe(2);
    const ownerFresh = await connect(owner, pageId); const ownerSync = await next(ownerFresh, 'sync');
    const thirdId = randomUUID();
    ownerFresh.socket.send(JSON.stringify({ type: 'update', batchId: thirdId, update: encodeUpdate(edit(ownerSync, 'Owner continues.')) }));
    expect((await next(ownerFresh, 'ack', thirdId)).sequence).toBe(3);
    await next(fresh, 'committed');
    expect((await pool.query('SELECT batch_id, sequence FROM receipts WHERE page_id=$1 ORDER BY sequence', [pageId])).rows).toEqual([
      { batch_id: lostId, sequence: '1' }, { batch_id: unknownId, sequence: '2' }, { batch_id: thirdId, sequence: '3' },
    ]);
  });

  it('does not redeem invitations or mutate membership with an expired session', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    const token = await invitation(owner, pageId);
    await pool.query("UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE id=$1", [member.sessionId]);
    await join(member, token, 401);
    await expect(joinInvitation(pool, pageId, token, member)).rejects.toThrow('Session expired or revoked');
    expect((await pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rowCount).toBe(0);
    await pool.query("UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE id=$1", [owner.sessionId]);
    expect((await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}/invitation`, headers: { origin, cookie: owner.cookie } })).statusCode).toBe(401);
    expect(await findInvitationPage(pool, token)).toBe(pageId);
  });

  it('invalidates every peer after an uncertain membership commit before accepting more room work', async () => {
    const owner = await login(); const member = await login(); const pageId = await create(owner);
    await join(member, await invitation(owner, pageId));
    const rooms = new SyncRooms(pool, new TestFaults());
    // Real socket pairs exercise delivery/closure, with principals from actual Better Auth sessions.
    const transport = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => transport.once('listening', resolve));
    const listening = transport.address();
    if (!listening || typeof listening === 'string') throw new Error('Missing test socket address');
    async function pair(account: Account) {
      const incoming = new Promise<WebSocket>(resolve => transport.once('connection', resolve));
      const socket = new WebSocket(`ws://127.0.0.1:${(listening as { port: number }).port}`);
      sockets.push(socket);
      const messages: ServerMessage[] = [];
      socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage));
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const serverSocket = await incoming;
      return { serverSocket, connection: { socket, messages }, principal: account };
    }
    try {
      const ownerPeer = await pair(owner); const memberPeer = await pair(member);
      await rooms.join(pageId, ownerPeer.serverSocket, ownerPeer.principal);
      await rooms.join(pageId, memberPeer.serverSocket, memberPeer.principal);
      await next(ownerPeer.connection, 'sync'); await next(memberPeer.connection, 'sync');
      await expect(rooms.accessMutation(pageId, async () => {
        await removeMember(pool, pageId, member.accountId, owner);
        throw new Error('Injected uncertain membership commit outcome');
      })).rejects.toThrow('Injected uncertain membership commit outcome');
      await vi.waitFor(() => expect(ownerPeer.connection.socket.readyState).toBe(WebSocket.CLOSED));
      await vi.waitFor(() => expect(memberPeer.connection.socket.readyState).toBe(WebSocket.CLOSED));
      expect(rooms.size).toBe(0);
      const denied = await pair(member);
      await expect(rooms.join(pageId, denied.serverSocket, denied.principal)).rejects.toThrow('Page access denied');
      expect(denied.connection.messages).toEqual([]);
      const restored = await pair(owner);
      await rooms.join(pageId, restored.serverSocket, restored.principal);
      expect((await next(restored.connection, 'sync')).sequence).toBe(0);
      expect((await pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, member.accountId])).rowCount).toBe(0);
    } finally {
      for (const socket of transport.clients) socket.terminate();
      await rooms.queues.drain();
      rooms.destroy();
      await new Promise<void>(resolve => transport.close(() => resolve()));
    }
  });
});
