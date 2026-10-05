# Milestone 1 verification

The dated records below are historical checkpoints. Later 2026-10-02 addenda distinguish local shared-page proof, recorded hosted private-account checks, and the merged readability refactor. Their conditions and remaining gates are part of the evidence.

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


## 2026-10-02: shared-page access and invitation UI

Executed in an isolated worktree with the same local Node, pnpm, PostgreSQL and Chromium versions as the private-account checks above. These results cover authenticated invitation redemption and membership controls; presence is a subsequent slice.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| Fast Vitest checks, excluding the subsequent presence slice | 45 passed; 30 opt-in PostgreSQL tests skipped |
| `pnpm test:integration` | 30 passed: 7 accounts, 7 persistence/WebSocket, 6 migrations, 10 sharing |
| `pnpm test:e2e:accounts` | 7 passed: 2 account scenarios and 5 sharing scenarios against the production Vite build |
| `COMPOSE_PROJECT_NAME=kikit pnpm test:restore` | Passed, including invitation records and restored hash lookup |
| `pnpm build` | Passed; Vite reported its existing large-chunk advisory |

The PostgreSQL sharing checks cover hashed, explicit and idempotent joins; private-page denial; editor and owner permissions; replacement/disable semantics; active socket revocation; denial of duplicate receipts after removal; explicit rejoin and receipt recovery; redemption/invalidation and handshake/removal ordering; real row-lock write/removal races; expiry; and uncertain membership mutation outcomes. An account-switch regression rejects a mismatched mounted account before creating any grant.

The sharing browser scenarios use distinct Better Auth accounts and independent contexts. They decode actual QR pixels and compare the result with the invitation URL, keep invitation secrets out of login callback URLs, require an explicit join, converge edits and list joined notes on another device. They exercise replaced/disabled links, active and offline-reload revocation, retained binary recovery with stable pending identities, failed IndexedDB writes and export-before-navigation, Escape cancellation, and a cookie account switch before joining. The account and sharing Playwright projects run serially with fresh workers so Better Auth's enabled in-memory login limiter does not leak between suites; the tests do not intercept authentication requests.

The restore drill now populates and compares `page_invitations` as well as the account and durable document records. A restored active invitation can be found by its hash, and invitation availability is retained. Runtime DDL denial and continued writes still pass. The first worktree run could not find the Compose service under its default project name; the recorded successful run explicitly selected the existing local `kikit` project.

These checks establish local authenticated shared-page access. They do not verify hosted email delivery or the Railway collaboration gate. Presence, page deletion policy, hosted sharing, scheduled backups and recovery import remain outside this checkpoint. No Railway deployment or configuration was changed.

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
- 41 fast tests passed; the 20 PostgreSQL tests were intentionally skipped in that suite. Two new tests verify credential omission from errors/output/attachments and safe diagnostics when collection fails before tests start.
- All 20 opted-in PostgreSQL integration tests and the disposable restore/restricted-role drill passed with `CI=true`.
- All 18 fixture and two authenticated browser scenarios passed with `CI=true`, using the new reporter and separate output directories. Account tracing was disabled; email stayed captured in-process.
- actionlint 1.7.12 accepted the workflow. Action references were resolved to commit SHAs from their upstream release tags.

### Hosted failure and artifact drill

