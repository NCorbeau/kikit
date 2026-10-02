export const DEFAULT_DATABASE_URL = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit';
export function requireDevelopmentFixture(): void {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '') || process.env.KIKIT_DEV_FIXTURE !== '1') {
    throw new Error('The development fixture requires NODE_ENV=development/test and KIKIT_DEV_FIXTURE=1. It cannot run in production.');
  }
}

export function fixtureEnabled(): boolean {
  if (process.env.KIKIT_DEV_FIXTURE !== '1') return false;
  requireDevelopmentFixture();
  return true;
}

export function accountConfig(originOverride?: string) {
  const origin = originOverride ?? process.env.KIKIT_ORIGIN;
  if (!origin) throw new Error('KIKIT_ORIGIN must be the exact application origin.');
  const parsed = new URL(origin);
  if (parsed.origin !== origin) throw new Error('KIKIT_ORIGIN must not include a path or trailing slash.');
  if (process.env.NODE_ENV === 'production') {
    if (parsed.protocol !== 'https:') throw new Error('Production requires an HTTPS origin.');
    if (!process.env.DATABASE_URL) throw new Error('Production requires DATABASE_URL.');
    if (!process.env.RESEND_API_KEY || !process.env.KIKIT_EMAIL_FROM) throw new Error('Production requires Resend and a verified sender.');
  } else requireLoopbackOrigin(origin);
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  return { origin, secret };
}
export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function requireLoopbackOrigin(origin: string): void {
  const parsed = new URL(origin);
  const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  const httpProtocol = ['http:', 'https:'].includes(parsed.protocol);
  if (!httpProtocol || !loopbackHost || parsed.origin !== origin) {
    throw new Error('The development fixture requires an exact loopback browser origin');
  }
}
