import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, decodeUpdate } from '@kikit/contracts';
import { migrateDatabase } from '../../apps/server/src/persistence';
import { seedDevelopmentPage } from '../../apps/server/src/development-seed';
import {
  pool, server, contexts, startServer, openPage,
  expectServerSaved, appendToBody, openRawSyncConnection, createTitleUpdate,
} from './support';

test.beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.KIKIT_DEV_FIXTURE = '1';
  process.env.KIKIT_TEST_FAULTS = '1';
  // This fixed database exists exclusively for this suite. Development notes are untouched.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrateDatabase(pool);
  await seedDevelopmentPage(pool);
  await startServer();
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.close()));
});

test.afterAll(async () => {
  await server?.close();
  await pool.end();
});

test('two independent browser contexts edit concurrently and reload committed content', async ({ browser }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const tokenA = ` alpha-${randomUUID().slice(0, 8)}`;
  const tokenB = ` beta-${randomUUID().slice(0, 8)}`;
  await Promise.all([appendToBody(author.page, tokenA), appendToBody(peer.page, tokenB)]);
  for (const page of [author.page, peer.page]) {
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(tokenA);
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(tokenB);
    await expectServerSaved(page);
  }
  await author.page.getByRole('textbox', { name: 'Page title', exact: true }).fill('A place for good ideas');
  await expectServerSaved(author.page);
  await expect(peer.page.getByRole('textbox', { name: 'Page title', exact: true })).toHaveText('A place for good ideas');
  await peer.page.reload();
  await expectServerSaved(peer.page);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(tokenA);
});

test('clicking below a short note keeps writing in the page body', async ({ browser }) => {
  const { page } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  const bounds = await body.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + 24;
  const y = 790;
  expect(bounds!.y + bounds!.height).toBeGreaterThan(y);
  await page.mouse.click(x, y);
  await expect(body).toBeFocused();
  const text = ` lower-page-${randomUUID().slice(0, 8)}`;
  await page.keyboard.insertText(text);
  await expect(body).toContainText(text);
});

