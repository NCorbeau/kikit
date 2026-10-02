import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import {
  AccountBrowserHarness, accountOrigin, appendBody, createNote, downloadRecovery,
  pageBody, recoveryBody, serverSaved, expectDocumentContains, expectDocumentExcludes, type BrowserAccount,
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

async function account(browser: Browser, email?: string) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  contexts.push(context);
  const identity = await harness.authenticate(context, email);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  return { context, page, identity };
}

const sharingDialog = (page: Page) => page.getByRole('dialog', { name: 'Share note', exact: true });
const invitePath = (token: string) => `/#/join/${token}`;

async function openSharing(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(sharingDialog(page)).toBeVisible();
}

async function createInvitation(page: Page): Promise<{ token: string; url: string }> {
  await openSharing(page);
  await sharingDialog(page).getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = sharingDialog(page).getByRole('textbox', { name: 'Invitation link', exact: true });
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:5198\/#\/join\/[A-Za-z0-9_-]{43}$/);
  const token = new URL(url).hash.split('/').at(-1)!;
  const image = sharingDialog(page).getByRole('img', { name: 'Invitation QR code' });
  await expect(image).toBeVisible();
  const pixels = await image.evaluate(async element => {
    const img = element as HTMLImageElement;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height,
      data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  });
  expect(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data).toBe(url);
  return { token, url };
}

async function closeSharing(page: Page): Promise<void> {
  await sharingDialog(page).getByRole('button', { name: 'Close sharing controls', exact: true }).click();
  await expect(sharingDialog(page)).toHaveCount(0);
}

async function joinThroughUi(page: Page, token: string): Promise<void> {
  await openInvitation(page, invitePath(token));
  await expect(page.getByRole('heading', { name: 'Join shared note' })).toBeVisible();
  await page.getByRole('button', { name: 'Join note', exact: true }).click();
  await expect(pageBody(page)).toBeVisible();
  await serverSaved(page);
}

