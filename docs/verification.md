# Milestone 1 verification

The dated milestone record below remains historical. The account slice's current checks are recorded in the 2026-10-02 addendum at the end of this file.

Verified on 2026-10-01 using macOS/Apple Silicon, Node 24.21.0, pnpm 12.5.1, Docker PostgreSQL 17.9, and Playwright 1.63.0's Chromium 153. All browser tests use the actual Fastify backend and PostgreSQL, fresh browser contexts, and a separate local test database. This is correctness evidence for small fixture documents, not a performance/capacity benchmark.

## Automated results

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed for shared contracts, server, web, test harness and root configuration |
| `pnpm test` | 36 passed; 13 PostgreSQL integration tests intentionally skipped without opt-in |
| `pnpm test:integration` | All 13 real PostgreSQL tests passed (7 persistence/WebSocket, 6 migrations) |
| `pnpm test:e2e` | All 18 Chromium scenarios passed |
| `pnpm build` | Passed; Vite reports a large editor chunk (728.51 kB before gzip) |

The browser scenarios cover:

1. Concurrent edits and title changes across independent storage contexts, including reload from committed state.
2. Several causally dependent offline edits, an actual offline navigation reload using the cached shell, and reconnect/replay to another context.
3. Duplicate delivery returning the same sequence and receipt; conflicting reuse of the identity rejected.
4. A WebSocket acknowledgement lost after COMMIT, followed by retry with exactly one new durable receipt.
5. Server shutdown/restart with pending local edits and reconstruction of a fresh room.
6. An exception after actual database COMMIT and before room application, recovering both live browser contexts before another edit.
7. Local undo preserving another session's committed change; newline title paste normalized to one paragraph.
8. A real PostgreSQL trigger rejecting writes: no receipt and no successful server-save status, local reload recovery, and automatic retry after removing the fault.
9. Unknown page, unsupported protocol and foreign WebSocket Origin denial.
10. Keyboard split/merge, isolated merge undo, heading shortcut, paste ID regeneration, selection, title-to-body Tab order and title Enter focus.
11. Chromium composition events followed by a Unicode commit, synchronized without the intermediate composition text remaining.
12. Offline clients deleting different remaining paragraphs, convergence to one server-repaired empty paragraph, continued editing, and stable block identity after reload.
13. System theme changes, manual preference retention after reload, and editor undo continuity across theme changes.
14. Denied theme preference storage still permitting appearance changes and committed note edits.
15. Offline recovery downloads preserving binary content and batch identities after a failed download and actual offline reload.
16. Clicking low on a short page focuses the editable body and accepts text.
17. Formatting controls appear while writing without moving the body, remain clickable, and hide when focus leaves.
18. `#`, `##`, and `###` followed by Space create the three supported heading levels.

Vitest checks additionally cover atomic IndexedDB aborts, namespace isolation, insertion-ordered replay, unsupported cached versions, unpersisted recovery exports, local acknowledgement persistence failure, stale handshakes, terminal readonly state, bounded queues, failed tasks, orderly shutdown, and production fixture denial. PostgreSQL checks exercise atomic rollback, duplicate receipts, concurrent row locking, cross-account denial, lost acknowledgement and uncertain commit recovery. The Drizzle refactor passes these same checks with Buffer-preserving query mappings. Six migration checks cover concurrent/repeated runs, explicit idempotent seeding, adoption of the old schema with stored notes/updates/receipts intact, subsequent-file application, failed DDL rollback, changed/missing history rejection, and newer-schema denial. These checks use temporary schemas and leave development notes untouched. The development seed also has a production-denial unit regression.

The migration workflow was exercised with `pnpm db:generate` (no outstanding schema diff) and `DATABASE_URL=.../kikit_e2e pnpm db:migrate` against the isolated test database. An independent review of the ORM/migration changes found no actionable introduced defects.

The `idb` refactor passed the full unit and browser suites. Added regressions read and acknowledge an existing native IndexedDB cache without changing its schema, identities, or bytes, and verify that an acknowledgement transaction abort retains pending work even after its write request succeeds. An independent review of the local-store changes found no actionable introduced defects.

