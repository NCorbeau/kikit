import { afterEach, expect, it, vi } from 'vitest';
import { joinInvitation, removeMember } from './client';

const token = 'A'.repeat(43);
const page = { id: '00000000-0000-4000-8000-000000000001', title: 'Shared note', createdAt: '2026-10-02T00:00:00.000Z', role: 'editor' };
afterEach(() => vi.unstubAllGlobals());

it('binds join to the mounted account before mutation and checks the account on the successful response', async () => {
  const dispatchEvent = vi.fn();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { headers: { 'X-Kikit-Account': 'b' } }));
  vi.stubGlobal('window', { dispatchEvent }); vi.stubGlobal('fetch', fetch);
  await expect(joinInvitation(token, 'a')).rejects.toThrow('Your account changed');
  const [url, request] = fetch.mock.calls[0]!;
  expect(url).toBe('/api/invitations/join');
  expect(request.headers.get('X-Kikit-Account')).toBe('a');
  expect(request.headers.get('Content-Type')).toBe('application/json');
  expect(JSON.parse(request.body)).toEqual({ token });
  expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'kikit-session-ended' }));
});

it('validates identity for bodyless membership changes too and escapes account IDs in paths', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204, headers: { 'X-Kikit-Account': 'a' } }));
  vi.stubGlobal('fetch', fetch);
  await removeMember(page.id, 'a', 'member/with/slash');
  const [url, request] = fetch.mock.calls[0]!;
  expect(url).toBe(`/api/pages/${page.id}/members/member%2Fwith%2Fslash`);
  expect(request.headers.get('X-Kikit-Account')).toBe('a');
});

it('distinguishes invalidated invitations from session expiry without exposing server response content', async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  const fetch = vi.fn().mockResolvedValueOnce(new Response('Private server error', { status: 410 }))
    .mockResolvedValueOnce(new Response('Private server error', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  await expect(joinInvitation(token, 'a')).rejects.toThrow('This invitation is invalid or has been disabled.');
  expect(dispatchEvent).not.toHaveBeenCalled();
  await expect(joinInvitation(token, 'a')).rejects.toThrow('Sign in again');
  expect(dispatchEvent).toHaveBeenCalledOnce();
});