[Actions run 37016917906](https://github.com/NCorbeau/kikit/actions/runs/37016917906) exercised commit `d5b4695` on the proposed merge for [PR 4](https://github.com/NCorbeau/kikit/pull/4), using Ubuntu 24.04, Node 24.21.0, PostgreSQL 17.9, and Playwright 1.63.0 Chromium. Code quality and PostgreSQL integration/restore passed. Two temporary assertions deliberately failed the independent-browser fixture scenario and the authenticated multi-device scenario; the other 17 fixture scenarios and the second account scenario passed. Both browser commands returned failure, artifact uploads succeeded, and database cleanup succeeded.

Downloaded both uploaded archives and verified their published SHA-256 digests and file allowlists. Fixture diagnostics contained a failed summary, two browser screenshots, and one trace. Account diagnostics contained a failed summary and three browser screenshots, with no trace. Inspected screenshots, the account job log, both summaries, and fixture trace streams: the account assertion's synthetic magic-link URL/session credentials were not published. Archives contained no recovery exports, dumps, or raw error-context files. Seven-day expiration was returned by GitHub.

An earlier hosted drill, [run 37016360196](https://github.com/NCorbeau/kikit/actions/runs/37016360196), verified the same boundary before refreshing two action pins to their current Node 24 runtimes. The new runtime pins passed the repeated upload/drain drill without the older Node 20 runtime warning.

The temporary failure assertions have been removed. After adding the collection-failure reporter regression, typecheck, the 41-test fast suite, actionlint, and representative fixture/account browser scenarios passed locally again.

### Restore cleanup correction

The first clean hosted run, [37017479506](https://github.com/NCorbeau/kikit/actions/runs/37017479506), passed code quality, all 20 PostgreSQL integration tests, and both complete browser suites. Its restore assertions passed, but an idle pool emitted an unhandled PostgreSQL termination error during database cleanup. The failure dumped a disposable client's connection details; the isolated CI database/volume were removed, and that run's log was deleted. No production credentials or notes were supplied to the run.

The restore harness now handles pool errors with static diagnostics, waits for actual client disconnect events after pool draining, removes databases without forced termination, and reports success only after cleanup completes. A regression runs the command with an injected secret-bearing driver error before any database connection and verifies exit code 1 without the secret in output. Typecheck and the resulting 42-test fast suite passed locally; the real restore/restricted-role drill passed three consecutive local runs.

### Successful clean hosted run

[Actions run 37018439030](https://github.com/NCorbeau/kikit/actions/runs/37018439030) passed all four jobs on the proposed merge for PR 4 at code commit `7157669`: frozen install, typecheck, build, 42 fast tests (20 database tests skipped there), all 20 opted-in PostgreSQL tests, the corrected restore/restricted-role drill, all 18 fixture browser scenarios, and both authenticated production-build browser scenarios. All database cleanup steps passed. The browser jobs used one worker without retries; the existing Vite large-chunk advisory remains. This establishes working hosted CI for the proposed change, with separate recorded failure-upload evidence above.

Merge/default-branch execution and repository rulesets requiring these checks remain separate evidence; this PR does not deploy the application or complete other v1 gates.

### Restore drill readability refactor · 2026-10-02

Extracted named setup, sign-in, page creation, restored-session/page verification, and cleanup functions in `scripts/verify-backup-restore.ts`. Session and committed-page data have explicit types; the scenario retains every restore assertion, static failure diagnostics, and client-disconnect ordering. `pnpm typecheck`, `pnpm exec vitest run scripts/verify-backup-restore.test.ts` (one failure-diagnostic regression), and `pnpm test:restore` passed locally against the existing PostgreSQL 17.9 Compose service. These are checks for the refactor; the full hosted suite above was recorded before it.

## 2026-10-02: complete local shared-page slice and transient presence

Executed in the isolated `kikit-shared-pages` worktree after rebasing onto `cb80431`, the merged CI baseline. This checkpoint supersedes the earlier sharing checkpoint's deferred-presence status. Node 24.21.0, pnpm 12.5.1, local PostgreSQL 17.9 and Playwright Chromium were used; authenticated browser scenarios served the production Vite build with captured email and the authentication limiter enabled.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 77 passed; 35 opt-in PostgreSQL checks skipped |
| `pnpm test:integration` | 35 passed: 7 accounts, 7 persistence/WebSocket, 6 migrations, 10 sharing, 5 presence |
| `pnpm test:e2e` | All 18 editor/failure/recovery scenarios passed |
| `pnpm test:e2e:accounts` | All 8 passed: 2 accounts, 5 sharing, 1 presence |
| `COMPOSE_PROJECT_NAME=kikit pnpm test:restore` | Passed with invitation hashes, exact record fingerprints, receipt reuse, continued writing and runtime DDL denial |
| `pnpm build` and `docker build -t kikit-shared-pages-check .` | Passed; Docker build used Linux ARM64 |
| `git diff origin/main --check` | Passed |

Presence tests verify authenticated identity replacement, client-ID ownership, bounded/malformed frames and rate admission, private-page and older-protocol denial, reconnect snapshots, active revocation, timers/cleanup and unchanged durable rows. A WebSocket handshake cannot join with a mounted account different from its authenticated cookie. Room overload regressions retain an in-flight document until serialized cleanup instead of destroying it during a commit. Browser-client tests cover presence delivery while durable hydration is waiting and terminal protocol errors ordered behind that hydration.

The actual two-account browser scenario checks participant indicators, title/body cursors and selections, reconnect with the same client identity, and disappearance on revocation. It compares document and invitation records before and after presence-only activity. Synthetic [desktop](screenshots/shared-presence-desktop.png) and [320px dark](screenshots/shared-presence-mobile-dark.png) screenshots were inspected; cursor labels remain within the viewport and the sharing dialog contains keyboard focus. These checks do not constitute a full screen-reader or native mobile keyboard audit.

Adding awareness exposed an empty-body reconnect regression: a cursor-only ProseMirror transaction could persist its implicit paragraph without a stable block ID before the server's committed repair. The narrow body-only metadata guard prevents that projection from entering Yjs while the shared body is empty. The existing concurrent-deletion browser scenario now passes with matching repaired IDs, subsequent durable edits and reload. Real edits and server validation remain intact. An offline navigation-cancellation regression also confirms Escape restores editing and retained drafts; terminal access denial stays locked until authorized recovery.

Editor assertions inspect ProseMirror document text rather than decoration-bearing DOM text, preserving exact content/convergence checks when cursor labels are present. Account, sharing and presence projects use fresh serial workers. No authentication request is intercepted.

The web bundle is 837.51 kB before gzip (255.06 kB gzip), with Vite's large-chunk advisory. No performance or capacity claim is made. The complete slice changes wire protocol to 2 and database schema to 3; document schema remains 1. Matching web/server deployment, migration and runtime invitation-table privileges are required. No Railway service, database or deployment was changed. Hosted email/login/private-note and sharing checks, scheduled backups/hosted restore, page deletion policy, compaction and recovery import remain separate work. These local results do not establish the hosted v1 release gate.

## 2026-10-02: recorded hosted private-account checks

This addendum reconciles previously recorded hosted checks completed at 15:42 Europe/Warsaw with the earlier deployment smoke record. Those checks used Playwright 1.63.0 / Chromium 153.0.8010.12, two authorized disposable accounts and three fresh browser contexts against the deployed private-account slice at `https://kikit.ncstudio.click`. Tests used synthetic notes and actual Resend-to-Gmail delivery, without a development identity or captured-email substitution. This documentation reconciliation did not rerun the hosted checks.

- Three real magic-link emails arrived and completed sign-in. The received messages reported SPF, DKIM and DMARC pass.
- Issued session cookies were Secure, HttpOnly, SameSite=Lax and Path=/, with seven-day lifetimes. Foreign-origin logout returned 403 without ending the session. Real logout returned 200, closed an active socket with ACCESS_DENIED/1008 and made the old cookie fail private HTTP and WSS requests with 401.
- Private-note creation/reopening and same-account bidirectional synchronization passed. An actual offline shell reload retained a locally saved draft with device-only status; reconnect replay reached the independent peer and drained pending work through durable acknowledgement.
- Two distinct accounts had isolated listings/journals, reciprocal private-page HTTP denial and authenticated WebSocket ACCESS_DENIED/1008 without document state. Account switching did not reveal the former account's note.
- Logout hid the editor while retaining one pending batch and binary recovery export. Returning to the original account replayed it to pending-count zero and the independent peer. The switching/return phases reused only the disposable cookies in memory after the three real email logins.

All three test sessions were signed out and rejected replay with 401; isolated browser contexts and transient sign-in files were removed. No application, deployment or infrastructure change was part of these checks. They establish hosted private-account behavior under the recorded conditions, not hosted invitations/shared pages, backup restoration, broader browser support or performance.

Natural hosted renewal after one day and expiry after seven days have not been observed. Cookie issuance metadata and earlier local timestamp tests do not prove those hosted transitions. Shared-page rollout/verification and scheduled backups/hosted restore remain open; no hosted v1 release or tested recovery guarantee is claimed.

## 2026-10-02: merged app-wide readability refactor

[Sharing UI #6](https://github.com/NCorbeau/kikit/pull/6), [presence #7](https://github.com/NCorbeau/kikit/pull/7), and [readability #9](https://github.com/NCorbeau/kikit/pull/9) are merged. PR #9's rebased head is `690c854`; the main merge is `61933fe`. It contains five focused commits addressing all 14 actionable findings from the delegated runtime readability review. Independent final reviews found no material regressions.

The refactor separates auth/account HTTP handlers from server ownership/admission/shutdown, names socket and locked sharing/receipt phases, makes browser transport and editing-permission transitions explicit, separates dialog mutation state/confirmation/focus responsibilities, extracts participant cursor plugins, and clarifies route/workspace composition. The earlier four requested WorkspaceEditor, presence, sync-room and caret-label refactors are included through PRs #6/#7. Public behavior, transaction/lock ordering, draft recovery, invitation-secret lifetime and plugin order remain intact; no dependencies or document/protocol/database versions changed.

Before rebasing, local checks at `f3b0aab` passed typecheck, 77 fast tests, all 35 opted-in PostgreSQL tests, 18 editor/failure/recovery browser scenarios, all 8 authenticated production-build account/sharing/presence scenarios and the local restore/restricted-role drill. The production build passed with Vite's existing large-chunk advisory. These are refactor checks; the earlier feature Docker build above predates the refactor.

The rebase onto merged main retained an identical tracked tree and unchanged patches for all five commits. [PR Actions run 37031902227](https://github.com/NCorbeau/kikit/actions/runs/37031902227) passed all four code-quality, PostgreSQL/restore and browser jobs for the rebased PR. [The previous head's dispatch](https://github.com/NCorbeau/kikit/actions/runs/37029677220) also passed all four. Tests use disposable data and captured email; GitHub-hosted CI is distinct from Railway verification.

No application checks were rerun locally for this documentation-only reconciliation. The normal PR workflow still runs its code-quality, PostgreSQL/restore and browser jobs; those results are recorded on [docs PR #10](https://github.com/NCorbeau/kikit/pull/10). This update records the executed evidence above and does not deploy the merged shared-page/refactor code.

## 2026-10-02: hosted shared-page rollout and two-account proof

The user authorized the sharing rollout. Deployed a clean Git archive of merged main `3353cc802b244acabb990a50d2d4dc9e4997fbe8` to [Kikit](https://kikit.ncstudio.click). Railway deployment `be9a811e-e2bd-4838-9dd4-8c23a582197a`, created at 19:13:36 Europe/Warsaw, succeeded with image digest `sha256:f952c154412aaad5c4bf398440e09b02ce5bcefe518f7fefb485ffe061556242`. The production Dockerfile serves matching web/server assets: wire protocol 2, document schema 1, database schema 3. No application source changed for this rollout.

### Migration and deployment conditions

Retained the existing PostgreSQL service and volume, private database networking, Amsterdam region, and one active application instance. The previous deployment was stopped; Railway reported its instance exited. A temporary migration job waited for, then acquired, the application ownership advisory lock before changing the schema. It ran the reviewed migrations as the existing migration owner and granted the restricted runtime role invitation-table DML. Administrative credentials were confined to that temporary job, outside the application process.

The job verified schema 3, migration ownership of `page_invitations`, unchanged counts and content fingerprints across the migration for all eight existing account/page/grant/update/receipt tables, and actual runtime `CREATE TABLE` denial. Runtime database/schema creation privileges remained absent. It exited successfully and was removed, including its variables. An initial temporary-job configuration attempt failed before migration; the corrected job ran in Amsterdam. No public database proxy or retained extra service was added. The new application started only after migration completed and the ownership connection closed.

Railway subsequently reported exactly one running application replica and one running PostgreSQL replica, with no crashed/exited active replicas. Application logs reported startup on port 3001. The existing 30-second drain setting, zero overlap and `/api/health` check were retained. The workspace hard limit was read back as $20 before and after rollout; no plan, budget limit, email provider or backup policy changed. There was a brief stop/build/start outage; this is not an availability or deployment-duration guarantee.

### Fresh local checks for the deployed tree

Executed on macOS/Apple Silicon with Node 24.21.0, pnpm 12.5.1, local PostgreSQL 17.9, and Playwright 1.63.0 Chromium. Database/browser suites ran sequentially against the disposable local test database.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 77 passed; 35 opt-in PostgreSQL checks skipped |
| `pnpm build` | Passed; existing Vite large-chunk advisory, 840.00 kB before gzip |
| `pnpm test:integration` | All 35 passed |
| `pnpm test:e2e:accounts` | All 8 account/sharing/presence scenarios passed |
| `pnpm test:e2e` | All 18 editor/failure/recovery scenarios passed |
| `COMPOSE_PROJECT_NAME=kikit pnpm test:restore` | Passed: account/session/invitation records, exact binary/receipt identity, continued writes, runtime DDL denial |

These are newly executed local checks, distinct from previous CI and the hosted checks below. The local restore drill does not establish Railway restoration. The fixture suite logged a transient Vite WebSocket EPIPE during its disconnect scenario; all assertions passed.

### Fresh hosted checks

Completed at approximately 19:22 Europe/Warsaw against the actual HTTPS/WSS origin using Playwright 1.63.0 / Chromium 153.0.8010.12, two disposable Better Auth accounts and three independent browser contexts: one owner and two separately authenticated devices for the editor. Three actual Resend-to-Gmail links delivered at 19:16:15, 19:16:16 and 19:16:45 completed sign-in. No captured-email harness, authentication interception or development identity was used. Session values, invitation tokens and recovery bytes stayed outside public evidence.

| Hosted behavior | Observed result |
| --- | --- |
| HTTPS/assets/schema and anonymous boundaries | App shell and both referenced assets returned 200; health returned `ready:true`; anonymous session/listing/WSS returned 401; fixture/test routes returned 404; foreign-origin mutation/authentication returned 403. |
| Secure sessions | All three contexts received Secure, HttpOnly, SameSite=Lax session cookies; account identities distinguished the owner from the editor and matched the editor's two devices. |
| Invitation link and QR | Owner created the link through Share; decoded QR pixels matched the same HTTPS fragment URL. Opening it sent no redemption and still returned page-session 403 until explicit Join note. |
| Membership and permissions | Editor and owner duplicate joins returned the same page; subsequent sharing state contained exactly one owner and one editor. Editor sharing/read-management, invitation create/disable and owner-removal requests returned 403; Share was absent from the editor UI. |
| Cross-device collaboration | The joined note appeared on the editor's independent second device. Concurrent owner/editor edits reached all three contexts, durable acknowledgement frames were observed, and reload retained the merged content. |
| Private-page isolation | The editor's private-page HTTP request returned 403. An authenticated protocol-2 private-page socket received ACCESS_DENIED, closed with 1008, and delivered no content or presence. |
| Invitation invalidation | Owner replacement and disable UI actions made the previous tokens return 410 while the existing editor's access and edits remained valid. |
| Active revocation | Owner removal hid the connected editor, delivered ACCESS_DENIED, denied further page access with 403, and removed its presence. |
| Offline revocation and recovery | The editor's second device saved two offline batches and reloaded offline with both draft additions. Escape from voluntary navigation restored editing. After removal and reconnect the editor was hidden; binary recovery contained both additions and exactly the previously stored batch IDs. The owner's document excluded those drafts while access was revoked. |
| Explicit rejoin and replay | The removed editor explicitly rejoined through a valid invitation; the same two batch IDs received acknowledgements, both additions reached the owner, and reload reported Saved to server with pending count zero. The editor's other device could reopen the rejoined note. |
| Presence/cursors | Participant indicators tracked authenticated devices. Title/body cursors and selections moved between fragments; cursor-only activity produced no additional edit acknowledgements. Disconnect/reconnect removed/restored presence. |
| Visual check | Inspected desktop and 320px dark screenshots with synthetic notes; no horizontal overflow at 320px. Screenshots remain in ignored local artifacts because participant labels contain test addresses. This is not a full accessibility or native mobile keyboard audit. |

A temporary-harness assertion initially assumed one participant entry per account; two editor devices correctly produced two entries. The assertion was corrected to count devices and the remaining checks completed. The offline revoked device was denied by HTTP hydration before opening a new socket, so its evidence is editor hiding/403/recovery rather than an observed socket error frame. No application defect or code change was needed.

Cleanup disabled the test invitation, removed its editor membership, signed out all three sessions, and verified that replaying each old cookie returned 401. The isolated browser closed; recovery downloads were removed and in-memory recovery was discarded. Two new synthetic notes remain because note deletion is not implemented. The user's primary session and real notes were untouched by the test flow.

This completes the hosted sharing rollout/proof tracked by MAC-115 under these conditions. Natural hosted session renewal/expiry, deletion/retention policy, scheduled backups and hosted restore, wider failure/browser/accessibility checks, performance, recovery import and compaction remain separate work. Disposable test-note use still has no tested hosted recovery guarantee; this checkpoint does not declare the entire v1 release complete.

## 2026-10-04: locally implemented flat to-do lists

The user approved simple checkbox lists inside notes and then authorized implementation with agents followed by review. This slice was implemented on main baseline `e22fe79` in the uncommitted working tree. Independent editor/schema reviews found no remaining actionable defects. Existing layout and workspace-navigation changes were preserved; the checks below exercised the combined working tree. No commit, merge or deployment was performed.

Executed on macOS/Apple Silicon with Node 24.21.0, pnpm 12.5.1, local PostgreSQL 17.9 and Playwright 1.63.0 / Chromium. Database and browser suites ran sequentially with disposable local data. The authenticated suite served production assets and used distinct Better Auth accounts with captured magic-link delivery; this is separate from actual hosted email and Railway proof.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 106 passed; 38 opt-in PostgreSQL checks skipped |
| `pnpm test:integration` | All 38 passed: 7 accounts, 9 persistence/WebSocket, 7 migrations, 10 sharing, 5 presence |
| `pnpm test:e2e` | All 22 editor/failure/recovery scenarios passed |
| `pnpm test:e2e:accounts` | All 9 passed: 2 accounts, 6 sharing, 1 presence |
| `COMPOSE_PROJECT_NAME=kikit pnpm test:restore` | Passed, including checked-task restoration, exact record fingerprints, receipt replay, continued writes and runtime DDL denial |
| `pnpm build` | Passed; 870.71 kB before gzip, 265.64 kB gzip, existing Vite large-chunk advisory |
| `git diff --check` | Passed |

Task validation checks accept only flat lists with stable IDs, boolean checked state and one plain-text paragraph per item. They reject nesting, marks, extra attributes and malformed containers. Migration checks preserve initial document bytes, binary updates, receipts and existing account/access records while advancing document metadata to schema 2 and database compatibility to 4; wire protocol remains 2. Browser cache tests retain legacy journal bytes, insertion order, pending flags and batch identities, including upgrade failures, concurrent-tab writes, stale schema-1 writers and readable recovery when storage writes are denied.

Browser checks cover selected-block conversion with retained text IDs, typing shortcuts, keyboard checkbox activation/focus, split/merge, empty-item exit, paragraph/heading conversion, pasted checked state with fresh IDs, local toggle undo and lost-acknowledgement receipt reuse. Two distinct authenticated collaborators retain simultaneous text edits and checkbox updates; local undo preserves the peer's text. A real offline shell reload preserves checked state, text and original pending identities, then reconnects to exactly one receipt per pending batch.

Concurrent offline deletion of all task items exposed two editor-binding behaviors: strict client cardinality discarded empty CRDT wrappers, and Tiptap's local select-all clearing also ran on committed remote repair. Transient empty-container support and remote clearing metadata now retain the shared list until its durable server repair. The regression verifies matching repaired IDs, cursor-only activity, native clicking/typing in the repaired empty task, subsequent edits from both peers, reload and a drained journal. Task-first hydration also resolves invalid initial text-selection endpoints; native title-to-body Tab and immediate typing preserve the original checked task after reload.

The first authenticated run stopped at a test-only recovery-download selector: it used the blocked-screen button name while the live editor was open. Correcting only that selector produced a full nine-scenario passing rerun. The fixture suite logged expected disconnect proxy errors and an upstream initial TextSelection warning; the selection is corrected before user editing, and all caret/recovery assertions passed. These logs are not a durable-save failure.

Inspected synthetic light/dark desktop and 320px dark screenshots from the passing editor run. Checkboxes and wrapped text stay aligned, and the 320px viewport has no horizontal overflow. Screenshots remain in ignored local `.artifacts/task-lists/`. This is Chromium evidence rather than a full screen-reader, native IME, mobile-keyboard or cross-browser audit.

The [task-list contract](task-lists-contract.md) records the implementation and upgrade boundaries. The normal development database was not migrated by these checks. Run the new migration before starting matching local assets; hosted rollout requires separate authorization, stopping/draining the old server and matching new assets. The recorded hosted build above remains document schema 1/database schema 3. Hosted task-list checks, broader accessibility/browser evidence, performance and the existing unreleased recovery/backup gates remain separate work.

### PR preparation on 2026-10-04

Prepared `dev/flat-todo-lists` and rebased it onto main `121ecb8`, which already contains the separate mobile-spacing and saved-note-navigation changes. The remaining local account-panel styling is excluded from this feature commit. An isolated export of the PR tree passed typecheck, all 106 fast tests, build and both full browser suites (22 editor scenarios and nine authenticated scenarios). The build is 870.71 kB before gzip/265.64 kB gzip with the existing chunk advisory. PostgreSQL integration and restore results above were not rerun for PR preparation; their source and migration content are unchanged. The earlier uncommitted checkpoint remains historical evidence. No merge or deployment is part of PR preparation.


## 2026-10-05: Deployment command, local verification

Added `pnpm run deploy` with a committed Git archive, explicit Railway project/environment/service targets, local deployment locking, stop/removal polling, a separate ownership-locked migration job, exact-deployment completion polling and public health verification. Migration failure prevents app deployment; timeout does not cancel a remote operation. Configuration and one-time idle migration-service setup are documented in `docs/deployment.md`. Migration credentials remain outside the app process.

Current local checks passed: `pnpm typecheck`, `pnpm test` (121 passed; 38 PostgreSQL checks skipped), `pnpm build`, and 15 focused deployment checks. The focused checks include a fake-CLI subprocess using a temporary Git repository, verifying explicit targets, committed-only uploads, exclusion of ignored credentials/configuration, dirty-tree refusal, migration failure/startup-only status, old-deployment removal and unavailable health. CLI 5.63.1 help/source confirmed the flags and JSON output used. The existing Vite large-chunk advisory remains.

No Railway service was provisioned or modified, no production migration/deployment ran, and no hosted validation is claimed. PostgreSQL/browser/restore suites were not rerun for this change. The new migration entry point reuses the existing ownership lock and migration runner; its real hosted execution remains pending. Existing uncommitted web styling was preserved.

### Deployment readability follow-up · 2026-10-05

Separated the command entry point, local configuration/Git archive/lock lifetime, Railway CLI/HTTP operations, and deployment sequencing into focused modules under `scripts/deployment`. The release workflow reads as preflight, stop, migrate, deploy and verify health. Existing failure/status guards and command arguments remain in place; cleanup now uses separate `finally` blocks for the snapshot and local lock. The fake-CLI test copies the modules into its isolated repository. Fresh `pnpm typecheck`, all 15 focused deployment checks and `git diff --check` passed. The full test/build results above predate this refactor; no production or database/browser/restore checks were run for it.

## 2026-10-05: MAC-147 note header cleanup, local verification

Implemented in the isolated `dev/mac-147-note-header` worktree based on main `d9de585`. The header has explicit **All notes** navigation and one native popover for sharing, binary recovery download, appearance and sign-out. Routine save/connection labels are hidden until **Show sync details** is enabled; the preference is remembered independently of the note journal. Offline, save-failure and access-loss recovery remain visible. The existing uncommitted account-panel CSS in the original working tree is excluded.

Fresh local checks used Node 24, pnpm 12.5.1, Playwright 1.63.0/Chromium and the existing loopback PostgreSQL 17.9 test service. Browser suites ran sequentially against isolated `kikit_e2e`; authenticated scenarios used real Better Auth sessions, production assets and captured synthetic email delivery.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm test` | 121 passed; 38 PostgreSQL integration checks skipped |
| `pnpm build` | Passed; existing large-chunk advisory remains |
| `pnpm test:e2e` | All 23 editor/failure/recovery scenarios passed |
| `pnpm test:e2e:accounts` | All nine account/sharing/presence scenarios passed |
| `git diff --check` | Passed |

Coverage includes a quiet default header, keyboard opening/Tab/Escape, outside dismissal, diagnostic persistence and unavailable preference storage, light/dark switching without losing editor undo, offline notices with diagnostics off, guarded navigation/sign-out, recovery downloads and sharing permissions. Closing sharing or cancelling sign-out restores focus to the visible menu trigger. The dialog lifecycle now closes/restores focus during layout cleanup, before React removes its DOM. Save assertions explicitly enable UI diagnostics and continue to require durable server confirmation; connection alone is never treated as a save.

An initial browser run exposed a menu-helper mount/toggle race and the dialog focus loss; both were corrected before the full passing runs above. The checkbox lost-acknowledgement scenario now clears inherited task content using native select-all/delete before typing its setup, and asserts the resulting document text. Its checked-state, batch-count, stable-identity and reload assertions remain intact. The fixture suite still reports upstream initial task-list selection warnings and expected disconnect proxy errors during failure scenarios.

Inspected synthetic light desktop and 320px dark note-menu screenshots under ignored `.artifacts/`, plus the fixture menu screenshots in `test-results/fixture/`. The return control, menu labels and focus behavior remain usable without horizontal overflow. This is Chromium verification, not a full screen-reader, native mobile keyboard or cross-browser audit.

No backend, dependency, document/protocol/database version or durability contract changed. Standalone PostgreSQL integration and backup/restore checks were not rerun for this UI slice; the browser suites exercised the actual backend/database. This checkpoint is worktree implementation evidence, not a merge or hosted deployment.