For the borderless editor focus refinement, reran the three existing keyboard/paste/selection, collaborative undo, and theme scenarios against the actual backend and PostgreSQL; all passed. A separate preview harness checked Tab navigation, visible control focus rings, no editor outline or focus-induced layout shift, the gutter cue in forced colors, and no horizontal overflow at 320px. Build passed. The later page-surface refinement removed the gutter cue and shows formatting controls only while writing; the full 18-scenario browser suite and web build passed afterward.

## Manual inspection

Inspected the running application in regular Chrome using its screenshot and accessibility tree: the writing surface, typography, spacing, restrained controls, distinct device/server status, and labelled title/body/formatting controls were visible. The frontend implementer also inspected desktop and 390px screenshots and checked for horizontal overflow. Persistent Playwright tests provide the keyboard/paste/undo evidence above.

For the simplified UI, manually exercised title editing and Tab focus, native clipboard paste, text selection and heading shortcut, undo, light/dark switching, and the save details in regular Chrome against an isolated preview database. Reviewed fresh light/dark desktop and dark offline mobile screenshots; the preview harness also checked the open status menu at 320px and the editor at 390px without horizontal overflow. The UI/recovery/theme changes received a separate read-only review with no actionable introduced defects.

Visually inspected light/dark desktop and dark offline mobile screenshots from the earlier borderless focus refinement. They show the former gutter cue and persistent toolbar; the current page-surface change is covered by the browser checks above and an inspected desktop test screenshot. The screenshots use sample notes in a disposable preview database. The focus/navigation checks were automated, not a new manual keyboard or screen-reader audit.

No full screen-reader audit, native operating-system IME session, Safari/Firefox suite, mobile keyboard/device check or user usability study was performed. Chromium's composition-event test does not replace those checks.

## Independent review and resolved findings

An independent durability review identified two concrete races:

- A lost database COMMIT result left the room stale; a later peer commit could hide the missing update behind an advanced sequence. Persistence failures with uncertain outcomes now invalidate the room and close its sockets. Both PostgreSQL/WebSocket and independent-browser regressions verify reconstruction and stable receipts.
- An older batch's successful acknowledgement cleared a newer edit's local append failure. Append/load errors and local receipt-write errors are now separate. The regression verifies that the newer edit remains recoverable and its error stays actionable.

A subsequent branch review identified two further defects:

- Concurrent deletions could merge to an empty body and permanently reject a valid pending batch. The server now adds one empty paragraph to that candidate and commits the repair with the submitted update. Receipts still hash the original client bytes; duplicate delivery returns the same repair. Unit, PostgreSQL, and independent-browser regressions cover this path.
- An idle PostgreSQL connection error could escape as an unhandled event and terminate the backend. The pool now handles that event with a static warning. A real PostgreSQL test terminates a dedicated idle connection and verifies that the server accepts and commits another edit.

These findings are resolved. This is a local development milestone, not the authenticated-account release gate in AGENTS.md.

## Limits of the evidence

The unknown-COMMIT test injects an exception immediately after a real successful COMMIT; it does not cut a physical network link to PostgreSQL. Server restart is an orderly close/recreate. A PostgreSQL trigger supplies the tested database failure. Queue overload/drain are deterministic unit checks; sustained overload, process kill during COMMIT, socket blackholes and slow-recipient soak testing remain further hardening work.

There is no snapshot compaction, production deployment, backup/restore validation, real-login security verification or measured latency/capacity claim. The recovery file preserves binary state and batch identities but has no import UI. Browser storage eviction is not prevented.

## 2026-10-02: private account slice

