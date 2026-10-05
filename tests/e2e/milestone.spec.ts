import { clickHeaderAction, openHeaderMenu } from './header-actions';
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
  expectServerSaved, expectDocumentText, expectDocumentContains, expectDocumentExcludes, appendToBody, openRawSyncConnection, createTitleUpdate,
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

test('quiet header menu supports keyboard dismissal, diagnostics preference and mobile appearance', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/');
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await expect(body).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveCount(0);
  await expect(page.getByTestId('connection-status')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Note menu', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Download recovery file', exact: true })).toBeFocused();
  await page.getByRole('checkbox', { name: 'Show sync details', exact: true }).check();
  await expectServerSaved(page);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expectServerSaved(page);
  const text = ` menu-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expectServerSaved(page);
  await openHeaderMenu(page);
  await page.getByRole('checkbox', { name: 'Show sync details', exact: true }).uncheck();
  await body.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toBeFocused();
  await expect(page.getByTestId('save-status')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/fixture/header-light-desktop.png', fullPage: true });
  await clickHeaderAction(page, 'Switch to dark mode');
  await expect(trigger).toBeFocused();
  await body.focus();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectDocumentExcludes(body, text);
  await page.setViewportSize({ width: 320, height: 700 });
  await openHeaderMenu(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.getByRole('region', { name: 'Note menu', exact: true }).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: 'test-results/fixture/header-dark-mobile-menu.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(body).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.locator('.offline-notice')).toContainText('Offline.');
  await expect(page.getByTestId('save-status')).toHaveCount(0);
});

test('two independent browser contexts edit concurrently and reload committed content', async ({ browser }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const tokenA = ` alpha-${randomUUID().slice(0, 8)}`;
  const tokenB = ` beta-${randomUUID().slice(0, 8)}`;
  await Promise.all([appendToBody(author.page, tokenA), appendToBody(peer.page, tokenB)]);
  for (const page of [author.page, peer.page]) {
    await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), tokenA);
    await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), tokenB);
    await expectServerSaved(page);
  }
  await author.page.getByRole('textbox', { name: 'Page title', exact: true }).fill('A place for good ideas');
  await expectServerSaved(author.page);
  await expectDocumentText(peer.page.getByRole('textbox', { name: 'Page title', exact: true }), 'A place for good ideas');
  await peer.page.reload();
  await expectServerSaved(peer.page);
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), tokenA);
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
  await expectDocumentContains(body, text);
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
  await clickHeaderAction(page, 'Switch to light mode');
  await expect(html).toHaveAttribute('data-theme', 'light');
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await expectDocumentContains(body, text);
  await body.focus();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectDocumentExcludes(body, text);
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
      if (key === 'kikit-theme' || key === 'kikit-sync-details') throw new DOMException('Storage unavailable', 'SecurityError');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'kikit-theme' || key === 'kikit-sync-details') throw new DOMException('Storage unavailable', 'SecurityError');
      setItem.call(this, key, value);
    };
  });
  const page = await context.newPage();
  await page.goto('/');
  await expectServerSaved(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await clickHeaderAction(page, 'Switch to light mode');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const text = ` storage-denied-${randomUUID().slice(0, 8)}`;
  await appendToBody(page, text);
  await expectServerSaved(page);
  await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), text);
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
    await clickHeaderAction(page, 'Download recovery file');
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
  await clickHeaderAction(page, 'Download recovery file');
  await expect(page.getByRole('alert')).toContainText('The recovery file could not be created');
  await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), text);
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
  await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), text);
  await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), 'first second');
  await context.setOffline(false);
  await expectServerSaved(page);
  const peer = await openPage(browser);
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), text);
});

for (const container of ['body', 'taskList'] as const) {
test(`concurrent offline deletions recover an editable ${container} through cursor refreshes and drain subsequent journal batches`, async ({ browser, request }) => {
  const author = await openPage(browser);
  const bodyA = author.page.getByRole('textbox', { name: 'Page body', exact: true });
  await bodyA.fill('First paragraph');
  await bodyA.press('ControlOrMeta+End');
  await bodyA.press('Enter');
  await author.page.keyboard.insertText('Second paragraph');
  if (container === 'taskList') {
    await bodyA.press('ControlOrMeta+a');
    await author.page.getByRole('button', { name: 'To-do list', exact: true }).click();
    await expect(bodyA.locator('li[data-type="taskItem"]')).toHaveCount(2);
  }
  await expectServerSaved(author.page);
  const peer = await openPage(browser);
  const bodyB = peer.page.getByRole('textbox', { name: 'Page body', exact: true });
  const originalIds = await bodyA.locator('p').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  await Promise.all([author.context.setOffline(true), peer.context.setOffline(true)]);
  for (const [body, index] of [[bodyA, 0], [bodyB, 1]] as const) {
    // Use the mounted Tiptap command to delete exactly one whole block. Native
    // selections can merge blocks and thus delete a different CRDT identity.
    await body.evaluate((element, { index, container }) => {
      type Block = { nodeSize: number; child(index: number): Block };
      const editor = (element as HTMLElement & {
        editor: {
          state: { doc: Block };
          commands: { deleteRange(range: { from: number; to: number }): boolean };
        }
      }).editor;
      const parent = container === 'taskList' ? editor.state.doc.child(0) : editor.state.doc;
      const from = (container === 'taskList' ? 1 : 0) + (index === 0 ? 0 : parent.child(0).nodeSize);
      editor.commands.deleteRange({ from, to: from + parent.child(index).nodeSize });
    }, { index, container });
    await expect(body.locator('p')).toHaveCount(1);
  }
  for (const page of [author.page, peer.page]) await expect(page.getByTestId('local-status')).toHaveText('Saved on this device');
  // Commit A first. B's reconnect merges that committed deletion with its own
  // pending deletion before the server receives B's immutable journal record.
  await author.context.setOffline(false);
  await expectServerSaved(author.page);
  await Promise.all([
    peer.context.setOffline(false),
    // Real selection changes publish cursor-only awareness while the peer's
    // pending deletion merges with the newly committed state.
    (async () => {
      await bodyA.focus();
      for (let index = 0; index < 3; index++) {
        await bodyA.press('ArrowLeft');
        await bodyA.press('ArrowRight');
      }
    })(),
  ]);
  for (const page of [author.page, peer.page]) await expectServerSaved(page);
  for (const body of [bodyA, bodyB]) {
    await expect(body.locator('p')).toHaveCount(1);
    await expectDocumentText(body, '');
    if (container === 'taskList') {
      await expect(body.locator('ul[data-type="taskList"]')).toHaveCount(1);
      await expect(body.locator('li[data-type="taskItem"]')).toHaveCount(1);
      await expect(body.getByRole('checkbox')).not.toBeChecked();
    }
  }
  const repairedId = await bodyA.locator('p').getAttribute('data-id');
  expect(repairedId).toBeTruthy();
  expect(originalIds).not.toContain(repairedId);
  await expect(bodyB.locator('p')).toHaveAttribute('data-id', repairedId!);
  if (container === 'taskList') {
    // Edit the repaired item itself. Clicking below a checklist and moving
    // to the document end may intentionally create another item/paragraph.
    await bodyB.locator('p').click();
    await peer.page.keyboard.insertText('After concurrent deletion');
  } else await appendToBody(peer.page, 'After concurrent deletion');
  await expectServerSaved(peer.page);
  await expectDocumentText(bodyA, 'After concurrent deletion');
  if (container === 'taskList') {
    await bodyA.locator('p').click();
    await bodyA.press('End');
    await author.page.keyboard.insertText(' and another edit');
  } else await appendToBody(author.page, ' and another edit');
  for (const page of [author.page, peer.page]) await expectServerSaved(page);
  await Promise.all([author.page.reload(), peer.page.reload()]);
  for (const page of [author.page, peer.page]) {
    await expectServerSaved(page);
    const body = page.getByRole('textbox', { name: 'Page body', exact: true });
    await expectDocumentText(body, 'After concurrent deletion and another edit');
    await expect(body.locator('p')).toHaveAttribute('data-id', repairedId!);
  }
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:3002/api/test/metrics')).json()).pendingCount).toBe(0);
});
}

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
  await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), text);
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
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), text);
});

test('an uncertain commit reloads both browser sessions before further edits', async ({ browser, request }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const first = ` uncertain-${randomUUID().slice(0, 8)}`;
  const second = ` after-recovery-${randomUUID().slice(0, 8)}`;
  expect((await request.post('http://127.0.0.1:3002/api/test/faults', { data: { postCommitError: true } })).ok()).toBe(true);
  await appendToBody(author.page, first);
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), first);
  await appendToBody(peer.page, second);
  for (const page of [author.page, peer.page]) {
    await expectServerSaved(page);
    await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), first);
    await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), second);
  }
});

test('collaborative undo removes only this session’s edit and title paste stays on one line', async ({ browser }) => {
  const author = await openPage(browser);
  const peer = await openPage(browser);
  const own = ` own-${randomUUID().slice(0, 8)}`;
  const remote = ` remote-${randomUUID().slice(0, 8)}`;
  await appendToBody(author.page, own);
  await expectServerSaved(author.page);
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), own);
  await appendToBody(peer.page, remote);
  await expectServerSaved(peer.page);
  const body = author.page.getByRole('textbox', { name: 'Page body', exact: true });
  await expectDocumentContains(body, remote);
  await body.press('ControlOrMeta+z');
  await expectDocumentExcludes(body, own);
  await expectDocumentContains(body, remote);
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
  await expectDocumentText(title, 'A title with a second line');
  await expect(title.locator('p')).toHaveCount(1);
  await expectServerSaved(author.page);
  await expectDocumentText(peer.page.getByRole('textbox', { name: 'Page title', exact: true }), 'A title with a second line');
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
    await expectDocumentContains(page.getByRole('textbox', { name: 'Page body', exact: true }), text);
    await expect(page.getByTestId('save-status')).not.toHaveText('Saved to server');
  } finally {
    await pool.query('DROP TRIGGER reject_test_update ON document_updates; DROP FUNCTION reject_test_update()');
  }
  // Retryable storage errors reconnect automatically, retaining the same batch.
  await expectServerSaved(page);
  const peer = await openPage(browser);
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), text);
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
  await expectDocumentContains(body, 'Pasted first');
  await expectDocumentContains(body, 'Pasted second');
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
  await expectDocumentContains(body, '日本語');
  await expectDocumentExcludes(body, 'にほん');
  await expectDocumentContains(peer.page.getByRole('textbox', { name: 'Page body', exact: true }), '日本語');
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
  await expectDocumentText(body.locator('h2'), 'A heading');
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
    await expectDocumentText(body.locator(`h${level}`), `Heading ${level}`);
    await body.press('Enter');
  }
  await expect(body.locator('p')).toHaveCount(1);
});

test('a selected pair of paragraphs converts to tasks and back without replacing their text IDs', async ({ browser }) => {
  const { page } = await openPage(browser);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.fill('First selected paragraph');
  await page.getByRole('button', { name: 'Paragraph', exact: true }).click();
  await body.press('ControlOrMeta+End');
  await body.press('Enter');
  await page.keyboard.insertText('Second selected paragraph');
  await expect(body.locator('p')).toHaveCount(2);
  const textIds = await body.locator('p').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  await body.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'To-do list', exact: true }).click();
  await expect(body.locator('li[data-type="taskItem"]')).toHaveCount(2);
  await expect(body.getByRole('checkbox', { checked: false })).toHaveCount(2);
  expect(await body.locator('p').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')))).toEqual(textIds);
  await expectDocumentContains(body, 'First selected paragraph');
  await expectDocumentContains(body, 'Second selected paragraph');
  await body.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Paragraph', exact: true }).click();
  await expect(body.locator('ul')).toHaveCount(0);
  await expect(body.locator(':scope > p')).toHaveCount(2);
  expect(await body.locator('p').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')))).toEqual(textIds);
  await expectDocumentContains(body, 'First selected paragraph');
  await expectDocumentContains(body, 'Second selected paragraph');
  await expectServerSaved(page);
});

test('flat task lists support shortcuts, keyboard checks, split/merge, conversion and fresh pasted IDs', async ({ browser }) => {
  const { page } = await openPage(browser);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  const items = body.locator('li[data-type="taskItem"]');
  await body.fill('');
  await body.pressSequentially('[ ] ');
  await page.keyboard.insertText('First task');
  await expect(items).toHaveCount(1);
  const firstId = await items.first().getAttribute('data-id');
  await expect(items.first().getByRole('checkbox')).toHaveAccessibleName('Complete task: First task');
  await items.first().getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await expect(items.first().getByRole('checkbox')).toBeChecked();
  await expect(items.first().getByRole('checkbox')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(items.first().getByRole('checkbox')).not.toBeChecked();
  await expectDocumentContains(body, 'First task');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(items.first().getByRole('checkbox')).toBeChecked();

  await body.focus();
  await body.press('ControlOrMeta+End');
  await body.press('Enter');
  await page.keyboard.insertText('Second task');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1).getByRole('checkbox')).not.toBeChecked();
  expect(await items.nth(1).getAttribute('data-id')).not.toBe(firstId);
  await expectServerSaved(page);
  await page.waitForTimeout(550);
  await body.press('Home');
  await body.press('Backspace');
  await expect(items).toHaveCount(1);
  await expectDocumentContains(items.first().locator('p'), 'First taskSecond task');
  await body.press('ControlOrMeta+z');
  await expect(items).toHaveCount(2);

  await body.press('ControlOrMeta+End');
  await body.press('Enter');
  await expect(items).toHaveCount(3);
  await body.press('Enter');
  await expect(items).toHaveCount(2);
  await page.keyboard.insertText('Convertible paragraph');
  await page.getByRole('button', { name: 'To-do list', exact: true }).click();
  await expect(items).toHaveCount(3);
  await page.getByRole('button', { name: 'Paragraph', exact: true }).click();
  await expect(items).toHaveCount(2);
  await expectDocumentContains(body.locator(':scope > p').last(), 'Convertible paragraph');
  await page.getByRole('button', { name: 'To-do list', exact: true }).click();
  await page.getByRole('button', { name: 'Heading 2', exact: true }).click();
  await expect(items).toHaveCount(2);
  await expectDocumentText(body.locator(':scope > h2'), 'Convertible paragraph');

  await body.press('ControlOrMeta+End');
  await body.press('Enter');
  await body.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<ul data-type="taskList" data-id="copied-list"><li data-type="taskItem" data-checked="true" data-id="copied-item"><p data-id="copied-text">Pasted checked task</p></li><li data-type="taskItem" data-checked="false" data-id="copied-item"><p data-id="copied-text">Pasted unchecked task</p></li></ul>');
    clipboardData.setData('text/plain', 'Pasted checked task\nPasted unchecked task');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(items).toHaveCount(4);
  await expect(body.getByRole('checkbox', { name: 'Complete task: Pasted checked task', exact: true })).toBeChecked();
  await expect(body.getByRole('checkbox', { name: 'Complete task: Pasted unchecked task', exact: true })).not.toBeChecked();
  await expectDocumentContains(body, 'Pasted checked task');
  await expectDocumentContains(body, 'Pasted unchecked task');
  expect(await items.first().getAttribute('data-id')).toBe(firstId);
  const ids = await body.locator('p, h1, h2, h3, ul[data-type="taskList"], li[data-type="taskItem"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.some(id => id?.startsWith('copied-'))).toBe(false);

  await body.press('ControlOrMeta+End');
  await body.press('Enter');
  await body.press('Enter');
  await body.pressSequentially('[x] ');
  await page.keyboard.insertText('Already completed');
  await expect(body.getByRole('checkbox', { name: 'Complete task: Already completed', exact: true })).toBeChecked();
  await body.press('Tab');
  await expect(body.locator('li ul')).toHaveCount(0);
  await expectServerSaved(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test-results/fixture/task-lists-light-desktop.png', fullPage: true });
  await clickHeaderAction(page, 'Switch to dark mode');
  await page.screenshot({ path: 'test-results/fixture/task-lists-dark-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/fixture/task-lists-dark-mobile.png', fullPage: true });
});

test('a lost checkbox acknowledgement retries one durable batch and preserves checked state and identity', async ({ browser, request }) => {
  const { page } = await openPage(browser);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.focus();
  await body.press('ControlOrMeta+a');
  await body.press('Backspace');
  await page.keyboard.insertText('Durable checkbox');
  await page.getByRole('button', { name: 'Paragraph', exact: true }).click();
  await expectDocumentText(body, 'Durable checkbox');
  await page.getByRole('button', { name: 'To-do list', exact: true }).click();
  const item = body.locator('li[data-type="taskItem"]').first();
  await expect(item.getByRole('checkbox')).not.toBeChecked();
  await expectServerSaved(page);
  const id = await item.getAttribute('data-id');
  const before = Number((await pool.query('SELECT count(*) FROM receipts WHERE page_id=$1', [DEV_PAGE_ID])).rows[0].count);
  expect((await request.post('http://127.0.0.1:3002/api/test/faults', { data: { dropNextAck: true } })).ok()).toBe(true);
  await item.getByRole('checkbox').click();
  await expectServerSaved(page);
  expect(Number((await pool.query('SELECT count(*) FROM receipts WHERE page_id=$1', [DEV_PAGE_ID])).rows[0].count)).toBe(before + 1);
  await page.reload();
  await expectServerSaved(page);
  await expect(item.getByRole('checkbox')).toBeChecked();
  expect(await item.getAttribute('data-id')).toBe(id);
  await expectDocumentContains(body, 'Durable checkbox');
  // Reloading a task-first document must place the initial text selection
  // inside its paragraph rather than in the non-text list wrapper.
  await page.getByRole('textbox', { name: 'Page title', exact: true }).click();
  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();
  expect(await body.evaluate(element => {
    const editor = (element as HTMLElement & {
      editor: { state: { selection: { $from: { parent: { inlineContent: boolean } }; $to: { parent: { inlineContent: boolean } } } } };
    }).editor;
    return editor.state.selection.$from.parent.inlineContent && editor.state.selection.$to.parent.inlineContent;
  })).toBe(true);
  await page.keyboard.insertText('Reloaded task edit. ');
  await expectDocumentContains(item.locator('p'), 'Reloaded task edit. ');
  await expectDocumentContains(item.locator('p'), 'Durable checkbox');
  expect(await item.getAttribute('data-id')).toBe(id);
  await expect(item.getByRole('checkbox')).toBeChecked();
  await expectServerSaved(page);
});
