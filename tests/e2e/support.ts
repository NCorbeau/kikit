import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, encodeUpdate, type ServerMessage } from '@kikit/contracts';
import { createServer } from '../../apps/server/src/app';

export const databaseUrl = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit_e2e';
export const origin = 'http://127.0.0.1:5174';
export const pool = new pg.Pool({ connectionString: databaseUrl });
export let server: Awaited<ReturnType<typeof createServer>>;
export const contexts: BrowserContext[] = [];

export async function startServer() {
  server = await createServer({ databaseUrl, origin });
  await server.listen({ host: '127.0.0.1', port: 3002 });
}

export async function openPage(browser: Browser) {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Page body', exact: true })).toBeVisible();
  await expectServerSaved(page);
  return { context, page };
}

export async function expectServerSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved to server');
}

export async function appendToBody(page: Page, value: string) {
  const body = page.getByRole('textbox', { name: 'Page body', exact: true });
  await body.click();
  await body.press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
}

export async function openRawSyncConnection(pageId = DEV_PAGE_ID, protocolVersion = PROTOCOL_VERSION) {
  const socket = new WebSocket('ws://127.0.0.1:3002/api/sync', { origin });
  const messages: ServerMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello',
    pageId,
    protocolVersion,
    schemaVersion: DOCUMENT_SCHEMA_VERSION
  }));
  const next = async (type: ServerMessage['type']) => {
    await expect.poll(() => messages.some(message => message.type === type)).toBe(true);
    return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
  };
  return {
    socket,
    next,
    messages
  };
}

export function createTitleUpdate(sync: ServerMessage, text: string) {
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
