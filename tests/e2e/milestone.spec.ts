import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { createServer } from '../../apps/server/src/app';
import { migrateDatabase } from '../../apps/server/src/persistence';

const databaseUrl = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit_e2e';
const origin = 'http://127.0.0.1:5174';
const pool = new pg.Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
const contexts: BrowserContext[] = [];

async function startServer() {
  server = await createServer({ databaseUrl, origin });
  await server.listen({ host: '127.0.0.1', port: 3002 });
}
test.beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.KIKIT_DEV_FIXTURE = '1';
  process.env.KIKIT_TEST_FAULTS = '1';
  // This fixed database exists exclusively for this suite. Development notes are untouched.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrateDatabase(pool);
  await startServer();
});
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
test.afterAll(async () => { await server?.close(); await pool.end(); });

async function openPage(browser: Browser) {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toBeVisible();
  await saved(page);
  return { context, page };
}
async function saved(page: Page) { await expect(page.getByTestId('save-status')).toHaveText('Saved to server'); }
async function append(page: Page, value: string) {
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.click();
  await body.press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
}
async function rawConnection(pageId = DEV_PAGE_ID, protocolVersion = PROTOCOL_VERSION) {
  const socket = new WebSocket('ws://127.0.0.1:3002/api/sync', { origin });
  const messages: ServerMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', pageId, protocolVersion, schemaVersion: DOCUMENT_SCHEMA_VERSION }));
  const next = async (type: ServerMessage['type']) => {
    await expect.poll(() => messages.some(message => message.type === type)).toBe(true);
    return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
  };
  return { socket, next, messages };
}
function titleUpdate(sync: ServerMessage, text: string) {
  if (sync.type !== 'sync') throw new Error('Expected sync');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decodeUpdate(sync.update));
  const vector = Y.encodeStateVector(doc);
  const title = doc.getXmlFragment('title').get(0) as Y.XmlElement;
  const node = title.get(0) as Y.XmlText;
  node.insert(node.length, text);
  const update = encodeUpdate(Y.encodeStateAsUpdate(doc, vector));
  doc.destroy();
  return update;
}

