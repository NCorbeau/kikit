import { test, expect, type Page } from '@playwright/test';
import { AccountBrowserHarness, accountOrigin, appendBody, createNote, downloadRecovery, pageBody, serverSaved, recoveryBody } from './account-support';
import { clickHeaderAction } from './header-actions';
import { decodeUpdate } from '@kikit/contracts';
import * as Y from 'yjs';

const harness = new AccountBrowserHarness();
test.beforeAll(async () => { await harness.prepare(); });
test.beforeEach(async () => { await harness.start(); });
test.afterEach(async () => { await harness.stop(); });
test.afterAll(async () => { await harness.dispose(); });

async function choose(page: Page, text: string) {
  await clickHeaderAction(page, 'Import recovery file');
  const dialog = page.getByRole('dialog', { name: 'Import recovery file', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Recovery file', { exact: true }).setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  return dialog;
}

for (const device of ['fresh', 'cached'] as const) {
  test(`restores acknowledged parent history before exact pending batches on a ${device} device`, async ({ browser }) => {
    const source = await browser.newContext(), target = await browser.newContext();
    try {
      const account = await harness.authenticate(source);
      await harness.authenticate(target, account.email);
      const a = await source.newPage();
      const id = await createNote(a, 'Restored older backup', 'Backup baseline.');
      const baseline = await source.request.get(`${accountOrigin}/api/pages/${id}/recovery-state`, {
        headers: { 'X-Kikit-Account': account.accountId },
      });
      expect(baseline.status()).toBe(200);
      const committed = decodeUpdate((await baseline.json()).update);
      const sequence = Number((await harness.pool.query('SELECT sequence FROM pages WHERE id=$1', [id])).rows[0].sequence);
      await appendBody(a, ' Acknowledged parent lost by restore.'); await serverSaved(a);
      await source.setOffline(true);
      await appendBody(a, ' Dependent offline child.');
      await expect(a.getByTestId('save-status')).toHaveText('Saved on this device');
      const recovery = await downloadRecovery(a, 'Download recovery file');
      expect(recovery.pending.length).toBeGreaterThan(0);
      const file = JSON.stringify(recovery);

      // Restore this synthetic test note to an older consistent boundary. Stop
      // the application first so neither its live room nor a writer survives.
      await harness.stop();
      const connection = await harness.pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [id]);
        await connection.query('DELETE FROM receipts WHERE page_id=$1 AND sequence>$2', [id, sequence]);
        await connection.query('DELETE FROM document_updates WHERE page_id=$1 AND sequence>$2', [id, sequence]);
        await connection.query('UPDATE pages SET snapshot_state=$2, snapshot_sequence=$3, sequence=$3 WHERE id=$1', [id, Buffer.from(committed), sequence]);
        await connection.query('COMMIT');
      } finally { await connection.query('ROLLBACK'); connection.release(); }
      await harness.start();

      const importer = device === 'cached' ? a : await target.newPage();
      if (device === 'cached') {
        await source.setOffline(false);
        await a.reload();
        await expect(pageBody(a)).toContainText('Acknowledged parent lost by restore.');
      } else {
        await importer.goto(`/#/page/${id}`); await serverSaved(importer);
        await expect(pageBody(importer)).not.toContainText('Acknowledged parent lost by restore.');
      }
      const dialog = await choose(importer, file);
      await dialog.getByRole('button', { name: 'Merge into this note', exact: true }).click();
      await expect(dialog).toBeHidden(); await serverSaved(importer);
      await expect(pageBody(importer)).toContainText('Acknowledged parent lost by restore.');
      await expect(pageBody(importer)).toContainText('Dependent offline child.');
      const receipts = (await harness.pool.query('SELECT batch_id, sequence FROM receipts WHERE page_id=$1 AND sequence>$2 ORDER BY sequence', [id, sequence])).rows;
      expect(receipts).toHaveLength(recovery.pending.length + 1);
      expect(recovery.pending.map(record => record.batchId)).not.toContain(receipts[0].batch_id);
      for (const pending of recovery.pending) expect(receipts.filter(row => row.batch_id === pending.batchId)).toHaveLength(1);
      const stored = await target.request.get(`${accountOrigin}/api/pages/${id}/recovery-state`, { headers: { 'X-Kikit-Account': account.accountId } });
      expect(stored.status()).toBe(200);
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, decodeUpdate((await stored.json()).update));
        expect(doc.store.pendingStructs).toBeNull(); expect(doc.store.pendingDs).toBeNull();
        expect(doc.getXmlFragment('body').toString()).toContain('Dependent offline child.');
      } finally { doc.destroy(); }
      await importer.reload(); await serverSaved(importer);
      await expect(pageBody(importer)).toContainText('Dependent offline child.');
      await source.setOffline(false); await serverSaved(a);
      expect((await harness.pool.query('SELECT count(*)::int AS total FROM receipts WHERE page_id=$1 AND sequence>$2', [id, sequence])).rows[0].total).toBe(receipts.length);
      expect(JSON.stringify(recovery)).toBe(file);
    } finally { await source.close(); await target.close(); }
  });
}

