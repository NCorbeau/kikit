import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { decodeUpdate } from '@kikit/contracts';
import { createServer } from '../../apps/server/src/app';
import { migrateDatabase } from '../../apps/server/src/migrations';
import { expectDocumentContains } from './document-assertions';

const databaseUrl = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit_e2e';
const origin = 'http://127.0.0.1:5198';
const pool = new pg.Pool({ connectionString: databaseUrl });
const mail = new Map<string, string>();
const emails: string[] = [];
let server: Awaited<ReturnType<typeof createServer>>;

test.beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.KIKIT_DEV_FIXTURE = '0';
  process.env.BETTER_AUTH_SECRET = 'browser-account-test-secret-never-used-in-production';
  await migrateDatabase(pool);
});
test.beforeEach(async () => {
  server = await createServer({ databaseUrl, origin, serveWeb: true, sendMagicLink: async ({ email, url }) => { mail.set(email, url); } });
  await server.listen({ host: '127.0.0.1', port: 5198 });
});
test.afterEach(async () => { await server.close(); });
test.afterAll(async () => {
  await server?.close();
  for (const email of emails) {
    const users = await pool.query('SELECT id FROM auth_user WHERE email=$1', [email]);
    for (const { id } of users.rows) {
      const owned = await pool.query('SELECT id FROM pages WHERE owner_id=$1', [id]);
      for (const note of owned.rows) {
        await pool.query('DELETE FROM receipts WHERE page_id=$1', [note.id]);
        await pool.query('DELETE FROM document_updates WHERE page_id=$1', [note.id]);
        await pool.query('DELETE FROM page_grants WHERE page_id=$1', [note.id]);
        await pool.query('DELETE FROM pages WHERE id=$1', [note.id]);
      }
      await pool.query('DELETE FROM auth_user WHERE id=$1', [id]);
    }
  }
  await pool.end();
});
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  await expect.poll(() => mail.get(email)).toBeTruthy();
  await page.goto(mail.get(email)!);
  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
}
const body = (page: Page) => page.getByRole('textbox', { name: 'Page body', exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved to server');

test('production build: magic links, isolated accounts, cross-device sync, offline reload, and safe sign-out', async ({ browser }) => {
  const a = `${randomUUID()}@example.test`; const b = `${randomUUID()}@example.test`; emails.push(a, b);
  const contextA = await browser.newContext(); const contextB = await browser.newContext(); const device = await browser.newContext();
  try {
    const pageA = await contextA.newPage(); const pageB = await contextB.newPage(); const pageDevice = await device.newPage();
    await pageA.goto('/');
    await pageA.screenshot({ path: '.artifacts/accounts-sign-in.png', fullPage: true });
    await login(pageA, a);
    await pageA.getByRole('button', { name: 'New note', exact: true }).click();
    await expect(body(pageA)).toBeVisible();
    await pageA.getByRole('textbox', { name: 'Page title', exact: true }).fill('Private browser note');
    await body(pageA).fill('First device.'); await saved(pageA);
    const pageId = new URL(pageA.url()).hash.split('/').at(-1)!;
    // Saved notes return directly to the list through either header control or
    // browser navigation, without mounting a confirmation dialog.
    await pageA.evaluate(() => {
      document.documentElement.dataset.leaveDialogOpened = 'false';
      const showModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function() {
        if (this.classList.contains('leave-dialog')) document.documentElement.dataset.leaveDialogOpened = 'true';
        return showModal.call(this);
      };
    });
    for (const control of ['notes', 'home', 'browser'] as const) {
      if (control === 'notes') await pageA.getByRole('button', { name: 'Notes', exact: true }).click();
      else if (control === 'home') await pageA.getByRole('link', { name: 'Kikit home', exact: true }).click();
      else await pageA.evaluate(() => { location.hash = ''; });
      await expect(pageA.getByRole('heading', { name: 'Your notes' })).toBeVisible();
      await expect(pageA.getByRole('dialog')).toHaveCount(0);
      await expect(pageA.locator('html')).toHaveAttribute('data-leave-dialog-opened', 'false');
      await pageA.getByRole('button', { name: 'Private browser note' }).click();
      await expectDocumentContains(body(pageA), 'First device.');
      await saved(pageA);
    }
    await login(pageB, b);
    await expect(pageB.getByRole('button', { name: 'Private browser note' })).toHaveCount(0);
    const denied = await pageB.request.get(`/api/pages/${pageId}/session`);
    expect(denied.status()).toBe(403);
    await login(pageDevice, a);
    await pageDevice.getByRole('button', { name: 'Private browser note' }).click();
    await expectDocumentContains(body(pageDevice), 'First device.');
    await body(pageDevice).press('End'); await pageDevice.keyboard.insertText(' Second device.');
    await saved(pageDevice); await expectDocumentContains(body(pageA), 'Second device.');
    await expect.poll(() => pageA.evaluate(() => document.documentElement.dataset.offlineReady)).toBe('true');
    await contextA.setOffline(true);
    await body(pageA).press('End'); await pageA.keyboard.insertText(' Offline draft.');
    await expect(pageA.getByTestId('save-status')).toHaveText('Saved on this device');
    await pageA.reload();
    await expectDocumentContains(body(pageA), 'Offline draft.');
    await expect(pageA.getByTestId('save-status')).toHaveText('Saved on this device');
    await contextA.setOffline(false); await saved(pageA);
    await expectDocumentContains(body(pageDevice), 'Offline draft.');
    await contextA.setOffline(true);
    await body(pageA).press('End'); await pageA.keyboard.insertText(' Pending at sign-out.');
    await expect(pageA.getByTestId('save-status')).toHaveText('Saved on this device');
    // Navigation explicitly preserves pending account-scoped records.
    await pageA.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(pageA.getByRole('dialog')).toContainText('Pending changes will stay');
    await pageA.getByRole('button', { name: 'Continue editing', exact: true }).focus();
    await pageA.keyboard.press('Shift+Tab');
    await expect(pageA.getByRole('button', { name: 'Open notes', exact: true })).toBeFocused();
    await pageA.getByRole('button', { name: 'Open notes', exact: true }).click();
    await expect(pageA.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await contextA.setOffline(false);
    await pageA.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(pageA.getByRole('heading', { name: 'Sign in to Kikit' })).toBeVisible();
    await login(pageA, b);
    await expect(pageA.getByRole('button', { name: 'Private browser note' })).toHaveCount(0);
    await pageA.getByRole('button', { name: 'Sign out', exact: true }).click();
    await login(pageA, a);
    await pageA.getByRole('button', { name: 'Private browser note' }).click();
    await expectDocumentContains(body(pageA), 'Pending at sign-out.'); await saved(pageA);
    await expectDocumentContains(body(pageDevice), 'Pending at sign-out.');
    expect((await pageA.request.get('/api/dev/session')).status()).toBe(404);
    await expect(pageA.locator('.dev-badge')).toHaveCount(0);
    await pageA.screenshot({ path: '.artifacts/accounts-private-note.png', fullPage: true });
    await pageA.setViewportSize({ width: 320, height: 700 });
    await expect.poll(() => pageA.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await pageA.screenshot({ path: '.artifacts/accounts-mobile.png', fullPage: true });
  } finally { await contextA.close(); await contextB.close(); await device.close(); }
});

test('local save failure blocks leaving and session expiry preserves an exportable in-memory draft', async ({ browser }) => {
  const email = `${randomUUID()}@example.test`; emails.push(email);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // Keep the real limiter enabled and use a separate peer for this failure drill.
    const remoteAddress = '127.0.0.99';
    const sent = await server.inject({ method: 'POST', url: '/api/auth/sign-in/magic-link', remoteAddress, headers: { origin }, payload: { email, callbackURL: '/' } });
    expect(sent.statusCode).toBe(200);
    const link = new URL(mail.get(email)!);
    const redeemed = await server.inject({ url: link.pathname + link.search, remoteAddress });
    expect(redeemed.statusCode).toBe(302);
    const setCookie = redeemed.headers['set-cookie'];
    await context.addCookies((Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean).map(value => {
      const pair = String(value).split(';')[0]!; const index = pair.indexOf('=');
      return { name: pair.slice(0, index), value: pair.slice(index + 1), url: origin, httpOnly: true, sameSite: 'Lax' as const };
    }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await expect(body(page)).toBeVisible(); await saved(page);
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase['transaction']>) {
        if (args[1] === 'readwrite') throw new DOMException('Injected quota failure', 'QuotaExceededError');
        return transaction.apply(this, args);
      };
    });
    await body(page).fill('Draft that only exists in memory.');
    await expect(page.getByTestId('save-status')).toHaveText('Device save failed');
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open notes', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue editing', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectDocumentContains(body(page), 'only exists in memory');
    await pool.query("UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE user_id IN (SELECT id FROM auth_user WHERE email=$1)", [email]);
    await page.evaluate(() => window.dispatchEvent(new Event('kikit-session-ended')));
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await expect(body(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download recovery', exact: true }).click();
    const download = await downloadEvent;
    const recovery = JSON.parse(await readFile((await download.path())!, 'utf8'));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeUpdate(recovery.update));
    expect(doc.getXmlFragment('body').toString()).toContain('Draft that only exists in memory.');
    expect(recovery.pending).toHaveLength(1); doc.destroy();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Kikit' })).toBeVisible();
  } finally { await context.close(); }
});
