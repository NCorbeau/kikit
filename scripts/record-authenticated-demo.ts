import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import * as Y from 'yjs';
import { DATABASE_SCHEMA_VERSION, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION } from '@kikit/contracts';
import { createServer } from '../apps/server/src/app';
import { migrateDatabase } from '../apps/server/src/migrations';
import { authenticateBrowser } from '../tests/support/browser-auth';

// Set FFMPEG_BIN to an installed executable when ffmpeg is not on PATH.
const ffmpeg = process.env.FFMPEG_BIN ?? 'ffmpeg';
const adminUrl = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/postgres';
const viewport = { width: 720, height: 610 };
let phase = 'setup';
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const body = (page: Page) => page.getByRole('textbox', { name: 'Page body', exact: true });
const title = (page: Page) => page.getByRole('textbox', { name: 'Page title', exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved to server');
// Match the existing capture's deterministic caret setup after focus changes.
// Actual text entry still uses browser keyboard events and the normal journal.
const focusBodyEnd = (page: Page) => body(page).evaluate(element =>
  (element as HTMLElement & { editor: { commands: { focus(position: 'end'): boolean } } }).editor.commands.focus('end'));

async function availablePort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function treeDigest(directories: string[]): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) { hash.update(filename); hash.update(await readFile(filename)); }
    }
  }
  for (const directory of directories) await visit(directory);
  return hash.digest('hex');
}

