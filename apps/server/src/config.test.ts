import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopback, requireDevelopmentFixture } from './config.js';
import { createServer } from './app.js';
import { seedDevelopmentPage } from './development-seed.js';
import type pg from 'pg';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('development fixture boundary', () => {

  it('refuses to seed fixture data outside development/test before connecting', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    const connect = vi.fn();
    await expect(seedDevelopmentPage({ connect } as unknown as pg.Pool)).rejects.toThrow('It cannot run in production');
    expect(connect).not.toHaveBeenCalled();
  });

  it('fails closed in production even if the fixture flag is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    await expect(createServer()).rejects.toThrow('It cannot run in production');
  });

  it('requires explicit opt-in in development and test', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '0');
    expect(requireDevelopmentFixture).toThrow();
    vi.stubEnv('NODE_ENV', 'test');
    expect(requireDevelopmentFixture).toThrow();
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    expect(requireDevelopmentFixture).not.toThrow();
  });

  it('refuses a non-loopback fixture origin before opening a database pool', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    await expect(createServer({ origin: 'https://public.example' })).rejects.toThrow('loopback browser origin');
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });

  it('does not register test faults in development even with their flag enabled', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    vi.stubEnv('KIKIT_TEST_FAULTS', '1');
    const app = await createServer();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/test/metrics' })).statusCode).toBe(404);
    }
    finally {
      await app.close();
    }
  });

  it('does not expose query parameters from an unexpected HTTP failure', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('KIKIT_DEV_FIXTURE', '1');
    const app = await createServer();
    app.get('/api/harness-error', async () => { throw new Error('Failed query: session token private-marker'); });
    try {
      const response = await app.inject({ url: '/api/harness-error' });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private-marker');
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
});