async function openInvitation(page: Page, destination: string): Promise<void> {
  const leavingEditor = await pageBody(page).count() > 0;
  await page.goto(destination);
  if (leavingEditor) {
    const guard = page.getByRole('dialog');
    await expect(guard.getByRole('heading', { name: 'Open invitation?' })).toBeVisible();
    await guard.getByRole('button', { name: 'Open invitation', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Join shared note' })).toBeVisible();
}

async function removeThroughUi(owner: Page, member: BrowserAccount): Promise<void> {
  await openSharing(owner);
  await sharingDialog(owner).getByRole('button', { name: `Remove ${member.email}`, exact: true }).click();
  await expect(sharingDialog(owner).getByRole('heading', { name: 'Remove member?' })).toBeVisible();
  await sharingDialog(owner).getByRole('button', { name: 'Remove member', exact: true }).click();
  await expect(sharingDialog(owner).getByRole('heading', { name: 'Remove member?' })).toHaveCount(0);
  await expect(sharingDialog(owner).getByRole('button', { name: `Remove ${member.email}`, exact: true })).toHaveCount(0);
  await closeSharing(owner);
}

test('invitation QR/link, secret-free login continuation, explicit join, and two-account collaborative editing', async ({ browser }) => {
  const owner = await account(browser);
  const privateId = await createNote(owner.page, 'Owner private note', 'Visible only to its owner.');
  const pageId = await createNote(owner.page, 'Shared browser note', 'Shared starting point.');
  const { token, url } = await createInvitation(owner.page);
  await sharingDialog(owner.page).getByRole('button', { name: 'Copy link', exact: true }).click();
  expect(await owner.page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await closeSharing(owner.page);

  const memberContext = await browser.newContext(); contexts.push(memberContext);
  const memberPage = await memberContext.newPage();
  let joinRequests = 0;
  memberPage.on('request', request => { if (new URL(request.url()).pathname === '/api/invitations/join') joinRequests++; });
  const email = harness.email();
  const authRequest = memberPage.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/sign-in/magic-link');
  await harness.loginThroughUi(memberPage, email, invitePath(token));
  const authBody = (await authRequest).postDataJSON() as { callbackURL: string; errorCallbackURL: string };
  expect(authBody.callbackURL).toBe('/#/join');
  expect(authBody.errorCallbackURL).toBe('/#/join');
  expect(JSON.stringify(authBody)).not.toContain(token);
  expect(harness.mail.get(email)).not.toContain(token);
  await expect(memberPage.getByRole('heading', { name: 'Join shared note' })).toBeVisible();
  expect(joinRequests).toBe(0);
  const identity = (await (await memberPage.request.get('/api/session')).json()) as { accountId: string };
  expect(identity.accountId).not.toBe(owner.identity.accountId);
  expect((await memberPage.request.get(`/api/pages/${pageId}/session`)).status()).toBe(403);
  expect(await (await memberPage.request.get('/api/pages')).json()).toEqual([]);
  expect(await memberPage.evaluate(() => Object.values(localStorage).join(' '))).not.toContain(token);

  // A separate tab has no continuation secret even though its session cookie is valid.
  const otherTab = await memberContext.newPage();
  await otherTab.goto('/#/join');
  await expect(otherTab.getByRole('heading', { name: 'Open your invitation again' })).toBeVisible();
  await otherTab.close();
  await memberPage.getByRole('button', { name: 'Join note', exact: true }).click();
  await expectDocumentContains(pageBody(memberPage), 'Shared starting point.');
  await serverSaved(memberPage);
  expect(joinRequests).toBe(1);
  expect((await memberPage.request.get(`/api/pages/${privateId}/session`)).status()).toBe(403);
  await expect(memberPage.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);

  const duplicate = await memberPage.request.post('/api/invitations/join', { headers: { origin: accountOrigin }, data: { token } });
  expect(duplicate.status()).toBe(200);
  expect((await duplicate.json()).id).toBe(pageId);
  expect((await harness.pool.query('SELECT count(*)::int AS count FROM page_grants WHERE page_id=$1 AND account_id=$2', [pageId, identity.accountId])).rows[0].count).toBe(1);

  const device = await account(browser, email);
  expect(device.identity.accountId).toBe(identity.accountId);
  await device.page.getByRole('button', { name: 'Shared browser note' }).click();
  await expectDocumentContains(pageBody(device.page), 'Shared starting point.');
  await Promise.all([appendBody(owner.page, ' Owner contribution.'), appendBody(memberPage, ' Member contribution.')]);
  for (const page of [owner.page, memberPage, device.page]) {
    await expectDocumentContains(pageBody(page), 'Owner contribution.');
    await expectDocumentContains(pageBody(page), 'Member contribution.');
    await serverSaved(page);
  }
  await device.page.reload();
  await expectDocumentContains(pageBody(device.page), 'Member contribution.');
  await serverSaved(device.page);
});

test('owner replacement/disable invalidates join links while existing editor membership remains usable', async ({ browser }) => {
  const owner = await account(browser); const member = await account(browser);
  const pageId = await createNote(owner.page, 'Invitation lifecycle', 'Existing membership survives.');
  const original = await createInvitation(owner.page); await closeSharing(owner.page);
  await joinThroughUi(member.page, original.token);

  await openSharing(owner.page);
  await sharingDialog(owner.page).getByRole('button', { name: 'Replace invitation', exact: true }).click();
  await expect(sharingDialog(owner.page).getByRole('heading', { name: 'Replace invitation?' })).toBeVisible();
  await sharingDialog(owner.page).getByRole('button', { name: 'Replace invitation', exact: true }).click();
  const replacementLink = sharingDialog(owner.page).getByRole('textbox', { name: 'Invitation link' });
  await expect(replacementLink).toBeVisible();
  const replacement = await replacementLink.inputValue();
  expect(replacement).not.toBe(original.url);
  await expect(sharingDialog(owner.page).getByRole('img', { name: 'Invitation QR code' })).toBeVisible();
  await closeSharing(owner.page);
  await appendBody(member.page, ' Still authorized after replacement.');
  await serverSaved(member.page);
  await expectDocumentContains(pageBody(owner.page), 'Still authorized after replacement.');

  await openInvitation(member.page, invitePath(original.token));
  await member.page.getByRole('button', { name: 'Join note', exact: true }).click();
  await expect(member.page.getByRole('alert')).toContainText('invitation');
  await expect(pageBody(member.page)).toHaveCount(0);
  expect((await member.page.request.get(`/api/pages/${pageId}/session`)).status()).toBe(200);
  await openSharing(owner.page);
  await sharingDialog(owner.page).getByRole('button', { name: 'Disable invitation', exact: true }).click();
  await expect(sharingDialog(owner.page).getByRole('heading', { name: 'Disable invitation?' })).toBeVisible();
  await sharingDialog(owner.page).getByRole('button', { name: 'Disable invitation', exact: true }).click();
  await expect(sharingDialog(owner.page).getByRole('heading', { name: 'Disable invitation?' })).toHaveCount(0);
  await expect(sharingDialog(owner.page).getByRole('button', { name: 'Create invitation', exact: true })).toBeEnabled();
  await expect(sharingDialog(owner.page).getByRole('textbox', { name: 'Invitation link' })).toHaveCount(0);
  await expect(sharingDialog(owner.page).getByRole('img', { name: 'Invitation QR code' })).toHaveCount(0);
  await closeSharing(owner.page);
  await openInvitation(member.page, new URL(replacement).pathname + new URL(replacement).hash);
  await member.page.getByRole('button', { name: 'Join note', exact: true }).click();
  await expect(member.page.getByRole('alert')).toContainText('invitation');
  await member.page.goto(`/#/page/${pageId}`);
  await expectDocumentContains(pageBody(member.page), 'Still authorized after replacement.');
  await appendBody(member.page, ' Still authorized after disable.');
  await serverSaved(member.page);
  await expectDocumentContains(pageBody(owner.page), 'Still authorized after disable.');
});

test('active and offline member removal preserves recovery and stable pending identities through valid rejoin', async ({ browser }) => {
  const owner = await account(browser); const member = await account(browser);
  const pageId = await createNote(owner.page, 'Removal recovery', 'Committed shared content.');
  const { token } = await createInvitation(owner.page); await closeSharing(owner.page);
  await joinThroughUi(member.page, token);
  const device = await account(browser, member.identity.email);
  await device.page.getByRole('button', { name: 'Removal recovery' }).click();
  await expect(pageBody(device.page)).toBeVisible(); await serverSaved(device.page);
  await expect.poll(() => device.page.evaluate(() => document.documentElement.dataset.offlineReady)).toBe('true');
  await device.context.setOffline(true);
  await appendBody(device.page, ' Offline draft retained after removal.');
  await expect(device.page.getByTestId('save-status')).toHaveText('Saved on this device');
  await device.page.getByRole('button', { name: 'Notes', exact: true }).click();
  const leave = device.page.getByRole('dialog', { name: 'Return to your notes?', exact: true });
  await expect(leave).toBeVisible();
  await device.page.keyboard.press('Escape');
  await expect(leave).toHaveCount(0);
  await expect(pageBody(device.page)).toHaveAttribute('contenteditable', 'true');
  await appendBody(device.page, ' Still editable after cancelling navigation.');
  await expect(device.page.getByTestId('save-status')).toHaveText('Saved on this device');
  await device.page.reload();
  await expectDocumentContains(pageBody(device.page), 'Offline draft retained after removal.');
  await expectDocumentContains(pageBody(device.page), 'Still editable after cancelling navigation.');
  await expect(device.page.getByTestId('save-status')).toHaveText('Saved on this device');
  const receiptsBefore = (await harness.pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId])).rows[0].count as number;
  await removeThroughUi(owner.page, member.identity);
  await expect(member.page.getByRole('heading', { name: 'This note is no longer available' })).toBeVisible();
  await expect(pageBody(member.page)).toHaveCount(0);
  expect((await member.page.request.get(`/api/pages/${pageId}/session`)).status()).toBe(403);
  await device.context.setOffline(false);
  await expect(device.page.getByRole('heading', { name: 'This note is no longer available' })).toBeVisible();
  await expect(pageBody(device.page)).toHaveCount(0);
  const recovery = await downloadRecovery(device.page);
  expect(recovery.accountId).toBe(member.identity.accountId);
  expect(recovery.pageId).toBe(pageId);
  expect(recoveryBody(recovery)).toContain('Offline draft retained after removal.');
  expect(recoveryBody(recovery)).toContain('Still editable after cancelling navigation.');
  expect(recovery.pending.length).toBeGreaterThan(0);
  expect((await harness.pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId])).rows[0].count).toBe(receiptsBefore);
  await expectDocumentExcludes(pageBody(owner.page), 'Offline draft retained after removal.');
  await expectDocumentExcludes(pageBody(owner.page), 'Still editable after cancelling navigation.');
  await device.page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(device.page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  await expect(device.page.getByRole('button', { name: 'Removal recovery' })).toHaveCount(0);
  await joinThroughUi(device.page, token);
  await expectDocumentContains(pageBody(device.page), 'Offline draft retained after removal.');
  await expectDocumentContains(pageBody(owner.page), 'Offline draft retained after removal.');
  await expectDocumentContains(pageBody(owner.page), 'Still editable after cancelling navigation.');
  await serverSaved(device.page);
  for (const pending of recovery.pending) {
    const receipt = await harness.pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1 AND batch_id=$2', [pageId, pending.batchId]);
    expect(receipt.rows[0].count).toBe(1);
  }
  const receiptsAfter = (await harness.pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId])).rows[0].count;
  await device.page.reload(); await serverSaved(device.page);
  expect((await harness.pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId])).rows[0].count).toBe(receiptsAfter);
});