Executed locally on macOS/Apple Silicon with Node 24.21.0, pnpm 12.5.1, PostgreSQL 17.9 in Docker, and Playwright 1.63.0 Chromium. The account browser harness serves the production Vite bundle directly through Fastify. It uses actual Better Auth magic-link verification and PostgreSQL sessions; delivery is captured in the test process instead of sent through Resend. Account signup has no public test-login endpoint.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed across contracts, server, web, scripts, and both browser configurations |
| `pnpm test` | 39 passed; 20 opt-in PostgreSQL tests skipped |
| `pnpm test:integration` | 20 passed: 7 accounts, 7 persistence/WebSocket, 6 migrations |
| `pnpm test:e2e` | Existing 18 fixture browser scenarios passed |
| `pnpm test:e2e:accounts` | Two production-build browser scenarios passed |
| `pnpm test:restore` | Disposable database dump/restore and restricted-role drill passed |
| `pnpm db:generate` | No schema changes detected |
| `docker build -t kikit-production-check .` | Passed for the local Linux ARM64 image |
| Production Docker runtime | Served assets and schema-aware health; denied unauthenticated API access and foreign-origin mutation; fixture/fault routes absent; orderly stop succeeded; ownership connection loss shut down with exit code 1 |

The seven account integration checks cover single-use hashed magic links, auth-cookie attributes, unauthenticated/foreign-origin denial, two-account isolation across listings/HTTP/WebSocket/storage, idempotent creation without reseeding, committed title projection and duplicate receipts, logout on active sockets, expiry and HTTP renewal, second-server ownership denial, ordering logout behind a handshake blocked on a real PostgreSQL row lock, and shutdown after terminating the ownership connection. The last operation logs a static message without credentials or note content. Two browser-client unit regressions cover account changes between session validation/listing and between note creation requests/responses. An HTTP regression verifies that an unexpected error containing query parameters is replaced with a generic public response.

The first account browser scenario uses three independent browser contexts: two distinct accounts and a second signed-in device for one account. It verifies private-page denial, same-account synchronization, an actual offline navigation reload, durable pending replay, safe departure with pending edits, logout/account switching, and later replay under the original account. It also checks modal Tab containment, absence of fixture routes/development labels, and no horizontal overflow at 320px.

The second browser scenario forces actual IndexedDB read/write transactions to fail. The UI blocks leaving without export, Escape returns to the editor, and an expired server session hides the previous editor while preserving its in-memory draft. The downloaded binary recovery state contains that draft and its pending identity. The authentication limiter remains enabled; this failure drill obtains its real Better Auth cookie through the harness using a distinct loopback peer so the separate login scenario's five rapid sign-ins do not exhaust its budget.

The restore drill creates uniquely named source/target databases and a restricted runtime role in local Compose, then removes them. Account signup, page creation, load and commit run with that restricted role. `pg_dump`/`pg_restore` retain exact auth/session, page, grant, binary update, receipt, version, and migration-history records. The restored session validates with the same auth secret; a duplicate batch retains its sequence and another commit advances it. Runtime DDL fails before and after restore. The drill ignores production connection variables and touches no development notes.

Inspected production-build sign-in, desktop editor, and 320px editor screenshots with synthetic notes. Header controls use the shared tokens; loading/error/recovery copy remains functional. This is not a full screen-reader or native mobile keyboard audit. The current web build emits Vite's large-chunk advisory (786.47 kB before gzip); no latency/capacity claim is made.

These checks establish the private account slice locally. Real Resend/DNS delivery, hosted HTTPS/proxy/cookie behavior, Railway runtime privileges, scheduled daily backups and volume restore remain unverified. The Docker runtime smoke used a synthetic HTTPS origin with local HTTP requests and sent no email. No Railway configuration, cloud database, public exposure, or paid infrastructure was changed. Invitations, shared membership controls, compaction, recovery import, and the full authenticated collaboration release gate remain deferred.


## 2026-10-02: Railway setup in progress

The user authorized provisioning and deployment, selecting a $5/month Kikit resource-usage target and a $20 workspace compute hard limit. Railway CLI 5.63.1 was installed and authenticated. The workspace limit was applied and read back as $20; project dollar caps are unavailable. Application autodeployment was disabled to preserve the stop/drain procedure.

The committed account slice was published in a reviewable pull request and typecheck was rerun after merging the current main instructions; it passed. Railway built its Dockerfile successfully on Linux AMD64. A PostgreSQL 18.6 service and persistent volume were provisioned in Amsterdam with no public TCP proxy. Separate migration/runtime roles were created. The first migration attempt was denied at Drizzle's `CREATE SCHEMA IF NOT EXISTS`; granting database-level `CREATE` to the migration role allowed the reviewed migrations to complete. The runtime role connected, read schema version 2, had no database/schema `CREATE` privilege, and an actual table creation was denied. This supplements the earlier local PostgreSQL 17.9 evidence.

