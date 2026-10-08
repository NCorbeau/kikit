import assert from 'node:assert/strict';
import type { BrowserContext } from '@playwright/test';
import type { createServer } from '../../apps/server/src/app';

export interface BrowserAccount { accountId: string; email: string; cookie: string }

/** Use real Better Auth sessions with synthetic delivery and a caller-owned peer
 * address. Browser contexts, server lifetime and rate limiting stay with callers. */
export async function authenticateBrowser({ server, context, origin, email, remoteAddress, getMagicLink }: {
  server: Awaited<ReturnType<typeof createServer>>;
  context: BrowserContext;
  origin: string;
  email: string;
  remoteAddress: string;
  getMagicLink(email: string): string | undefined;
}): Promise<BrowserAccount> {
  const sent = await server.inject({
    method: 'POST', url: '/api/auth/sign-in/magic-link', remoteAddress,
    headers: { origin }, payload: { email, callbackURL: '/' },
  });
  assert.equal(sent.statusCode, 200, 'Magic-link request failed');
  const capturedLink = getMagicLink(email);
  assert(capturedLink, 'Magic-link delivery was not captured');
  const link = new URL(capturedLink);
  const redeemed = await server.inject({ url: link.pathname + link.search, remoteAddress });
  assert.equal(redeemed.statusCode, 302, 'Magic-link redemption failed');

  const header = redeemed.headers['set-cookie'];
  const values = (Array.isArray(header) ? header : [header]).filter(Boolean).map(String);
  assert(values.length > 0, 'Magic-link redemption did not set a session cookie');
  const cookie = values.map(value => value.split(';')[0]).join('; ');
  await context.addCookies(values.map(value => {
    const pair = value.split(';')[0]!;
    const separator = pair.indexOf('=');
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1),
      url: origin, httpOnly: true, sameSite: 'Lax' as const };
  }));
  const identity = await server.inject({ url: '/api/session', headers: { cookie }, remoteAddress });
  assert.equal(identity.statusCode, 200, 'Authenticated session lookup failed');
  const accountId = identity.json().accountId as unknown;
  assert(typeof accountId === 'string' && accountId.length > 0, 'Session did not identify an account');
  return { accountId, email, cookie };
}
