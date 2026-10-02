# Continuous integration

The `Quality checks` workflow in `.github/workflows/quality.yml` runs for pull requests targeting `main`, pushes to `main`, and manual dispatch after the workflow reaches the default branch. It reports four separate checks:

| Check | Repository commands |
| --- | --- |
| Code quality | `pnpm typecheck`, `pnpm build`, `pnpm test` |
| PostgreSQL integration and restore | `pnpm db:up`, `pnpm test:integration`, `pnpm test:restore` |
| Browsers (fixture) | `pnpm db:up`, `pnpm test:e2e` |
| Browsers (accounts) | `pnpm db:up`, `pnpm test:e2e:accounts` |

Jobs use separate Ubuntu 24.04 runners, Node 24.21.0, pnpm 12.5.1 from `packageManager`, and a frozen lockfile. Dependency downloads are cached through setup-node. Browser jobs install Chromium and its Linux dependencies from the locked Playwright version. Each suite keeps one worker, rejects focused tests in CI, and has no automatic retries.

The existing Compose definition supplies PostgreSQL 17.9 with public local fixture credentials, health readiness, and loopback port 54329. Each database/browser runner gets its own disposable database and volume. Cleanup runs even after a failed test. Do not copy the workflow's volume-removal step into a development session with valuable local notes.

Browser and integration suites must not share a database while running concurrently: the fixture suite resets the test schema, and account servers enforce single-process room ownership. Separate runners provide that isolation. The browser harnesses start their actual backend; fixture mode also starts Vite, while the account command builds and serves production assets. Account scenarios use real Better Auth sessions with captured email delivery, not Resend or hosted accounts. These checks do not establish hosted email delivery or the invitation release gate.

## Failure diagnostics and data boundary

CI uses fresh browser contexts, synthetic accounts/notes, and disposable local databases. It supplies no Railway, Resend, migration, or production secrets. The workflow uses `pull_request`, a read-only repository token, checkout without persisted credentials, and commit-pinned actions. New runs cancel superseded runs for the same pull request/ref; job timeouts bound stalled checks. There is no deployment step.

Failed browser runs upload named artifacts for seven days:

- `browser-failure-fixture`: result summary, failure screenshots, and retained Playwright traces.
- `browser-failure-accounts`: result summary and failure screenshots. CI disables account tracing because login URLs and cookies can appear in trace records.

The upload paths explicitly allow only the summary, PNGs, and fixture `trace.zip` files. Recovery downloads, database dumps, raw error-context files, account traces, environment files, and private local planning references are excluded.

The CI reporter prints scenario names, locations, status, and timing. Its JSON adds error counts and screenshot paths. Raw errors, stdout/stderr, response bodies, and arbitrary attachments are omitted because they can contain credentials. The reporter does not change test outcomes. Regressions verify credential omission and a safe summary when collection fails before tests start. Cookie attribute assertions report booleans; restore comparisons report table digests instead of dumping authentication or note records on failure.

Download an artifact from the failed GitHub run to inspect its summary/screenshots. Open fixture traces with `pnpm exec playwright show-trace /absolute/path/to/trace.zip`. For full account error details, reproduce using the local commands without `CI` set, against synthetic data. Local traces stay in ignored `test-results/accounts` and must not be uploaded without review.

The workflow reports checks; requiring them before merging is a separate repository ruleset setting. The [verification record](verification.md) distinguishes local results, actual Actions runs, deliberate failure drills, and pending merge/default-branch evidence.