test('member removal hides an editor with failed device writes and requires decoded in-memory recovery before leaving', async ({ browser }) => {
  const owner = await account(browser); const member = await account(browser);
  const pageId = await createNote(owner.page, 'Memory recovery', 'Stored baseline.');
  const { token } = await createInvitation(owner.page); await closeSharing(owner.page);
  await joinThroughUi(member.page, token);
  await member.page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase['transaction']>) {
      if (args[1] === 'readwrite') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return transaction.apply(this, args);
    };
  });
  await appendBody(member.page, ' Unsaved in-memory shared draft.');
  await expect(member.page.getByTestId('save-status')).toHaveText('Device save failed');
  await member.page.goto(invitePath(token));
  const guard = member.page.getByRole('dialog');
  await expect(guard.getByRole('heading', { name: 'Open invitation?' })).toBeVisible();
  await expect(guard.getByRole('button', { name: 'Open invitation', exact: true })).toBeDisabled();
  await member.page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expectDocumentContains(pageBody(member.page), 'Unsaved in-memory shared draft.');
  await removeThroughUi(owner.page, member.identity);
  // Failed local persistence keeps the paused transport closed; returning focus revalidates membership.
  await member.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(member.page.getByRole('heading', { name: 'This note is no longer available' })).toBeVisible();
  await expect(pageBody(member.page)).toHaveCount(0);
  await expect(member.page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  const recovery = await downloadRecovery(member.page);
  expect(recoveryBody(recovery)).toContain('Unsaved in-memory shared draft.');
  expect(recovery.pending.length).toBeGreaterThan(0);
  for (const pending of recovery.pending) {
    expect((await harness.pool.query('SELECT 1 FROM receipts WHERE page_id=$1 AND batch_id=$2', [pageId, pending.batchId])).rowCount).toBe(0);
  }
  await expectDocumentExcludes(pageBody(owner.page), 'Unsaved in-memory shared draft.');
  await member.page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(member.page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
});

