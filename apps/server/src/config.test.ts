import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopback, requireDevelopmentFixture } from './config.js';
import { createServer } from './app.js';

afterEach(() => { vi.unstubAllEnvs(); });
describe('development fixture boundary', () => {
  it('fails closed in production even if the fixture flag is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    await expect(createServer()).rejects.toThrow('Production authentication is not implemented');
  });
  it('requires explicit opt-in in development and test', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('KIKIT_DEV_FIXTURE', '0');
    expect(requireDevelopmentFixture).toThrow();
    vi.stubEnv('NODE_ENV', 'test'); expect(requireDevelopmentFixture).toThrow();
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1'); expect(requireDevelopmentFixture).not.toThrow();
  });
  it('refuses a non-loopback fixture origin before opening a database pool', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    await expect(createServer({ origin: 'https://public.example' })).rejects.toThrow('loopback browser origin');
    expect(isLoopback('127.0.0.1')).toBe(true); expect(isLoopback('::ffff:127.0.0.1')).toBe(true); expect(isLoopback('10.0.0.1')).toBe(false);
  });
  it('does not register test faults in development even with their flag enabled', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('KIKIT_DEV_FIXTURE', '1'); vi.stubEnv('KIKIT_TEST_FAULTS', '1');
    const app = await createServer();
    try { expect((await app.inject({ method: 'GET', url: '/api/test/metrics' })).statusCode).toBe(404); }
    finally { await app.close(); }
  });
});
