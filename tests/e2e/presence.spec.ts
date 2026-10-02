import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  AccountBrowserHarness, createNote, pageBody, serverSaved, type BrowserAccount,
} from './account-support';

const harness = new AccountBrowserHarness();
const contexts: BrowserContext[] = [];

test.beforeAll(async () => { await harness.prepare(); });
test.beforeEach(async () => { await harness.start(); });
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.close()));
  await harness.stop();
});
test.afterAll(async () => { await harness.dispose(); });

async function account(browser: Browser, name: string) {
  const context = await browser.newContext(); contexts.push(context);
  const identity = await harness.authenticate(context);
  await harness.pool.query('UPDATE auth_user SET name=$2 WHERE id=$1', [identity.accountId, name]);
  const page = await context.newPage(); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  return { context, page, identity, name };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Share note', exact: true });
const title = (page: Page) => page.getByRole('textbox', { name: 'Page title', exact: true });
const participants = (page: Page) => page.getByRole('list', { name: 'Participants', exact: true });
const participant = (page: Page, accountId: string) => page.locator(`[data-testid="participant"][data-account-id="${accountId}"]`);
const caret = (page: Page, accountId: string) => page.locator(`.collaboration-caret[data-account-id="${accountId}"]`);

async function createInvitationAndInspectDialog(page: Page): Promise<string> {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = dialog(page).getByRole('textbox', { name: 'Invitation link', exact: true });
  const qr = dialog(page).getByRole('img', { name: 'Invitation QR code', exact: true });
  await expect(link).toBeVisible(); await expect(qr).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
  const token = new URL(await link.inputValue()).hash.split('/').at(-1)!;

  // Native modal focus containment must work without moving focus into the background editor.
  const controls = dialog(page).locator('button:not([disabled]), input:not([disabled])');
  await controls.first().focus();
  await page.keyboard.press('Shift+Tab'); await expect(controls.last()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(controls.first()).toBeFocused();
  await page.screenshot({ path: '.artifacts/sharing-light-desktop.png', fullPage: true, mask: [link, qr] });
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await dialog(page).evaluate(element => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(700);
  if (bounds.scrollHeight > bounds.clientHeight) expect(['auto', 'scroll']).toContain(bounds.overflowY);
  await controls.first().focus();
  await page.keyboard.press('Shift+Tab'); await expect(controls.last()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(controls.first()).toBeFocused();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: '.artifacts/sharing-dark-mobile.png', fullPage: true, mask: [link, qr] });
  await dialog(page).getByRole('button', { name: 'Close sharing controls', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  return token;
}

async function removeMember(owner: Page, member: BrowserAccount): Promise<void> {
  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  await dialog(owner).getByRole('button', { name: `Remove ${member.email}`, exact: true }).click();
  await expect(dialog(owner).getByRole('heading', { name: 'Remove member?' })).toBeVisible();
  await dialog(owner).getByRole('button', { name: 'Remove member', exact: true }).click();
  await expect(dialog(owner).getByRole('heading', { name: 'Remove member?' })).toHaveCount(0);
  await expect(dialog(owner).getByRole('button', { name: `Remove ${member.email}`, exact: true })).toHaveCount(0);
  await dialog(owner).getByRole('button', { name: 'Close sharing controls', exact: true }).click();
}

async function durableState(pageId: string) {
  return {
    page: (await harness.pool.query('SELECT sequence, title, initial_state FROM pages WHERE id=$1', [pageId])).rows,
    updates: (await harness.pool.query('SELECT sequence, payload FROM document_updates WHERE page_id=$1 ORDER BY sequence', [pageId])).rows,
    receipts: (await harness.pool.query('SELECT batch_id, sequence, payload_hash FROM receipts WHERE page_id=$1 ORDER BY sequence', [pageId])).rows,
    invitation: (await harness.pool.query('SELECT token_hash, disabled, created_at FROM page_invitations WHERE page_id=$1', [pageId])).rows,
  };
}

test('authenticated participants, title/body cursors and selections survive reconnect and disappear on revocation without durable edits', async ({ browser }) => {
  const owner = await account(browser, 'Alex Example'); const member = await account(browser, 'Sam Example');
  const pageId = await createNote(owner.page, 'Presence browser note', 'Persisted body for cursor movement.');
  const token = await createInvitationAndInspectDialog(owner.page);
  await member.page.goto(`/#/join/${token}`);
  await member.page.getByRole('button', { name: 'Join note', exact: true }).click();
  await expect(pageBody(member.page)).toBeVisible(); await serverSaved(member.page);
  await expect(participants(owner.page)).toBeVisible(); await expect(participants(member.page)).toBeVisible();
  await expect(participant(owner.page, member.identity.accountId)).toContainText(member.name);
  await expect(participant(member.page, owner.identity.accountId)).toContainText(owner.name);
  const memberClientId = await participant(owner.page, member.identity.accountId).getAttribute('data-client-id');
  expect(memberClientId).toBeTruthy();
  const before = await durableState(pageId);

  await title(member.page).click(); await title(member.page).press('Home'); await title(member.page).press('Shift+End');
  const titleCaret = title(owner.page).locator(`.collaboration-caret[data-account-id="${member.identity.accountId}"]`);
  const bodyCaret = pageBody(owner.page).locator(`.collaboration-caret[data-account-id="${member.identity.accountId}"]`);
  await expect(titleCaret).toHaveCount(1); await expect(bodyCaret).toHaveCount(0);
  await expect(titleCaret.locator('.collaboration-caret-label')).toHaveText(member.name);
  await expect(title(owner.page).locator('.collaboration-selection')).not.toHaveCount(0);
  await pageBody(member.page).click();
  await pageBody(member.page).press('Home'); await pageBody(member.page).press('Shift+End');
  // Native selectionchange is delivered after the keyboard event. Require the
  // mounted editor to observe the range before checking its remote decoration.
  await expect.poll(() => pageBody(member.page).evaluate(element => {
    const selection = (element as HTMLElement & { editor: { state: { selection: { from: number; to: number } } } }).editor.state.selection;
    return selection.to - selection.from;
  })).toBeGreaterThan(0);
  await expect(bodyCaret).toHaveCount(1); await expect(titleCaret).toHaveCount(0);
  await expect(pageBody(owner.page).locator('.collaboration-selection')).not.toHaveCount(0);
  await expect(title(owner.page).locator('.collaboration-selection')).toHaveCount(0);
  await expect(bodyCaret.locator('.collaboration-caret-label')).toHaveText(member.name);
  await serverSaved(owner.page); await serverSaved(member.page);
  expect(await durableState(pageId)).toEqual(before);

  await owner.page.screenshot({ path: '.artifacts/presence-light-desktop.png', fullPage: true });
  await owner.page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(participant(owner.page, member.identity.accountId)).toBeVisible();
  await owner.page.emulateMedia({ colorScheme: 'dark' });
  await expect(owner.page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await owner.page.screenshot({ path: '.artifacts/presence-dark-mobile.png', fullPage: true });
  await owner.page.setViewportSize({ width: 1280, height: 800 });
  await owner.page.emulateMedia({ colorScheme: 'light' });
  await member.context.setOffline(true);
  await expect(participants(owner.page)).toHaveCount(0);
  await expect(caret(owner.page, member.identity.accountId)).toHaveCount(0);
  await expect(owner.page.locator('.collaboration-selection')).toHaveCount(0);
  await expect(participants(member.page)).toHaveCount(0);
  await member.context.setOffline(false);
  await expect(participants(owner.page)).toBeVisible();
  await expect(participant(owner.page, member.identity.accountId)).toHaveCount(1);
  await expect(participant(owner.page, member.identity.accountId)).toHaveAttribute('data-client-id', memberClientId!);
  await expect(participant(owner.page, member.identity.accountId)).toContainText(member.name);
  await serverSaved(member.page);
  expect(await durableState(pageId)).toEqual(before);

  await removeMember(owner.page, member.identity);
  await expect(participants(owner.page)).toHaveCount(0);
  await expect(caret(owner.page, member.identity.accountId)).toHaveCount(0);
  await expect(owner.page.locator('.collaboration-selection')).toHaveCount(0);
  await expect(member.page.getByRole('heading', { name: 'This note is no longer available' })).toBeVisible();
  await expect(pageBody(member.page)).toHaveCount(0);
  expect((await member.page.request.get(`/api/pages/${pageId}/session`)).status()).toBe(403);
  expect(await durableState(pageId)).toEqual(before);
});