test('two independent browser contexts edit concurrently and reload committed content', async ({ browser }) => {
  const a = await openPage(browser);
  const b = await openPage(browser);
  const tokenA = ` alpha-${randomUUID().slice(0, 8)}`;
  const tokenB = ` beta-${randomUUID().slice(0, 8)}`;
  await Promise.all([append(a.page, tokenA), append(b.page, tokenB)]);
  for (const page of [a.page, b.page]) {
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(tokenA);
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(tokenB);
    await saved(page);
  }
  await a.page.getByRole('textbox', { name: 'Page title', exact: true }).fill('A place for good ideas');
  await saved(a.page);
  await expect(b.page.getByRole('textbox', { name: 'Page title', exact: true })).toHaveText('A place for good ideas');
  await b.page.reload();
  await saved(b.page);
  await expect(b.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(tokenA);
});

test('offline edits survive an offline reload, then reconnect using the durable journal', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'true');
  await context.setOffline(true);
  const text = ` offline-${randomUUID().slice(0, 8)}`;
  await append(page, text);
  // Multiple separate local transactions exercise causal replay after reload.
  await page.keyboard.insertText(' first');
  await page.keyboard.insertText(' second');
  await expect(page.getByTestId('connection-status')).toHaveText('Offline');
  await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  await expect(page.getByTestId('save-status')).not.toHaveText('Saved to server');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText('first second');
  await context.setOffline(false);
  await saved(page);
  const peer = await openPage(browser);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('concurrent offline deletions recover an editable body and drain subsequent journal batches', async ({ browser, request }) => {
  const a = await openPage(browser);
  const bodyA = a.page.getByRole('textbox', { name: 'Page body', exact: true });
  await bodyA.fill('First paragraph');
  await bodyA.press('ControlOrMeta+End');
  await bodyA.press('Enter');
  await a.page.keyboard.insertText('Second paragraph');
  await saved(a.page);
  const b = await openPage(browser);
  const bodyB = b.page.getByRole('textbox', { name: 'Page body', exact: true });
  const originalIds = await bodyA.locator('p').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  await Promise.all([a.context.setOffline(true), b.context.setOffline(true)]);
  for (const [body, index] of [[bodyA, 0], [bodyB, 1]] as const) {
    // Use the mounted Tiptap command to delete exactly one whole block. Native
    // selections can merge blocks and thus delete a different CRDT identity.
    await body.evaluate((element, index) => {
      const editor = (element as HTMLElement & { editor: {
        state: { doc: { child(index: number): { nodeSize: number } } };
        commands: { deleteRange(range: { from: number; to: number }): boolean };
      } }).editor;
      const from = index === 0 ? 0 : editor.state.doc.child(0).nodeSize;
      editor.commands.deleteRange({ from, to: from + editor.state.doc.child(index).nodeSize });
    }, index);
    await expect(body.locator('p')).toHaveCount(1);
  }
  for (const page of [a.page, b.page]) await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  // Commit A first. B's reconnect merges that committed deletion with its own
  // pending deletion before the server receives B's immutable journal record.
  await a.context.setOffline(false);
  await saved(a.page);
  await b.context.setOffline(false);
  for (const page of [a.page, b.page]) await saved(page);
  for (const body of [bodyA, bodyB]) {
    await expect(body.locator('p')).toHaveCount(1);
    await expect(body).toHaveText('');
  }
  const repairedId = await bodyA.locator('p').getAttribute('data-id');
  expect(repairedId).toBeTruthy();
  expect(originalIds).not.toContain(repairedId);
  await expect(bodyB.locator('p')).toHaveAttribute('data-id', repairedId!);
  await append(b.page, 'After concurrent deletion');
  await saved(b.page);
  await expect(bodyA).toHaveText('After concurrent deletion');
  await append(a.page, ' and another edit');
  for (const page of [a.page, b.page]) await saved(page);
  await Promise.all([a.page.reload(), b.page.reload()]);
  for (const page of [a.page, b.page]) {
    await saved(page);
    const body = page.getByRole('textbox', { name: 'Page body', exact: true });
    await expect(body).toHaveText('After concurrent deletion and another edit');
    await expect(body.locator('p')).toHaveAttribute('data-id', repairedId!);
  }
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:3002/api/test/metrics')).json()).pendingCount).toBe(0);
});

test('same batch is idempotent and reuse with different bytes is rejected', async () => {
  const wire = await rawConnection();
  try {
    const sync = await wire.next('sync');
    const batchId = randomUUID();
    const update = titleUpdate(sync, ' · receipts');
    wire.socket.send(JSON.stringify({ type: 'update', batchId, update }));
    const original = await wire.next('ack');
    wire.socket.send(JSON.stringify({ type: 'update', batchId, update }));
    expect(await wire.next('ack')).toEqual(original);
    const count = await pool.query('SELECT count(*)::int count FROM receipts WHERE page_id=$1 AND batch_id=$2', [DEV_PAGE_ID, batchId]);
    expect(count.rows[0].count).toBe(1);
    wire.socket.send(JSON.stringify({ type: 'update', batchId, update: titleUpdate(sync, ' different bytes') }));
    const rejected = await wire.next('error');
    expect(rejected.type === 'error' && rejected.retryable).toBe(false);
  } finally { wire.socket.close(); }
});

test('lost acknowledgement after commit is retried without a second database update', async ({ browser, request }) => {
  const { page } = await openPage(browser);
  const before = Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count);
  const fault = await request.post('http://127.0.0.1:3002/api/test/faults', { data: { dropNextAck: true } });
  expect(fault.ok()).toBe(true);
  const text = ` lost-ack-${randomUUID().slice(0, 8)}`;
  await append(page, text);
  await saved(page);
  expect(Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count)).toBe(before + 1);
  await page.reload();
  await saved(page);
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('server restart reconstructs the room and accepts locally pending edits', async ({ browser }) => {
  const { page } = await openPage(browser);
  await server.close();
  const text = ` restart-${randomUUID().slice(0, 8)}`;
  await append(page, text);
  await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  await expect(page.getByTestId('save-status')).not.toHaveText('Saved to server');
  await startServer();
  await saved(page);
  const peer = await openPage(browser);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('an uncertain commit reloads both browser sessions before further edits', async ({ browser, request }) => {
  const a = await openPage(browser);
  const b = await openPage(browser);
  const first = ` uncertain-${randomUUID().slice(0, 8)}`;
  const second = ` after-recovery-${randomUUID().slice(0, 8)}`;
  expect((await request.post('http://127.0.0.1:3002/api/test/faults', { data: { postCommitError: true } })).ok()).toBe(true);
  await append(a.page, first);
  await expect(b.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(first);
  await append(b.page, second);
  for (const page of [a.page, b.page]) {
    await saved(page);
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(first);
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(second);
  }
});

test('collaborative undo removes only this session’s edit and title paste stays on one line', async ({ browser }) => {
  const a = await openPage(browser);
  const b = await openPage(browser);
  const own = ` own-${randomUUID().slice(0, 8)}`;
  const remote = ` remote-${randomUUID().slice(0, 8)}`;
  await append(a.page, own);
  await saved(a.page);
  await expect(b.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(own);
  await append(b.page, remote);
  await saved(b.page);
  const body = a.page.getByRole('textbox', { name: 'Page body', exact: true });
  await expect(body).toContainText(remote);
  await body.press('ControlOrMeta+z');
  await expect(body).not.toContainText(own);
  await expect(body).toContainText(remote);
  await saved(a.page);
  const title = a.page.getByRole('textbox', { name: 'Page title', exact: true });
  await title.click();
  await title.press('ControlOrMeta+a');
  await title.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'A title\nwith a second line');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(title).toHaveText('A title with a second line');
  await expect(title.locator('p')).toHaveCount(1);
  await saved(a.page);
  await expect(b.page.getByRole('textbox', { name: 'Page title', exact: true })).toHaveText('A title with a second line');
});

test('real PostgreSQL write failure never reports a server save and recovers after retry', async ({ browser }) => {
  const { page } = await openPage(browser);
  const before = Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count);
  await pool.query(`CREATE FUNCTION reject_test_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test persistence failure'; END $$;
    CREATE TRIGGER reject_test_update BEFORE INSERT ON document_updates FOR EACH ROW EXECUTE FUNCTION reject_test_update()`);
  const text = ` database-failure-${randomUUID().slice(0, 8)}`;
  try {
    await append(page, text);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
    await expect(page.getByTestId('save-status')).not.toHaveText('Saved to server');
    expect(Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count)).toBe(before);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
    await expect(page.getByTestId('save-status')).not.toHaveText('Saved to server');
  } finally {
    await pool.query('DROP TRIGGER reject_test_update ON document_updates; DROP FUNCTION reject_test_update()');
  }
  // Retryable storage errors reconnect automatically, retaining the same batch.
  await saved(page);
  const peer = await openPage(browser);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('unknown pages, incompatible clients and foreign origins fail closed', async () => {
  for (const wire of [await rawConnection(randomUUID()), await rawConnection(DEV_PAGE_ID, 999)]) {
    const error = await wire.next('error');
    expect(error.type === 'error' && error.retryable).toBe(false);
    wire.socket.close();
  }
  const denied = new WebSocket('ws://127.0.0.1:3002/api/sync', { origin: 'https://untrusted.example' });
  const status = await new Promise<number>((resolve, reject) => {
    denied.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); denied.terminate(); });
    denied.once('open', () => reject(new Error('Unexpected accepted foreign origin')));
    denied.on('error', () => {});
  });
  expect(status).toBe(403);
});

test('keyboard split/merge, headings, selection, paste and local undo keep block IDs unique', async ({ browser }) => {
  const { page } = await openPage(browser);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.fill('First thought');
  await body.press('ControlOrMeta+End');
  await body.press('Enter');
  await page.keyboard.insertText('Second thought');
  await saved(page);
  await expect(body.locator('p')).toHaveCount(2);
  // End Yjs's 500ms typing capture window before testing an isolated merge undo.
  await page.waitForTimeout(550);
  await body.press('Home');
  await body.press('Backspace');
  await expect(body.locator('p')).toHaveCount(1);
  await body.press('ControlOrMeta+z');
  await expect(body.locator('p')).toHaveCount(2);
  await body.press('ControlOrMeta+Alt+2');
  await expect(body.locator('h2')).toHaveCount(1);
  // Browser clipboard event enters ProseMirror's real paste pipeline.
  await body.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<p data-id="copied">Pasted first</p><p data-id="copied">Pasted second</p>');
    clipboardData.setData('text/plain', 'Pasted first\nPasted second');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(body).toContainText('Pasted first');
  await expect(body).toContainText('Pasted second');
  await saved(page);
  const ids = await body.locator('p, h1, h2, h3').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  const title = page.getByRole('textbox', { name: 'Page title', exact: true });
  await title.click();
  await title.press('Tab');
  await expect(page.getByRole('button', { name: 'Paragraph', exact: true })).toBeFocused();
  await title.click();
  await title.press('Enter');
  await expect(body).toBeFocused();
  await page.screenshot({ path: 'test-results/kikit-desktop.png', fullPage: true });
});

test('composition input commits Unicode text and synchronizes it without duplication', async ({ browser }) => {
  const a = await openPage(browser);
  const b = await openPage(browser);
  const body = a.page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.click();
  await body.press('ControlOrMeta+End');
  const input = await a.context.newCDPSession(a.page);
  await input.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await input.send('Input.insertText', { text: '日本語' });
  await saved(a.page);
  await expect(body).toContainText('日本語');
  await expect(body).not.toContainText('にほん');
  await expect(b.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText('日本語');
  await input.detach();
});