test('theme follows the system until chosen, persists after reload, and preserves editor undo', async ({ browser }) => {
  const { page } = await openPage(browser, { colorScheme: 'dark', viewport: { width: 390, height: 844 } });
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const text = ` theme-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expectServerSaved(page);
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await expect(body).toContainText(text);
  await body.focus();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(body).not.toContainText(text);
  await expectServerSaved(page);
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expectServerSaved(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unavailable theme preference storage does not prevent editing or switching appearance', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  contexts.push(context);
  await context.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {
      if (key === 'kikit-theme') throw new DOMException('Storage unavailable', 'SecurityError');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'kikit-theme') throw new DOMException('Storage unavailable', 'SecurityError');
      setItem.call(this, key, value);
    };
  });
  const page = await context.newPage();
  await page.goto('/');
  await expectServerSaved(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const text = ` storage-denied-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expectServerSaved(page);
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('recovery download retains offline batch identities after export failure and reload', async ({ browser }) => {
  const { page, context } = await openPage(browser);
  await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'true');
  await context.setOffline(true);
  const text = ` recovery-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  const downloadRecovery = async () => {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download recovery file', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^kikit-recovery-\d{4}-\d{2}-\d{2}\.json$/);
    return JSON.parse(await readFile((await download.path())!, 'utf8'));
  };
  const original = await downloadRecovery();
  expect(original).toMatchObject({
    format: 'kikit-recovery', formatVersion: 1, schemaVersion: DOCUMENT_SCHEMA_VERSION,
    accountId: DEV_ACCOUNT_ID, pageId: DEV_PAGE_ID,
  });
  expect(original.pending.length).toBeGreaterThan(0);
  const recovered = new Y.Doc();
  try {
    Y.applyUpdate(recovered, decodeUpdate(original.update));
    expect(recovered.getXmlFragment('body').toString()).toContain(text);
  } finally {
    recovered.destroy();
  }
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('Simulated download failure'); }; });
  await page.getByRole('button', { name: 'Download recovery file', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The recovery file could not be created');
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
  await page.reload();
  await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  const retried = await downloadRecovery();
  expect(retried.pending).toEqual(original.pending);
  await context.setOffline(false);
  await expectServerSaved(page);
});

test('offline edits survive an offline reload, then reconnect using the durable journal', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'true');
  await context.setOffline(true);
  const text = ` offline-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
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
  await expectServerSaved(page);
  const peer = await openPage(browser);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('concurrent offline deletions recover an editable body and drain subsequent journal batches', async ({ browser, request }) => {
  const author = await openPage(browser);
  const bodyA = author.page.getByRole('textbox', { name: 'Page body', exact: true });
  await bodyA.fill('First paragraph');
  await bodyA.press('ControlOrMeta+End');
  await bodyA.press('Enter');
  await author.page.keyboard.insertText('Second paragraph');
  await expectServerSaved(author.page);
  const peer = await openPage(browser);
  const bodyB = peer.page.getByRole('textbox', { name: 'Page body', exact: true });
  const originalIds = await bodyA.locator('p').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  await Promise.all([author.context.setOffline(true), peer.context.setOffline(true)]);
  for (const [body, index] of [[bodyA, 0], [bodyB, 1]] as const) {
    // Use the mounted Tiptap command to delete exactly one whole block. Native
    // selections can merge blocks and thus delete a different CRDT identity.
    await body.evaluate((element, index) => {
      const editor = (element as HTMLElement & {
        editor: {
          state: { doc: { child(index: number): { nodeSize: number } } };
          commands: { deleteRange(range: { from: number; to: number }): boolean };
        }
      }).editor;
      const from = index === 0 ? 0 : editor.state.doc.child(0).nodeSize;
      editor.commands.deleteRange({ from, to: from + editor.state.doc.child(index).nodeSize });
    }, index);
    await expect(body.locator('p')).toHaveCount(1);
  }
  for (const page of [author.page, peer.page]) await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  // Commit A first. B's reconnect merges that committed deletion with its own
  // pending deletion before the server receives B's immutable journal record.
  await author.context.setOffline(false);
  await expectServerSaved(author.page);
  await peer.context.setOffline(false);
  for (const page of [author.page, peer.page]) await expectServerSaved(page);
  for (const body of [bodyA, bodyB]) {
    await expect(body.locator('p')).toHaveCount(1);
    await expect(body).toHaveText('');
  }
  const repairedId = await bodyA.locator('p').getAttribute('data-id');
  expect(repairedId).toBeTruthy();
  expect(originalIds).not.toContain(repairedId);
  await expect(bodyB.locator('p')).toHaveAttribute('data-id', repairedId!);
  await appendToBody(peer.page, 'After concurrent deletion');
  await expectServerSaved(peer.page);
  await expect(bodyA).toHaveText('After concurrent deletion');
  await appendToBody(author.page, ' and another edit');
  for (const page of [author.page, peer.page]) await expectServerSaved(page);
  await Promise.all([author.page.reload(), peer.page.reload()]);
  for (const page of [author.page, peer.page]) {
    await expectServerSaved(page);
    const body = page.getByRole('textbox', { name: 'Page body', exact: true });
    await expect(body).toHaveText('After concurrent deletion and another edit');
    await expect(body.locator('p')).toHaveAttribute('data-id', repairedId!);
  }
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:3002/api/test/metrics')).json()).pendingCount).toBe(0);
});

test('same batch is idempotent and reuse with different bytes is rejected', async () => {
  const wire = await openRawSyncConnection();
  try {
    const sync = await wire.next('sync');
    const batchId = randomUUID();
    const update = createTitleUpdate(sync, ' · receipts');
    wire.socket.send(JSON.stringify({
      type: 'update',
      batchId,
      update
    }));
    const original = await wire.next('ack');
    wire.socket.send(JSON.stringify({
      type: 'update',
      batchId,
      update
    }));
    expect(await wire.next('ack')).toEqual(original);
    const count = await pool.query('SELECT count(*)::int count FROM receipts WHERE page_id=$1 AND batch_id=$2', [DEV_PAGE_ID, batchId]);
    expect(count.rows[0].count).toBe(1);
    wire.socket.send(JSON.stringify({
      type: 'update',
      batchId,
      update: createTitleUpdate(sync, ' different bytes')
    }));
    const rejected = await wire.next('error');
    expect(rejected.type === 'error' && rejected.retryable).toBe(false);
  } finally {
    wire.socket.close();
  }
});

test('lost acknowledgement after commit is retried without a second database update', async ({ browser, request }) => {
  const { page } = await openPage(browser);
  const before = Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count);
  const fault = await request.post('http://127.0.0.1:3002/api/test/faults', { data: { dropNextAck: true } });
  expect(fault.ok()).toBe(true);
  const text = ` lost-ack-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expectServerSaved(page);
  expect(Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count)).toBe(before + 1);
  await page.reload();
  await expectServerSaved(page);
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('server restart reconstructs the room and accepts locally pending edits', async ({ browser }) => {
  const { page } = await openPage(browser);
  await server.close();
  const text = ` restart-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  await expect(page.getByTestId('save-status')).not.toHaveText('Saved to server');
  await startServer();
  await expectServerSaved(page);
  const peer = await openPage(browser);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('an uncertain commit reloads both browser sessions before further edits', async ({ browser, request }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const first = ` uncertain-${randomUUID().slice(0, 8)}`;
  const second = ` after-recovery-${randomUUID().slice(0, 8)}`;
  expect((await request.post('http://127.0.0.1:3002/api/test/faults', { data: { postCommitError: true } })).ok()).toBe(true);
  await appendToBody(author.page, first);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(first);
  await appendToBody(peer.page, second);
  for (const page of [author.page, peer.page]) {
    await expectServerSaved(page);
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(first);
    await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(second);
  }
});

test('collaborative undo removes only this session’s edit and title paste stays on one line', async ({ browser }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const own = ` own-${randomUUID().slice(0, 8)}`;
  const remote = ` remote-${randomUUID().slice(0, 8)}`;
  await appendToBody(author.page, own);
  await expectServerSaved(author.page);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(own);
  await appendToBody(peer.page, remote);
  await expectServerSaved(peer.page);
  const body = author.page.getByRole('textbox', { name: 'Page body', exact: true });
  await expect(body).toContainText(remote);
  await body.press('ControlOrMeta+z');
  await expect(body).not.toContainText(own);
  await expect(body).toContainText(remote);
  await expectServerSaved(author.page);
  const title = author.page.getByRole('textbox', { name: 'Page title', exact: true });
  await title.click();
  await title.press('ControlOrMeta+a');
  await title.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'A title\nwith a second line');
    element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true
    }));
  });
  await expect(title).toHaveText('A title with a second line');
  await expect(title.locator('p')).toHaveCount(1);
  await expectServerSaved(author.page);
  await expect(peer.page.getByRole('textbox', { name: 'Page title', exact: true })).toHaveText('A title with a second line');
});