test('keeps already committed recovery in a stale cache after an offline reload', async ({ browser }) => {
  const source = await browser.newContext(), target = await browser.newContext();
  try {
    const account = await harness.authenticate(source);
    await harness.authenticate(target, account.email);
    const a = await source.newPage(), b = await target.newPage();
    const id = await createNote(a, 'Committed recovery', 'Cached baseline.');
    await b.goto(`/#/page/${id}`); await serverSaved(b);
    await target.setOffline(true);
    await appendBody(a, ' Already committed recovery.'); await serverSaved(a);
    const recovery = await downloadRecovery(a, 'Download recovery file');
    expect(recovery.pending).toHaveLength(0);
    const file = JSON.stringify(recovery);
    const before = (await harness.pool.query('SELECT sequence FROM pages WHERE id=$1', [id])).rows[0].sequence;

    // Allow the real HTTP state read, but prevent a reconnect from healing the
    // stale journal before import or hiding a missing local cache record.
    await target.routeWebSocket('**/api/sync', route => route.close());
    await target.setOffline(false);
    await expect(pageBody(b)).not.toContainText('Already committed recovery.');
    const dialog = await choose(b, file);
    await dialog.getByRole('button', { name: 'Merge into this note', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(pageBody(b)).toContainText('Already committed recovery.');
    await expect(b.getByTestId('save-status')).toHaveText('Saved on this device');
    await target.setOffline(true); await b.reload();
    await expect(pageBody(b)).toContainText('Already committed recovery.');
    expect((await harness.pool.query('SELECT sequence FROM pages WHERE id=$1', [id])).rows[0].sequence).toBe(before);
    expect(JSON.stringify(recovery)).toBe(file);
  } finally { await source.close(); await target.close(); }
});

test('merges an offline recovery into its authorized original with stable receipts, concurrent edits and repeat import', async ({ browser }) => {
  const source = await browser.newContext(), target = await browser.newContext();
  try {
    const account = await harness.authenticate(source);
    await harness.authenticate(target, account.email);
    const a = await source.newPage(), b = await target.newPage();
    const id = await createNote(a, 'Original recovery note', 'Saved base.');
    await b.goto(`/#/page/${id}`); await serverSaved(b);
    await source.setOffline(true);
    await appendBody(a, ' Offline recovered draft.');
    await expect(a.getByTestId('save-status')).toHaveText('Saved on this device');
    const recovery = await downloadRecovery(a, 'Download recovery file');
    const file = JSON.stringify(recovery);
    expect(recovery.pending.length).toBeGreaterThan(0);
    await appendBody(b, ' Concurrent online edit.'); await serverSaved(b);
    const dialog = await choose(b, file);
    await dialog.getByRole('button', { name: 'Merge into this note', exact: true }).click();
    await expect(dialog).toBeHidden(); await serverSaved(b);
    await expect(pageBody(b)).toContainText('Offline recovered draft.');
    await expect(pageBody(b)).toContainText('Concurrent online edit.');
    for (const pending of recovery.pending) {
      const receipt = await harness.pool.query('SELECT count(*)::int AS total FROM receipts WHERE page_id=$1 AND batch_id=$2', [id, pending.batchId]);
      expect(receipt.rows[0].total).toBe(1);
    }
    const before = (await harness.pool.query('SELECT count(*)::int AS total FROM receipts WHERE page_id=$1', [id])).rows[0].total;
    const again = await choose(b, file);
    await again.getByRole('button', { name: 'Merge into this note', exact: true }).click();
    await expect(again).toBeHidden(); await serverSaved(b);
    expect((await harness.pool.query('SELECT count(*)::int AS total FROM receipts WHERE page_id=$1', [id])).rows[0].total).toBe(before);
    await source.setOffline(false); await serverSaved(a);
    await expect(pageBody(a)).toContainText('Concurrent online edit.');
    expect((await harness.pool.query('SELECT count(*)::int AS total FROM receipts WHERE page_id=$1', [id])).rows[0].total).toBe(before);
    expect(JSON.stringify(recovery)).toBe(file);
    await b.reload(); await serverSaved(b); await expect(pageBody(b)).toContainText('Offline recovered draft.');
  } finally { await source.close(); await target.close(); }
});

test('recovers a deleted source privately, rejects wrong accounts and corrupt files, and retries a lost copy response once', async ({ browser }) => {
  const owner = await browser.newContext(), other = await browser.newContext();
  try {
    const account = await harness.authenticate(owner); const foreign = await harness.authenticate(other);
    const page = await owner.newPage(), outsider = await other.newPage();
    const source = await createNote(page, 'Deleted source copy', 'Keep this binary draft.');
    const recovery = await downloadRecovery(page, 'Download recovery file'); const file = JSON.stringify(recovery);
    await clickHeaderAction(page, 'Delete note');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete note', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await outsider.goto('/');
    const rejected = await choose(outsider, file);
    await expect(rejected.getByRole('alert')).toContainText('account that exported');
    await expect(rejected.getByRole('button', { name: 'Recover new private copy' })).toBeDisabled();
    await rejected.getByRole('button', { name: 'Cancel' }).click();
    let lost = false, copyId = '';
    await page.route('**/api/recovery/copies', async route => {
      const result = await route.fetch();
      copyId = (await result.json()).id;
      if (!lost) { lost = true; await route.abort('failed'); }
      else await route.fulfill({ response: result });
    });
    const dialog = await choose(page, file);
    await dialog.getByRole('button', { name: 'Recover new private copy' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Recover new private copy' }).click();
    await expect(dialog).toBeHidden(); await serverSaved(page);
    await expect(pageBody(page)).toContainText('Keep this binary draft.');
    expect(copyId).not.toBe(source);
    expect((await harness.pool.query('SELECT count(*)::int AS total FROM pages WHERE owner_id=$1 AND deleted_at IS NULL', [account.accountId])).rows[0].total).toBe(1);
    expect((await harness.pool.query('SELECT role FROM page_grants WHERE page_id=$1', [copyId])).rows).toEqual([{ role: 'owner' }]);
    expect((await other.request.get(`${accountOrigin}/api/pages/${copyId}/session`)).status()).toBe(403);
    const corrupt = await choose(page, '{broken');
    await expect(corrupt.getByRole('alert')).toContainText('valid Kikit recovery');
    await corrupt.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Note menu', exact: true })).toBeFocused();
    expect(recoveryBody(recovery)).toContain('Keep this binary draft.'); expect(JSON.stringify(recovery)).toBe(file);
    expect(foreign.accountId).not.toBe(account.accountId);
  } finally { await owner.close(); await other.close(); }
});

test('a delayed copy response cannot restore the previous account after account replacement', async ({ browser }) => {
  const context = await browser.newContext(), foreignContext = await browser.newContext();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committed!: () => void;
  const created = new Promise<void>(resolve => { committed = resolve; });
  try {
    const original = await harness.authenticate(context), foreign = await harness.authenticate(foreignContext);
    const page = await context.newPage();
    await createNote(page, 'Old account recovery', 'Old account content.');
    const file = JSON.stringify(await downloadRecovery(page, 'Download recovery file'));
    await page.getByRole('button', { name: 'All notes', exact: true }).click();
    await page.route('**/api/recovery/copies', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed(); await gate;
      await route.fulfill({ response });
    });
    const dialog = await choose(page, file);
    await dialog.getByRole('button', { name: 'Recover new private copy' }).click();
    await created;
    await harness.authenticate(context, foreign.email);
    await page.evaluate(() => window.dispatchEvent(new Event('kikit-session-ended')));
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kikit-workspace-v1')!).account.accountId)).toBe(foreign.accountId);
    release();
    const newDialog = page.getByRole('dialog', { name: 'Import recovery file', exact: true });
    await expect(newDialog.getByLabel('Recovery file', { exact: true })).toHaveValue('');
    await newDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await expect(page.getByText(foreign.email, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Old account recovery', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kikit-workspace-v1')!).account.accountId)).toBe(foreign.accountId);
    expect((await harness.pool.query('SELECT count(*)::int AS total FROM pages WHERE owner_id=$1 AND deleted_at IS NULL', [original.accountId])).rows[0].total).toBe(2);
  } finally { release?.(); await context.close(); await foreignContext.close(); }
});

test('a delayed original-state response cannot import into a retained old-account draft', async ({ browser }) => {
  const source = await browser.newContext(), target = await browser.newContext(), other = await browser.newContext();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let read!: () => void;
  const stateRead = new Promise<void>(resolve => { read = resolve; });
  try {
    const account = await harness.authenticate(source), foreign = await harness.authenticate(other);
    await harness.authenticate(target, account.email);
    const a = await source.newPage(), b = await target.newPage();
    const id = await createNote(a, 'Old-account merge target', 'Existing saved draft.');
    await b.goto(`/#/page/${id}`); await serverSaved(b);
    await source.setOffline(true); await appendBody(a, ' Imported file only.');
    await expect(a.getByTestId('save-status')).toHaveText('Saved on this device');
    const recovery = await downloadRecovery(a, 'Download recovery file');
    await b.route(`**/api/pages/${id}/recovery-state`, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      read(); await gate; await route.fulfill({ response });
    });
    const dialog = await choose(b, JSON.stringify(recovery));
    await dialog.getByRole('button', { name: 'Merge into this note', exact: true }).click();
    await stateRead;
    await harness.authenticate(target, foreign.email);
    await b.evaluate(() => window.dispatchEvent(new Event('kikit-session-ended')));
    await expect(b.getByRole('heading', { name: /^(Your session has ended|This note is no longer available)$/ })).toBeVisible();
    await expect(dialog).toBeHidden();
    release(); await b.waitForLoadState('networkidle');
    // The departure guard intentionally retains the original session here.
    // Its account-scoped journal must remain untouched by the stale GET.
    const records = await b.evaluate(async ({ accountId, pageId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(`kikit:${JSON.stringify([accountId, pageId])}`);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const rows = await new Promise<{ id: string; update: Uint8Array }[]>((resolve, reject) => {
          const request = database.transaction('updates', 'readonly').objectStore('updates').getAll();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        return rows.map(row => ({ id: row.id, update: [...row.update] }));
      } finally { database.close(); }
    }, { accountId: account.accountId, pageId: id });
    for (const pending of recovery.pending) expect(records.map(record => record.id)).not.toContain(pending.batchId);
    const doc = new Y.Doc({ gc: false });
    try {
      for (const record of records) Y.applyUpdate(doc, Uint8Array.from(record.update));
      expect(doc.getXmlFragment('body').toString()).toContain('Existing saved draft.');
      expect(doc.getXmlFragment('body').toString()).not.toContain('Imported file only.');
    } finally { doc.destroy(); }
    await b.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(b.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await expect(b.getByText(foreign.email, { exact: true })).toBeVisible();
  } finally { release?.(); await source.close(); await target.close(); await other.close(); }
});
