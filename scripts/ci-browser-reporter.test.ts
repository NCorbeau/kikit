import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { expect, it, vi } from 'vitest';
import CiBrowserReporter from './ci-browser-reporter';

it('keeps failure status and screenshots without publishing credentials from errors or output', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'kikit-ci-reporter-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const credential = 'test-only-secret-that-must-not-be-published';
  try {
    const reporter = new CiBrowserReporter({ outputDir });
    reporter.onBegin({ projects: [{ outputDir }] } as FullConfig, { allTests: () => [1] } as unknown as Suite);
    reporter.onTestEnd({
      title: 'account isolation',
      location: { file: join(process.cwd(), 'tests/e2e/accounts.spec.ts'), line: 42, column: 1 },
      expectedStatus: 'passed',
    } as TestCase, {
      status: 'failed', duration: 120, retry: 0,
      errors: [{ message: `Cookie: session=${credential}`, stack: `magic-link?token=${credential}` }],
      stdout: [credential], stderr: [credential],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', path: join(outputDir, 'account/test-failed-1.png') },
        { name: 'trace', contentType: 'application/zip', path: credential },
      ],
    } as unknown as TestResult);
    // Playwright delivers these independently of the final result too.
    const output: Reporter = reporter;
    output.onStdOut?.(credential);
    output.onStdErr?.(credential);
    output.onError?.({ message: credential });
    await reporter.onEnd({ status: 'failed' } as FullResult);
    const summary = await readFile(join(outputDir, 'summary.json'), 'utf8');
    const emitted = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(summary + emitted).not.toContain(credential);
    expect(JSON.parse(summary)).toMatchObject({
      status: 'failed', total: 1, runnerErrors: 1,
      results: [{ status: 'failed', expectedStatus: 'passed', errors: 1,
        location: 'tests/e2e/accounts.spec.ts:42', screenshots: ['account/test-failed-1.png'] }],
    });
  } finally {
    log.mockRestore(); error.mockRestore();
    await rm(outputDir, { recursive: true, force: true });
  }
});

it('writes a safe summary when collection fails before any browser test starts', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'kikit-ci-collection-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const reporter = new CiBrowserReporter({ outputDir });
    const output: Reporter = reporter;
    output.onError?.({ message: 'secret in a configuration failure' });
    await reporter.onEnd({ status: 'failed' } as FullResult);
    const summary = await readFile(join(outputDir, 'summary.json'), 'utf8');
    expect(JSON.parse(summary)).toMatchObject({ status: 'failed', runnerErrors: 1, results: [] });
    expect(summary + JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('secret in a configuration failure');
  } finally {
    log.mockRestore(); error.mockRestore();
    await rm(outputDir, { recursive: true, force: true });
  }
});
