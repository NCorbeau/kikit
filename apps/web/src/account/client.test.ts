import { afterEach, expect, it, vi } from 'vitest';
const getSession = vi.hoisted(() => vi.fn());
vi.mock('better-auth/react', () => ({ createAuthClient: () => ({ getSession }) }));
vi.mock('better-auth/client/plugins', () => ({ magicLinkClient: () => ({}) }));
import { fetchWorkspace, newPage } from './client';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const account = (id: string) => new Response(JSON.stringify({ accountId: id, email: `${id}@example.test`, fixture: false }));
const notes = (id: string) => new Response(JSON.stringify([{ id: '00000000-0000-4000-8000-000000000001', title: `${id}'s note`, createdAt: '2026-10-02T00:00:00.000Z' }]), { headers: { 'X-Kikit-Account': id } });

it('refetches when an account changes between session validation and listing notes', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(account('a')).mockResolvedValueOnce(notes('b'))
    .mockResolvedValueOnce(account('b')).mockResolvedValueOnce(notes('b'));
  vi.stubGlobal('fetch', fetch);
  getSession.mockResolvedValueOnce({ data: { user: { id: 'a' } } }).mockResolvedValueOnce({ data: { user: { id: 'b' } } });
  const workspace = await fetchWorkspace();
  expect(workspace.account?.accountId).toBe('b');
  expect(workspace.pages[0].title).toBe("b's note");
});

it('does not associate a note creation response from another account with the mounted account', async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'X-Kikit-Account': 'b' } })));
  await expect(newPage('00000000-0000-4000-8000-000000000001', 'a')).rejects.toThrow('Your account changed');
  expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'kikit-session-ended' }));
});