test('real PostgreSQL write failure never reports a server save and recovers after retry', async ({ browser }) => {
  const { page } = await openPage(browser);
  const before = Number((await pool.query('SELECT count(*) FROM receipts')).rows[0].count);
  await pool.query(`CREATE FUNCTION reject_test_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test persistence failure'; END $$;
    CREATE TRIGGER reject_test_update BEFORE INSERT ON document_updates FOR EACH ROW EXECUTE FUNCTION reject_test_update()`);
  const text = ` database-failure-${randomUUID().slice(0, 8)}`;
  try {
    await appendToBody(page, text);
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
  await expectServerSaved(page);
  const peer = await openPage(browser);
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(text);
});

test('unknown pages, incompatible clients and foreign origins fail closed', async () => {
  for (const wire of [await openRawSyncConnection(randomUUID()), await openRawSyncConnection(DEV_PAGE_ID, 999)]) {
    const error = await wire.next('error');
    expect(error.type === 'error' && error.retryable).toBe(false);
    wire.socket.close();
  }
  const denied = new WebSocket('ws://127.0.0.1:3002/api/sync', { origin: 'https://untrusted.example' });
  const status = await new Promise<number>((resolve, reject) => {
    denied.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode!);
      response.resume();
      denied.terminate();
    });
    denied.once('open', () => reject(new Error('Unexpected accepted foreign origin')));
    denied.on('error', () => { });
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
  await expectServerSaved(page);
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
    element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true
    }));
  });
  await expect(body).toContainText('Pasted first');
  await expect(body).toContainText('Pasted second');
  await expectServerSaved(page);
  const ids = await body.locator('p, h1, h2, h3').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  const title = page.getByRole('textbox', { name: 'Page title', exact: true });
  await title.click();
  await title.press('Tab');
  await expect(body).toBeFocused();
  await title.click();
  await title.press('Enter');
  await expect(body).toBeFocused();
  await page.screenshot({ path: 'test-results/kikit-desktop.png', fullPage: true });
});

test('composition input commits Unicode text and synchronizes it without duplication', async ({ browser }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const body = author.page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.click();
  await body.press('ControlOrMeta+End');
  const input = await author.context.newCDPSession(author.page);
  await input.send('Input.imeSetComposition', {
    text: 'にほん',
    selectionStart: 3,
    selectionEnd: 3
  });
  await input.send('Input.insertText', { text: '日本語' });
  await expectServerSaved(author.page);
  await expect(body).toContainText('日本語');
  await expect(body).not.toContainText('にほん');
  await expect(peer.page.getByRole('textbox', { name: 'Page body', exact: true })).toContainText('日本語');
  await input.detach();
});

test('formatting controls appear while writing without moving the page', async ({ browser }) => {
  const { page } = await openPage(browser);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  const title = page.getByRole('textbox', { name: 'Page title', exact: true });
  const toolbar = page.getByRole('group', { name: 'Text formatting' });
  await expect(toolbar).toBeHidden();
  const before = await body.boundingBox();
  await body.click();
  await expect(toolbar).toBeVisible();
  const after = await body.boundingBox();
  expect(after?.y).toBe(before?.y);
  await body.fill('A heading');
  await page.getByRole('button', { name: 'Heading 2', exact: true }).click();
  await expect(body.locator('h2')).toHaveText('A heading');
  await title.click();
  await expect(toolbar).toBeHidden();
});

test('hash shortcuts create all supported heading levels', async ({ browser }) => {
  const { page } = await openPage(browser);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.fill('');
  for (const level of [1, 2, 3] as const) {
    await body.pressSequentially(`${'#'.repeat(level)} `);
    await page.keyboard.insertText(`Heading ${level}`);
    await expect(body.locator(`h${level}`)).toHaveText(`Heading ${level}`);
    await body.press('Enter');
  }
  await expect(body.locator('p')).toHaveCount(1);
});