async function record() {
  // Check the encoder before creating local resources. No download/install occurs.
  execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  const runId = randomUUID().replaceAll('-', '');
  const directory = `.artifacts/authenticated-demo/${runId}`;
  await mkdir(`${directory}/frames`, { recursive: true });
  const databaseName = `kikit_demo_${runId}`;
  const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl.href });
  const mail = new Map<string, string>();
  const initialAssets = await treeDigest(['apps/web/dist']);
  const sourceDirectories = ['apps/server/src', 'apps/web/src', 'packages/contracts/src'];
  const initialSource = await treeDigest(sourceDirectories);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let created = false;
  let recording = false;
  let capture: Promise<void> | undefined;
  let started = 0;
  const frames: { index: string; at: number }[] = [];
  const steps: { label: string; at: number }[] = [];
  const step = (label: string) => { phase = label; steps.push({ label, at: performance.now() - started }); };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    process.env.NODE_ENV = 'test'; process.env.KIKIT_DEV_FIXTURE = '0'; process.env.KIKIT_TEST_FAULTS = '0';
    process.env.BETTER_AUTH_SECRET = 'synthetic-authenticated-demo-secret-never-used-in-production';
    await migrateDatabase(pool);
    server = await createServer({ databaseUrl: databaseUrl.href, origin, serveWeb: true,
      sendMagicLink: async ({ email, url }) => { mail.set(email, url); } });
    await server.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) });
    browser = await chromium.launch();
    async function account(name: string, peer: number, colorScheme: 'light' | 'dark') {
      const context: BrowserContext = await browser!.newContext({ viewport, colorScheme });
      context.setDefaultTimeout(10_000);
      // Recording opts into the application's existing optional save diagnostics.
      await context.addInitScript(() => { localStorage.setItem('kikit-sync-details', 'true'); });
      const email = `${name.toLowerCase()}@example.test`;
      const remoteAddress = `127.0.1.${peer}`;
      const identity = await authenticateBrowser({ server: server!, context, origin, email, remoteAddress,
        getMagicLink: address => mail.get(address) });
      await pool.query('UPDATE auth_user SET name=$2 WHERE email=$1', [email, name]);
      const page = await context.newPage(); await page.goto(origin);
      await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
      return { context, page, accountId: identity.accountId, cookie: identity.cookie };
    }
    phase = 'synthetic authentication and private note setup';
    const alex = await account('Alex', 111, 'light');
    const sam = await account('Sam', 112, 'dark');
    assert.notEqual(alex.accountId, sam.accountId);
    await alex.page.getByRole('button', { name: 'New note', exact: true }).click();
    await expect(body(alex.page)).toBeVisible();
    await title(alex.page).fill('Weekend plans');
    await body(alex.page).fill('A few ideas for Saturday.');
    await saved(alex.page);
    const pageId = new URL(alex.page.url()).hash.split('/').at(-1)!;
    const denied = await server.inject({ url: `/api/pages/${pageId}/session`, headers: { cookie: sam.cookie } });
    assert.equal(denied.statusCode, 403, 'A second account must be denied before explicit join');
    const invitation: { statusCode: number; json(): { token: string } } = await server.inject({ method: 'POST',
      url: `/api/pages/${pageId}/invitation`, headers: { cookie: alex.cookie, origin, 'x-kikit-account': alex.accountId } });
    assert.equal(invitation.statusCode, 200);
    // No invitation link/QR dialog is visible during capture; fragments are outside viewport screenshots.
    await sam.page.goto(`${origin}/#/join/${invitation.json().token}`);
    await expect(sam.page.getByRole('heading', { name: 'Join shared note' })).toBeVisible();
    phase = 'recording authenticated join and editing';
    started = performance.now(); recording = true;
    step('Explicit authenticated join');
    capture = (async () => {
      while (recording) {
        const at = performance.now() - started;
        const index = String(frames.length).padStart(5, '0');
        // The join view contains a synthetic email; exclude even sample addresses
        // from released media without changing application code or authentication.
        const [left, right] = await Promise.all([alex.page.screenshot(), sam.page.screenshot({
          mask: [sam.page.locator('.account-panel strong')], maskColor: '#242424',
        })]);
        await Promise.all([writeFile(`${directory}/frames/${index}-left.png`, left), writeFile(`${directory}/frames/${index}-right.png`, right)]);
        frames.push({ index, at });
        await wait(Math.max(0, 100 - (performance.now() - started - at)));
      }
    })();
    await wait(1200);
    await sam.page.getByRole('button', { name: 'Join note', exact: true }).click();
    await expect(body(sam.page)).toBeVisible(); await saved(sam.page);
    await expect(alex.page.getByRole('list', { name: 'Participants', exact: true })).toBeVisible();
    await expect(sam.page.getByRole('list', { name: 'Participants', exact: true })).toBeVisible();
    await wait(1000);
    step('Concurrent edits from distinct accounts');
    await focusBodyEnd(alex.page);
    await title(sam.page).click(); await sam.page.keyboard.press('End');
    await Promise.all([alex.page.keyboard.type(' Outdoors.', { delay: 100 }), sam.page.keyboard.type(' together', { delay: 110 })]);
    await expect(title(alex.page)).toContainText('Weekend plans together');
    await expect(body(sam.page)).toContainText('Outdoors.');
    step('Shared checklist and participant cursors');
    await focusBodyEnd(alex.page);
    await alex.page.keyboard.press('Enter');
    await alex.page.keyboard.type('## ', { delay: 100 });
    await alex.page.keyboard.type('Saturday', { delay: 100 });
    await alex.page.keyboard.press('Enter');
    await alex.page.keyboard.type('[ ] ', { delay: 100 });
    await alex.page.keyboard.type('Pack a picnic', { delay: 100 });
    await alex.page.keyboard.press('Enter');
    await alex.page.keyboard.type('Pick a walking route', { delay: 90 });
    await expect(body(sam.page)).toContainText('Pick a walking route');
    await sam.page.getByRole('checkbox').first().check();
    await expect(alex.page.getByRole('checkbox').first()).toBeChecked();
    await focusBodyEnd(sam.page);
    await expect(body(alex.page).locator(`.collaboration-caret[data-account-id="${sam.accountId}"]`)).toHaveCount(1);
    await sam.page.keyboard.press('Enter');
    await sam.page.keyboard.type('Bring a camera', { delay: 100 });
    await expect(body(alex.page)).toContainText('Bring a camera');
    await wait(900);
    step('Offline edits remain local');
    await sam.context.setOffline(true);
    await expect(sam.page.locator('.offline-notice')).toBeVisible();
    await focusBodyEnd(sam.page);
    await sam.page.keyboard.press('Enter');
    await sam.page.keyboard.type('Meet at 10 am', { delay: 100 });
    await expect(body(alex.page)).not.toContainText('Meet at 10 am');
    await wait(1300);
    step('Reconnect and durable saves');
    await sam.context.setOffline(false);
    await expect(body(alex.page)).toContainText('Meet at 10 am');
    await expect(sam.page.locator('.offline-notice')).toHaveCount(0);
    await saved(alex.page); await saved(sam.page);
    await wait(1800);
    const capturedMs = performance.now() - started;
    recording = false; await capture;
    phase = 'durable content and membership verification';
    // Compare the editor's document projection, excluding awareness decorations.
    const projection = (page: Page) => body(page).evaluate(element =>
      (element as HTMLElement & { editor: { state: { doc: { textContent: string } } } }).editor.state.doc.textContent);
    const [leftText, rightText] = await Promise.all([projection(alex.page), projection(sam.page)]);
    phase = 'exact browser content comparison';
    assert.equal(leftText, rightText);
    assert.equal(leftText, 'A few ideas for Saturday. Outdoors.SaturdayPack a picnicPick a walking routeBring a cameraMeet at 10 am');
    phase = 'final checklist state';
    await expect(alex.page.getByRole('checkbox')).toHaveCount(4);
    await expect(sam.page.getByRole('checkbox').first()).toBeChecked();
    const { rows: [row] } = await pool.query('SELECT sequence,initial_state,snapshot_state,snapshot_sequence FROM pages WHERE id=$1', [pageId]);
    const { rows: updates } = await pool.query('SELECT sequence,payload FROM document_updates WHERE page_id=$1 ORDER BY sequence', [pageId]);
    const { rows: [{ count: receipts }] } = await pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1', [pageId]);
    const { rows: grants } = await pool.query('SELECT account_id,role FROM page_grants WHERE page_id=$1', [pageId]);
    phase = 'owner/editor grants and receipts';
    assert.equal(grants.length, 2);
    assert.equal(grants.find(grant => grant.account_id === alex.accountId)?.role, 'owner');
    assert.equal(grants.find(grant => grant.account_id === sam.accountId)?.role, 'editor');
    assert.equal(Number(receipts), Number(row.sequence));
    const doc = new Y.Doc();
    phase = 'exact PostgreSQL binary reconstruction';
    try {
      Y.applyUpdate(doc, row.snapshot_state ?? row.initial_state);
      for (const update of updates) if (Number(update.sequence) > Number(row.snapshot_sequence)) Y.applyUpdate(doc, update.payload);
      assert.equal(doc.store.pendingStructs, null); assert.equal(doc.store.pendingDs, null);
      const plain = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): string => node instanceof Y.XmlText
        ? node.toString() : node.toArray().map(child => plain(child as Y.XmlElement | Y.XmlText)).join('');
      assert.equal(plain(doc.getXmlFragment('body')), leftText);
      assert.equal(plain(doc.getXmlFragment('title')), 'Weekend plans together');
      const tasks = doc.getXmlFragment('body').toArray().filter(node => node instanceof Y.XmlElement && node.nodeName === 'taskList') as Y.XmlElement[];
      assert.equal(tasks.flatMap(list => list.toArray()).length, 4);
      assert.equal((tasks[0]!.get(0) as Y.XmlElement).getAttribute('checked'), true);
    } finally { doc.destroy(); }
    phase = 'source and production asset integrity';
    assert.equal(await treeDigest(['apps/web/dist']), initialAssets, 'Assets changed during capture; rerun against one build');
    assert.equal(await treeDigest(sourceDirectories), initialSource, 'Source changed during capture; rerun against one checkpoint');
    const checks = ['distinct Better Auth accounts and independent browser storage', 'private-page denial before explicit authenticated join',
      'owner/editor membership', 'concurrent title/body edits converge', 'shared checked state and visible participant cursor',
      'offline edit absent on peer until reconnect', 'both sessions Saved to server', 'matching final body text',
      'PostgreSQL binary reconstruction contains title, checklist and offline edit', 'receipt count matches committed sequence'];
    await writeFile(`${directory}/capture.json`, JSON.stringify({ capturedAt: new Date().toISOString(), capturedMs, frames, steps,
      versions: { chromium: browser.version(), document: DOCUMENT_SCHEMA_VERSION, database: DATABASE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION },
      sourceDigest: initialSource, assetsDigest: initialAssets, sequence: Number(row.sequence), snapshotSequence: Number(row.snapshot_sequence),
      retainedUpdates: updates.length, receipts, checks }, null, 2) + '\n');
    phase = 'normal-speed video encoding';
    for (const side of ['left', 'right']) {
      const lines = ['ffconcat version 1.0'];
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        const end = frames[index + 1]?.at ?? capturedMs;
        lines.push(`file 'frames/${frame.index}-${side}.png'`, `duration ${Math.max(0.001, end - frame.at) / 1000}`);
      }
      lines.push(`file 'frames/${frames.at(-1)!.index}-${side}.png'`);
      await writeFile(`${directory}/${side}.ffconcat`, lines.join('\n') + '\n');
    }
    const font = process.env.KIKIT_DEMO_FONT ?? '/System/Library/Fonts/SFNS.ttf';
    await access(font);
    // Filter text is fixed; no user input, URLs, cookies or token values reach the encoder.
    const left = `[0:v]setpts=PTS-STARTPTS,pad=740:680:10:40:color=0xebeae7,drawtext=fontfile='${font}':text='Alex · owner':x=10:y=10:fontsize=18:fontcolor=0x373734[left]`;
    const right = `[1:v]setpts=PTS-STARTPTS,pad=740:680:10:40:color=0xebeae7,drawtext=fontfile='${font}':text='Sam · joins as editor':x=10:y=10:fontsize=18:fontcolor=0x373734[right]`;
    const filter = `${left};${right};[left][right]hstack=inputs=2,fps=20,format=yuv420p[out]`;
    await mkdir('docs/demos', { recursive: true });
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', `${directory}/left.ffconcat`,
      '-f', 'concat', '-safe', '0', '-i', `${directory}/right.ffconcat`, '-filter_complex', filter, '-map', '[out]',
      '-t', String(capturedMs / 1000), '-c:v', 'libx264', '-preset', 'medium', '-crf', '25', '-movflags', '+faststart',
      `${directory}/authenticated-sync.mp4`], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-v', 'error', '-i', `${directory}/authenticated-sync.mp4`, '-f', 'null', '-'], { stdio: 'ignore' });
    await rename(`${directory}/authenticated-sync.mp4`, 'docs/demos/authenticated-sync.mp4');
    console.log(JSON.stringify({ artifact: 'docs/demos/authenticated-sync.mp4', frames: frames.length, capturedMs,
      sequence: Number(row.sequence), snapshotSequence: Number(row.snapshot_sequence), retainedUpdates: updates.length, receipts, checks }));
  } finally {
    recording = false;
    try { await capture; }
    finally {
      try { await browser?.close(); }
      finally {
        try { await server?.close(); }
        finally {
          try { await pool.end(); }
          finally {
            try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
            finally { await admin.end(); }
          }
        }
      }
    }
  }
}

await record().catch(() => {
  // Never print exceptions containing login/fragment URLs or raw driver parameters.
  console.error(`Authenticated demo capture failed during ${phase}; no successful recording is claimed.`);
  process.exitCode = 1;
});
