import { openHeaderMenu, showSyncDetails } from './header-actions';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import * as Y from 'yjs';
import { decodeUpdate } from '@kikit/contracts';
import { createServer } from '../../apps/server/src/app';
import { migrateDatabase } from '../../apps/server/src/migrations';
import { authenticateBrowser, type BrowserAccount } from '../support/browser-auth';
export type { BrowserAccount } from '../support/browser-auth';
export { expectDocumentText, expectDocumentContains, expectDocumentExcludes } from './document-assertions';

export const accountDatabaseUrl = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit_e2e';
export const accountOrigin = 'http://127.0.0.1:5198';

export interface RecoveryFile {
  accountId: string; pageId: string; update: string;
  pending: { batchId: string; update: string }[];
}

/** Actual Better Auth sessions, captured delivery, production assets and isolated browser storage. */
export class AccountBrowserHarness {
  readonly pool = new pg.Pool({ connectionString: accountDatabaseUrl });
  readonly mail = new Map<string, string>();
  private readonly emails = new Set<string>();
  private peer = 100;
  server!: Awaited<ReturnType<typeof createServer>>;

  async prepare(): Promise<void> {
    process.env.NODE_ENV = 'test';
    process.env.KIKIT_DEV_FIXTURE = '0';
    process.env.KIKIT_TEST_FAULTS = '1';
    process.env.BETTER_AUTH_SECRET = 'shared-browser-test-secret-never-used-in-production';
    await migrateDatabase(this.pool);
  }

  async start(): Promise<void> {
    this.server = await createServer({
      databaseUrl: accountDatabaseUrl, origin: accountOrigin, serveWeb: true,
      sendMagicLink: async ({ email, url }) => { this.mail.set(email, url); },
    });
    await this.server.listen({ host: '127.0.0.1', port: 5198 });
  }

  async stop(): Promise<void> { await this.server?.close(); }

  email(): string {
    const email = `${randomUUID()}@example.test`;
    this.emails.add(email);
    return email;
  }

  async authenticate(context: BrowserContext, email = this.email()): Promise<BrowserAccount> {
    this.emails.add(email);
    // Keep the real limiter enabled; each independent signup uses a separate local peer.
    const remoteAddress = `127.0.1.${++this.peer}`;
    return authenticateBrowser({ server: this.server, context, origin: accountOrigin,
      email, remoteAddress, getMagicLink: address => this.mail.get(address) });
  }

  async loginThroughUi(page: Page, email: string, destination = '/'): Promise<void> {
    this.emails.add(email);
    await page.goto(destination);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(page.getByRole('status')).toContainText('Check your inbox');
    await expect.poll(() => this.mail.get(email)).toBeTruthy();
    await page.goto(this.mail.get(email)!);
  }

  async dispose(): Promise<void> {
    await this.stop();
    for (const email of this.emails) {
      const users = await this.pool.query('SELECT id FROM auth_user WHERE email=$1', [email]);
      for (const { id } of users.rows) {
        const owned = await this.pool.query('SELECT id FROM pages WHERE owner_id=$1', [id]);
        for (const note of owned.rows) {
          await this.pool.query('DELETE FROM page_invitations WHERE page_id=$1', [note.id]);
          await this.pool.query('DELETE FROM receipts WHERE page_id=$1', [note.id]);
          await this.pool.query('DELETE FROM document_updates WHERE page_id=$1', [note.id]);
          await this.pool.query('DELETE FROM page_grants WHERE page_id=$1', [note.id]);
          await this.pool.query('DELETE FROM pages WHERE id=$1', [note.id]);
        }
        await this.pool.query('DELETE FROM page_grants WHERE account_id=$1', [id]);
        await this.pool.query('DELETE FROM auth_user WHERE id=$1', [id]);
      }
    }
    await this.pool.end();
  }
}

export const pageBody = (page: Page) => page.getByRole('textbox', { name: 'Page body', exact: true });
export async function serverSaved(page: Page) {
  await showSyncDetails(page);
  await expect(page.getByTestId('save-status')).toHaveText('Saved to server');
}

export async function appendBody(page: Page, value: string): Promise<void> {
  await pageBody(page).click();
  await pageBody(page).press('ControlOrMeta+End');
  await page.keyboard.insertText(value);
}

export async function createNote(page: Page, title: string, content: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await expect(pageBody(page)).toBeVisible();
  await page.getByRole('textbox', { name: 'Page title', exact: true }).fill(title);
  await pageBody(page).fill(content);
  await serverSaved(page);
  return new URL(page.url()).hash.split('/').at(-1)!;
}

export async function downloadRecovery(page: Page, buttonName = 'Download recovery', scope?: Locator): Promise<RecoveryFile> {
  if (buttonName === 'Download recovery file') await openHeaderMenu(page);
  const downloaded = page.waitForEvent('download');
  await (scope ?? page).getByRole('button', { name: buttonName, exact: true }).click();
  const file = await downloaded;
  return JSON.parse(await readFile((await file.path())!, 'utf8')) as RecoveryFile;
}

export function recoveryBody(recovery: RecoveryFile): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, decodeUpdate(recovery.update));
    return doc.getXmlFragment('body').toString();
  } finally { doc.destroy(); }
}