test('a cookie/account switch during explicit join creates no membership for the newly signed-in account', async ({ browser }) => {
  const owner = await account(browser); const member = await account(browser); const replacement = await account(browser);
  const pageId = await createNote(owner.page, 'Join account boundary', 'Private until an explicit authorized join.');
  const { token } = await createInvitation(owner.page); await closeSharing(owner.page);
  await member.page.goto(invitePath(token));
  await expect(member.page.getByRole('heading', { name: 'Join shared note' })).toBeVisible();
  await member.page.route('**/api/invitations/join', async route => {
    const headers = route.request().headers();
    expect(headers['x-kikit-account']).toBe(member.identity.accountId);
    // The rendered account is old, while the actual Better Auth cookie has changed.
    await member.context.clearCookies();
    await member.context.addCookies(await replacement.context.cookies());
    const result = await harness.server.inject({ method: 'POST', url: '/api/invitations/join',
      headers: { origin: accountOrigin, cookie: replacement.identity.cookie, 'x-kikit-account': headers['x-kikit-account']! },
      payload: route.request().postDataJSON() });
    expect(result.statusCode).toBe(401);
    await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
  });
  const rejected = member.page.waitForResponse(response => new URL(response.url()).pathname === '/api/invitations/join');
  await member.page.getByRole('button', { name: 'Join note', exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(pageBody(member.page)).toHaveCount(0);
  expect((await harness.pool.query('SELECT 1 FROM page_grants WHERE page_id=$1 AND account_id=ANY($2::text[])', [pageId, [member.identity.accountId, replacement.identity.accountId]])).rowCount).toBe(0);
  expect((await (await member.page.request.get('/api/session')).json()).accountId).toBe(replacement.identity.accountId);
  await expect(member.page.getByRole('heading', { name: 'Join shared note' })).toBeVisible();
  await expect(member.page.getByRole('button', { name: 'Join note', exact: true })).toBeEnabled();
  await expect(member.page.getByText(replacement.identity.email, { exact: true })).toBeVisible();
});
