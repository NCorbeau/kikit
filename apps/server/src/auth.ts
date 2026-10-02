import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { account, session, user, verification } from './schema.js';

export type SendMagicLink = (message: { email: string; url: string }) => Promise<void>;

export async function sendMagicLinkEmail({ email, url }: { email: string; url: string }): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.KIKIT_EMAIL_FROM, to: [email], subject: 'Sign in to Kikit',
      text: `Sign in to Kikit using this link:\n\n${url}\n\nThis link expires in 10 minutes and can only be used once. If you did not request it, ignore this email.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // Never expose provider responses, email addresses, or sign-in URLs in logs.
  if (!response.ok) throw new Error('Sign-in email delivery failed.');
}

export function createAuth(pool: pg.Pool, config: { origin: string; secret: string }, send: SendMagicLink = sendMagicLinkEmail) {
  return betterAuth({
    appName: 'Kikit', baseURL: config.origin, basePath: '/api/auth', secret: config.secret,
    trustedOrigins: [config.origin],
    database: drizzleAdapter(drizzle(pool), { provider: 'pg', schema: { user, session, account, verification } }),
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: config.origin.startsWith('https:'), defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' }, ipAddress: { ipAddressHeaders: ['x-kikit-client-ip'] } },
    rateLimit: { enabled: true, window: 60, max: 60 },
    logger: { disabled: true },
    plugins: [magicLink({ expiresIn: 600, storeToken: 'hashed', sendMagicLink: send })],
  });
}
export type KikitAuth = ReturnType<typeof createAuth>;

export function requestHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) result.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return result;
}