A custom application domain was registered. At this checkpoint the CNAME had propagated; ownership TXT verification and HTTPS issuance remained pending. The sender/key, application startup, actual email login, and two-account hosted isolation/synchronization remain unverified. The CLI/API rejected scheduling daily backups with `Not Authorized`; no schedule or hosted restore has been claimed as complete. Backup scheduling is a user dashboard step until that provider authorization issue is resolved.

## 2026-10-02: First Railway application deployment

Deployed a clean Git archive of commit `9419e56` through Railway CLI. The Linux AMD64 Docker build and application deployment succeeded. Railway reported exactly one running application replica and one running PostgreSQL replica in Amsterdam, with no crashed/exited replicas. Runtime logs reported application startup on port 3001. The temporary migration service is removed; no extra application replica or public database proxy was introduced.

Custom-domain ownership and HTTPS certificates are verified. The Resend API key was initially a staged Railway variable; it was applied without triggering an automatic deployment, then the committed application snapshot was deployed. Secret values were not printed or included in the upload. No test email was sent. A read-only Resend domain query returned `restricted_api_key`; the configured key cannot inspect sender-domain verification.

Checks against the actual public HTTPS origin passed:

- Application HTML and both referenced JavaScript/CSS assets returned 200.
- Responses had `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- `/api/health` returned 200 with `{ready:true}`, confirming the runtime database/schema check.
- Anonymous `/api/session` and `/api/pages` requests returned 401.
- Anonymous WSS upgrade at `/api/sync`, with the correct origin, returned 401.
- Foreign-origin page mutation and magic-link sign-in requests returned 403.
- Development session and test-metrics routes returned 404.

Real sender-domain delivery, magic-link login and secure cookies through the hosted proxy, authenticated note creation/editing, and two-account hosted isolation/synchronization remain unverified. Earlier local account browser tests cover those application behaviors with captured email delivery; they are not evidence of real hosted email delivery. Invitations and the shared-page v1 release gate remain deferred.

The user chose to defer scheduled backups and the hosted restore drill for disposable test notes. Neither has been completed. Tested hosted recovery is required before valuable notes; this first deployment establishes no hosted recovery, availability, capacity, or latency guarantee.

The Notion planning summaries still describe accounts as unfinished and deployment as future work. Their status has not been changed during this deployment check; the repository evidence above is current.

## 2026-10-02: MAC-100 continuous integration

Added the `Quality checks` workflow for pull requests targeting `main`, pushes to `main`, and manual dispatch. Four isolated jobs run the actual typecheck/build/unit commands, PostgreSQL integration/restore, 18 fixture browser scenarios, and two authenticated production-build browser scenarios. [CI documentation](ci.md) records services, triggers, data isolation, and artifact handling.

Executed locally on macOS/Apple Silicon with Node 24.21.0, pnpm 12.5.1, Docker PostgreSQL 17.9, and Playwright 1.63.0 Chromium for this change:

- Frozen installation, typecheck, and build passed. The existing Vite large-chunk advisory remains.
- 40 fast tests passed; the 20 PostgreSQL tests were intentionally skipped in that suite. The new test verifies that CI browser diagnostics omit credentials from errors, stdout/stderr, and arbitrary attachments.
- All 20 opted-in PostgreSQL integration tests and the disposable restore/restricted-role drill passed with `CI=true`.
- All 18 fixture and two authenticated browser scenarios passed with `CI=true`, using the new reporter and separate output directories. Account tracing was disabled; email stayed captured in-process.
- actionlint 1.7.12 accepted the workflow. Action references were resolved to commit SHAs from their upstream release tags.

GitHub-hosted execution and deliberate failure/artifact drills are pending at this checkpoint. These local checks do not prove an Actions run or a merged default-branch workflow; MAC-100 remains in progress until those checks are recorded.
