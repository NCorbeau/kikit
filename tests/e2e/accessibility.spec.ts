import { test, expect, type BrowserContext, type Locator } from '@playwright/test';
import { AccountBrowserHarness, accountOrigin, appendBody, createNote, downloadRecovery, pageBody, serverSaved,
  expectDocumentText } from './account-support';
import * as Y from 'yjs';
import { decodeUpdate } from '@kikit/contracts';
import { openHeaderMenu } from './header-actions';

const harness = new AccountBrowserHarness();
const contexts: BrowserContext[] = [];
test.beforeAll(async () => { await harness.prepare(); });
test.beforeEach(async () => { await harness.start(); });
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.close()));
  await harness.stop();
});
test.afterAll(async () => { await harness.dispose(); });

test('browser-native composition cancellation and Unicode commits survive offline reload with original receipts', async ({ browser }) => {
  const author = await browser.newContext(), collaborator = await browser.newContext(); contexts.push(author, collaborator);
  const owner = await harness.authenticate(author), member = await harness.authenticate(collaborator);
  const page = await author.newPage(), peer = await collaborator.newPage();
  const id = await createNote(page, 'Unicode composition', 'Baseline.');
  // Use the real authenticated invitation endpoints to establish the peer;
  // invitation UI/QR behavior is independently exercised by sharing.spec.ts.
  const invitation = await harness.server.inject({ method: 'POST', url: `/api/pages/${id}/invitation`,
    headers: { origin: accountOrigin, cookie: owner.cookie, 'x-kikit-account': owner.accountId } });
  expect(invitation.statusCode).toBe(200);
  const joined = await harness.server.inject({ method: 'POST', url: '/api/invitations/join',
    headers: { origin: accountOrigin, cookie: member.cookie, 'x-kikit-account': member.accountId },
    payload: { token: invitation.json().token } });
  expect(joined.statusCode).toBe(200);
  await peer.goto(`/#/page/${id}`); await serverSaved(peer);
  await author.setOffline(true);
  const body = pageBody(page);
  await body.focus(); await body.press('ControlOrMeta+End');
  await body.evaluate(element => {
    const trace: Array<{ type: string; trusted: boolean }> = [];
    (window as typeof window & { compositionTrace: typeof trace }).compositionTrace = trace;
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput']) {
      document.addEventListener(type, event => {
        if (event.target instanceof Element && element.contains(event.target)) trace.push({ type, trusted: event.isTrusted });
      }, true);
    }
  });
  const input = await author.newCDPSession(page);
  try {
    await input.send('Input.imeSetComposition', { text: '撤回', selectionStart: 2, selectionEnd: 2 });
    await input.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expectDocumentText(body, 'Baseline.');
    await input.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await input.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await input.send('Input.insertText', { text: '日本語' });
    await input.send('Input.insertText', { text: ' e\u0301 👩🏽‍💻 ' });
    await input.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
    await input.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await input.send('Input.insertText', { text: '한글' });
  } finally { await input.detach(); }
  const expected = 'Baseline.日本語 e\u0301 👩🏽‍💻 한글';
  await expectDocumentText(body, expected);
  await expect(page.getByTestId('save-status')).toHaveText('Saved on this device');
  const trace = await page.evaluate(() => (window as typeof window & {
    compositionTrace: Array<{ type: string; trusted: boolean }>;
  }).compositionTrace);
  for (const type of ['compositionstart', 'compositionupdate', 'beforeinput']) {
    expect(trace.some(event => event.type === type && event.trusted)).toBe(true);
  }
  expect(trace.some(event => event.type === 'compositionend')).toBe(true);
  const recovery = await downloadRecovery(page, 'Download recovery file');
  expect(recovery.pending.length).toBeGreaterThan(0);
  await page.reload();
  await expectDocumentText(pageBody(page), expected);
  const reloaded = await downloadRecovery(page, 'Download recovery file');
  expect(reloaded.pending).toEqual(recovery.pending);
  await appendBody(peer, ' Remote edit.'); await serverSaved(peer);
  await author.setOffline(false); await serverSaved(page); await serverSaved(peer);
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, decodeUpdate(recovery.update));
  const sourceText = (recovered.getXmlFragment('body').get(0) as Y.XmlElement).toArray().map(node => node.toString()).join('');
  expect(sourceText).toBe(expected); recovered.destroy();
  for (const record of recovery.pending) {
    expect((await harness.pool.query('SELECT count(*)::int AS count FROM receipts WHERE page_id=$1 AND batch_id=$2',
      [id, record.batchId])).rows[0].count).toBe(1);
  }
  // Test a fresh local undo capture after reload; the collaborator's edit stays.
  await pageBody(page).focus(); await pageBody(page).press('ControlOrMeta+End');
  await page.keyboard.insertText(' Local undo marker.'); await serverSaved(page);
  await pageBody(page).press('ControlOrMeta+z'); await serverSaved(page); await serverSaved(peer);
  const text = await pageBody(page).evaluate(element => (element as HTMLElement & {
    editor: { state: { doc: { textContent: string } } };
  }).editor.state.doc.textContent);
  expect(text).toContain('Remote edit.'); expect(text).not.toContain('Local undo marker.');
  expect(text.match(/日本語/g)).toHaveLength(1); expect(text.match(/한글/g)).toHaveLength(1);
  expect(text).toContain('e\u0301 👩🏽‍💻'); expect(text).not.toContain('撤回'); expect(text).not.toContain('にほん');
  await expectDocumentText(pageBody(peer), text);
  await page.reload(); await serverSaved(page); await expectDocumentText(pageBody(page), text);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`320px ${colorScheme} writing, formatting, popover and recovery dialog remain keyboard reachable`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 700 }, colorScheme }); contexts.push(context);
    await harness.authenticate(context);
    const page = await context.newPage();
    await createNote(page, `Keyboard ${colorScheme}`, 'Keyboard checks remain editable.');
    await page.reload();
    await expect(page.getByTestId('save-status')).toHaveText('Saved to server');
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to writing', exact: true });
    await expect(skip).toBeFocused();
    const skipBounds = await skip.boundingBox(); expect(skipBounds!.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter'); await expect(page.locator('#writing')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByRole('textbox', { name: 'Page title', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(pageBody(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'To-do list', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Heading 3', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const heading = page.getByRole('button', { name: 'Heading 2', exact: true });
    await expect(heading).toBeFocused();
    const focus = await heading.evaluate(element => ({ visible: element.matches(':focus-visible'),
      width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle }));
    expect(focus.visible).toBe(true); expect(focus.width).toBe('2px'); expect(focus.style).toBe('solid');
    await page.keyboard.press('Enter'); await expect(pageBody(page)).toBeFocused();
    await expectDocumentText(pageBody(page).locator('h2'), 'Keyboard checks remain editable.');
    const trigger = page.getByRole('button', { name: 'Note menu', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const menu = page.getByRole('region', { name: 'Note menu', exact: true }); await expect(menu).toBeVisible();
    await page.keyboard.press('Tab'); await expect(menu.getByRole('button', { name: 'Share', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(menu.getByRole('button', { name: 'Download recovery file', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(menu.getByRole('button', { name: 'Import recovery file', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Import recovery file', exact: true }); await expect(dialog).toBeVisible();
    const file = dialog.getByLabel('Recovery file', { exact: true }); await expect(file).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Recover new private copy' })).toBeDisabled();
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(file).toBeFocused();
    const dialogBounds = await dialog.boundingBox();
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(0); expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.press('Enter'); await expect(menu).toBeVisible();
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(trigger).toBeFocused();
    // Formatting deliberately retained a full selection. Collapse it with a
    // native cursor key before typing rather than relying on OS-specific End.
    await pageBody(page).focus(); await pageBody(page).press('ArrowRight');
    await page.keyboard.insertText(' Still editable.'); await serverSaved(page);
    await expectDocumentText(pageBody(page), 'Keyboard checks remain editable. Still editable.');
  });
}

type Rgb = [number, number, number];
function luminance(color: Rgb): number {
  const linear = color.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}
function contrast(a: Rgb, b: Rgb): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}
async function renderedColors(locator: Locator) {
  return locator.evaluate(element => {
    type Rgba = [number, number, number, number];
    function parse(value: string): Rgba {
      const values = value.match(/[\d.]+/g)?.map(Number);
      if (!value.startsWith('rgb') || !values || values.length < 3) throw new Error('Expected computed RGB color');
      return [values[0]!, values[1]!, values[2]!, values[3] ?? 1];
    }
    function background(node: Element | null): [number, number, number] {
      if (!node) return [255, 255, 255];
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color[3] === 1) return color.slice(0, 3) as [number, number, number];
      const behind = background(node.parentElement);
      return behind.map((value, index) => color[index]! * color[3] + value * (1 - color[3])) as [number, number, number];
    }
    const style = getComputedStyle(element);
    // Audited controls use opaque text without element opacity, gradients or
    // background images. Fail rather than silently miscompute a changed style.
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (getComputedStyle(node).opacity !== '1' || getComputedStyle(node).backgroundImage !== 'none') {
        throw new Error('Contrast audit needs explicit opacity/image handling');
      }
    }
    const foreground = parse(style.color); const outline = parse(style.outlineColor);
    if (foreground[3] !== 1 || outline[3] !== 1) throw new Error('Expected opaque foreground and focus color');
    return { foreground: foreground.slice(0, 3) as [number, number, number], background: background(element),
      outline: outline.slice(0, 3) as [number, number, number], adjacent: background(element.parentElement),
      outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, transitionDuration: style.transitionDuration };
  });
}

test('small control labels and focus contrast meet thresholds in both themes with reduced motion and narrow reflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' }); contexts.push(context);
  await harness.authenticate(context); const page = await context.newPage();
  await createNote(page, 'Contrast review', 'Readable writing and controls.');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const checkText = async (label: Locator, state: string) => {
      await expect(label).toBeVisible();
      const colors = await renderedColors(label);
      expect(contrast(colors.foreground, colors.background), `${scheme} ${state}`).toBeGreaterThanOrEqual(4.5);
      expect(colors.transitionDuration.split(',').every(value => Number.parseFloat(value) === 0)).toBe(true);
    };
    await pageBody(page).focus();
    await page.getByRole('button', { name: 'Paragraph', exact: true }).click();
    const heading = page.getByRole('button', { name: 'Heading 2', exact: true });
    await page.mouse.move(0, 0); await checkText(heading, 'heading normal');
    await heading.hover(); await checkText(heading, 'heading hover');
    await heading.click(); await page.mouse.move(0, 0);
    await expect(heading).toHaveAttribute('aria-pressed', 'true'); await checkText(heading, 'heading selected');
    const summary = page.locator('.save-summary');
    await page.mouse.move(0, 0); await checkText(page.getByTestId('save-status'), 'save normal');
    await summary.hover(); await checkText(page.getByTestId('save-status'), 'save hover');
    await checkText(summary.locator('.connection-label'), 'connection hover');
    const navigation = page.getByRole('button', { name: 'All notes', exact: true });
    await page.mouse.move(0, 0); await checkText(navigation, 'navigation normal');
    await navigation.hover(); await checkText(navigation, 'navigation hover');
    await openHeaderMenu(page);
    await checkText(page.locator('.menu-label'), 'appearance label');
    const share = page.getByRole('button', { name: 'Share', exact: true });
    await share.hover(); await checkText(share, 'share hover');
    await page.keyboard.press('Escape');
    await pageBody(page).focus(); await page.keyboard.press('Shift'); await heading.focus();
    const focused = await renderedColors(heading);
    expect(focused.outlineStyle).toBe('solid'); expect(focused.outlineWidth).toBe('2px');
    expect(contrast(focused.outline, focused.adjacent), `${scheme} custom focus on paper`).toBeGreaterThanOrEqual(3);
    expect(contrast(focused.outline, focused.background), `${scheme} custom focus beside active control`).toBeGreaterThanOrEqual(3);
    // Available layout width equivalent to halving 1280px, not native browser
    // zoom or text enlargement. Those remain explicit manual release checks.
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(pageBody(page)).toBeVisible(); await expect(heading).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
    await expectDocumentText(pageBody(page), 'Readable writing and controls.');
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});
