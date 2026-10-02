import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';
import { workspaceAccountSchema as accountSchema, pageSummarySchema as pageSchema, workspaceSchema, type PageSummary, type WorkspaceSession } from '@kikit/contracts';

export const authClient = createAuthClient({ plugins: [magicLinkClient()] });
export type Workspace = { account: WorkspaceSession | null; pages: PageSummary[] };
export const WORKSPACE_KEY = 'kikit-workspace-v1';

export async function fetchWorkspace(attempt = 0): Promise<Workspace> {
  if (attempt > 2) throw new Error('Your account changed. Try again.');
  const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
  if (response.status === 401) return { account: null, pages: [] };
  if (!response.ok) throw new Error('Could not reach your account. Try again.');
  const account = accountSchema.parse(await response.json());
  if (!account.fixture) {
    // The HTTP auth handler forwards renewal cookies to the browser.
    const renewed = await authClient.getSession({ query: { disableCookieCache: true } });
    if (renewed.error) throw new Error('Could not check your session. Try again.');
    if (!renewed.data || renewed.data.user.id !== account.accountId) return fetchWorkspace(attempt + 1);
  }
  const notes = await fetch('/api/pages', { cache: 'no-store', credentials: 'same-origin' });
  if (notes.status === 401) return { account: null, pages: [] };
  if (!notes.ok) throw new Error('Could not load your notes. Try again.');
  if (notes.headers.get('X-Kikit-Account') !== account.accountId) return fetchWorkspace(attempt + 1);
  return workspaceSchema.parse({ account, pages: await notes.json() });
}

export function rememberWorkspace(workspace: Workspace): void {
  try {
    if (workspace.account) localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch { /* The document journal remains the local durability boundary. */ }
}
export function offlineWorkspace(): Workspace | null {
  try { return workspaceSchema.parse(JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? 'null')); }
  catch { return null; }
}
export async function newPage(id: string, accountId: string) {
  const response = await fetch('/api/pages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to create a note.' : 'Could not create the note. Try again.');
  if (response.headers.get('X-Kikit-Account') !== accountId) {
    window.dispatchEvent(new Event('kikit-session-ended'));
    throw new Error('Your account changed. Reopen your notes.');
  }
  return pageSchema.parse(await response.json());
}
