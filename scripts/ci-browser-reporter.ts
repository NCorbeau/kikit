import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

type ResultSummary = {
  title: string;
  location: string;
  status: TestResult['status'];
  expectedStatus: TestCase['expectedStatus'];
  durationMs: number;
  retry: number;
  errors: number;
  screenshots: string[];
};

// Browser errors, stdout, and traces can contain login URLs and cookies.
// Publish only explicit diagnostic fields; never serialize a raw TestResult.
export default class CiBrowserReporter implements Reporter {
  private outputDir = '';
  private total = 0;
  private runnerErrors = 0;
  private readonly results: ResultSummary[] = [];

  onBegin(config: FullConfig, suite: Suite) {
    this.outputDir = config.projects[0].outputDir;
    this.total = suite.allTests().length;
    console.log(`Running ${this.total} independent-browser scenarios.`);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const location = `${relative(process.cwd(), test.location.file)}:${test.location.line}`;
    this.results.push({
      title: test.title,
      location,
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
      retry: result.retry,
      errors: result.errors.length,
      screenshots: result.attachments
        .filter(attachment => attachment.contentType === 'image/png' && attachment.path)
        .map(attachment => relative(this.outputDir, attachment.path!)),
    });
    console.log(`${result.status}: ${test.title} (${location}, ${result.duration}ms)`);
  }

  onStdOut() {}
  onStdErr() {}

  onError() {
    this.runnerErrors++;
    console.error('Playwright runner error. Raw error details are omitted from CI diagnostics.');
  }

  async onEnd(result: FullResult) {
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(join(this.outputDir, 'summary.json'), JSON.stringify({
      status: result.status,
      total: this.total,
      runnerErrors: this.runnerErrors,
      results: this.results,
    }, null, 2) + '\n');
    console.log(`Browser run ${result.status}. Summary: ${relative(process.cwd(), this.outputDir)}/summary.json`);
  }

  printsToStdio() { return true; }
}
