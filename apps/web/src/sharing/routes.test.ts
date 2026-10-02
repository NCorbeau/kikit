import { afterEach, expect, it, vi } from 'vitest';
import { invitationUrl, readAppRoute, readBrowserRoute, rememberInvitation, signInContinuation } from './routes';

const token = 'A'.repeat(43);
afterEach(() => vi.unstubAllGlobals());

it('accepts only bounded invitation tokens and a secret-free local auth continuation', () => {
  expect(readAppRoute(`#/join/${token}`)).toEqual({ kind: 'join', token });
  for (const hash of ['#/join/short', `#/join/${token}/more`, '#/join/https://foreign.example', '#/join/%2Fother']) {
    expect(readAppRoute(hash)).toEqual({ kind: 'invalid-invitation' });
  }
  expect(signInContinuation({ kind: 'join', token })).toBe('/#/join');
  expect(signInContinuation({ kind: 'join', token: 'https://foreign.example' })).toBe('/');
  expect(signInContinuation({ kind: 'notes' })).toBe('/');
});

it('restores a validated invitation in the initiating tab, and clears it after leaving', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('location', { hash: '#/join' });
  rememberInvitation({ kind: 'join', token });
  expect(readBrowserRoute()).toEqual({ kind: 'join', token });
  rememberInvitation({ kind: 'notes' });
  expect(readBrowserRoute()).toEqual({ kind: 'resume-join' });
  values.set('kikit-pending-invitation-v1', 'https://foreign.example');
  expect(readBrowserRoute()).toEqual({ kind: 'resume-join' });
});

it('keeps sign-in available when continuation storage fails and places the invitation only in the URL fragment', () => {
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Storage unavailable'); }, setItem: () => { throw new Error('Storage unavailable'); } });
  vi.stubGlobal('location', { hash: '#/join', origin: 'https://kikit.example' });
  expect(() => rememberInvitation({ kind: 'join', token })).not.toThrow();
  expect(readBrowserRoute()).toEqual({ kind: 'resume-join' });
  const url = new URL(invitationUrl(token));
  expect(url.origin).toBe('https://kikit.example');
  expect(url.search).toBe('');
  expect(url.hash).toBe(`#/join/${token}`);
});
