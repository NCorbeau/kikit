# Kikit

**A quiet place to write. A shared page when you need one.**

Kikit is a small, local-first notes app built around a simple block editor. Its goal is to make writing feel immediate, keep your work safe through connection changes, and let people work together on the same page.

**Status: shared pages merged and verified locally; private accounts verified on Railway.** Invitation links/QR joins, owner-only controls, active/offline revocation with recoverable drafts, and transient participants/cursors are implemented. Recorded hosted checks on 2026-10-02 passed real email login, secure cookies, private editing/synchronization, cross-account isolation, and logout recovery. Hosted session renewal/expiry, shared-page rollout, backups and restore remain open. The latest recorded deployment is the private-account slice in Amsterdam; merging code does not deploy it. See [dated evidence and conditions](docs/verification.md). This is not the complete v1 release.

![Typing in two independent Kikit windows, with edits synchronizing in both directions](docs/demos/live-sync.gif)

Two independent browser sessions editing the same page through the local backend and PostgreSQL, recorded at normal speed. [MP4 version](docs/demos/live-sync.mp4).

## Run locally

Requirements: Node.js 24+, pnpm 12.5.1, Docker with Compose, and a current Chromium-based browser. No cloud services or paid infrastructure are needed.

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Use this exact origin; the backend verifies WebSocket origins. Open a second browser profile or incognito window to see independent browser storage synchronizing through the server. The development page is seeded once by the idempotent migration command.

`pnpm dev` starts Vite on loopback port 5173 and Fastify on loopback port 3001. Vite proxies `/api`, including WebSockets. PostgreSQL 17.9 runs on loopback port 54329, with its data in the `kikit-postgres` Compose volume. `pnpm db:down` stops PostgreSQL and retains the volume. Ctrl-C stops the development processes.

The Compose username/password are deliberately public local fixture values. They are not production credentials. The local default database URL is `postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit`. Server commands accept an exported `DATABASE_URL`; `PORT` and `KIKIT_ORIGIN` override the server port and exact loopback browser origin. `KIKIT_API_TARGET` overrides Vite's proxy target. Environment files are not loaded automatically by the server.

## Database changes

The backend uses [Drizzle ORM](https://orm.drizzle.team/docs) for typed queries over the existing `pg` driver. Table definitions live in `apps/server/src/schema.ts`; SQL migrations and their generated snapshots live in `apps/server/migrations`.

To change the schema, edit the table definitions, generate a migration, review its SQL, then apply it:

```sh
pnpm db:generate --name describe_change
pnpm db:migrate
```

Commit the SQL file and generated `meta/` files together. Add a new migration for subsequent changes; never edit an applied file. The runner uses Drizzle's migration history, verifies recorded checksums, and locks migration admission so concurrent runs cannot apply the same file twice. Pending SQL and its history entries commit together; failed migrations roll back. The initial baseline adopts the original milestone's local schema without replacing stored notes or receipts.

`pnpm db:migrate` applies schema migrations, then invokes a separate, explicitly development-only seed. Repeated seeding retains the page's original binary identity. The server does not migrate on startup. `pnpm db:migrate:production` requires a separately supplied `KIKIT_MIGRATION_DATABASE_URL` and never seeds the fixture. The workflow supports transactional, forward migrations; operations that must run outside a transaction are deferred. See [deployment and database privileges](docs/deployment.md).

## Account application

The production server serves the built web app, authentication HTTP routes, and custom WebSocket sync from one origin. Root `pnpm start` supplies the start command missing from the original Railway build. The root Dockerfile pins the supported Node/pnpm setup and includes runtime dependencies and built assets.

Use [the deployment guide](docs/deployment.md) for Railway settings, separate database roles, email sender verification, and restore checks. [.env.example](.env.example) lists required variables using placeholders; export them or configure provider secrets. The server does not load environment files automatically. Do not enable `KIKIT_DEV_FIXTURE` on Railway.

The [account contract](docs/accounts-contract.md) describes cookies, authorization, offline account hints, and recovery. Email delivery is substituted only inside the automated test harness; there is no public test-login or magic-link discovery endpoint.

## What works

- A collaborative page title, paragraphs, and headings at levels 1–3.
- Email magic-link accounts, a private note list, and idempotent creation of empty notes.
- Normal typing, selection, Enter/Backspace, paste, local collaborative undo/redo, heading shortcuts, labelled controls, visible keyboard focus, and a responsive writing surface.
- A compact writing UI with light/dark themes. Appearance follows the system until you choose a mode using the header toggle; your choice is remembered locally.
- Stable block IDs retained for existing blocks and regenerated for split/pasted blocks.
- One Y.Doc per page, bound directly to Tiptap. React does not own another editable copy.
- Atomic IndexedDB storage of each local binary update and its stable outbound batch ID before transmission.
- Transactional PostgreSQL updates and durable, payload-hashed idempotency receipts. Only committed receipts acknowledge pending edits.
- Independent browser sessions synchronize, reopen cached notes offline, and resend locally saved pending edits after reload or reconnect.
- Distinct device-save, server-save, connection, offline, and failure states; retry and binary recovery export.

The status menu explains local and server durability separately. **Saved on this device** means the IndexedDB transaction completed. **Saved to server** means the current session has synchronized and every pending batch has a durable receipt. Being connected alone does not establish that guarantee. A local save failure keeps unsaved work in memory and warns before leaving: keep the tab open, retry, or export recovery.

The service worker caches the app shell after an initial connected load, enabling an actual offline reload in both account and fixture modes. API responses and note contents are never put in that shell cache. Notes live in IndexedDB, namespaced by account and page. The last account and note-list metadata provide an offline hint, not server authorization. Signing out removes that hint and retains each account's journal. Browser cache eviction or clearing site data can remove locally saved work. If source/dependency changes leave a stale shell, reconnect and reload; unregister only the shell worker/cache when troubleshooting, and preserve IndexedDB.

## Shared pages

Owners can create an invitation from **Share**, copy its link or show its QR code, and disable/replace it or remove editors. Recipients sign in and explicitly choose **Join note**; opening a link alone grants nothing. Joined notes appear across devices. Disabling a link leaves members in place. To prevent a removed member from rejoining, disable the invitation before removing them. Downloaded copies cannot be recalled.

Links are shown only when generated because the server stores hashes. Later visits offer an explicit replacement. Invitations remain active until disabled/replaced. Login continuation stays in the initiating tab; if email opens elsewhere, reopen the invitation after signing in. Revoked access hides the editor while retaining drafts and binary recovery export. See [the sharing contract](docs/shared-pages-contract.md).

Authorized collaborators appear above the document with colored cursors and selections in the title and body. Presence is transient: it does not create document updates, receipts, or save acknowledgements. Disconnecting, signing out, or removing membership clears it. Sharing uses database schema 3 and wire protocol 2; matching web/server versions must be deployed together.

## Development identity boundary

The fixture has exactly one explicit local identity and seeded page. `pnpm dev` and `pnpm db:migrate` opt into it using `NODE_ENV=development KIKIT_DEV_FIXTURE=1`. Production refuses the fixture flag; without it, the server uses real account configuration. HTTP/WS fixture access is loopback-restricted and the WebSocket requires the configured Origin. The production frontend build refuses to initialize a fixture session.

Fixture page access is checked separately through PostgreSQL grants on handshake and each transaction. This exercises the integration boundary; it is **not authentication**, and two development browser contexts are not two authenticated accounts. Account mode validates Better Auth sessions and independently checks page grants. Account mode implements authenticated invitation redemption and owner/editor management; the fixture cannot use these routes. Do not publish or proxy the development fixture to the Internet.

## Architecture and edit flow

| Module | Responsibility |
| --- | --- |
| `apps/web/src/App.tsx` and `components/DocumentPage.tsx` | Account/route composition and document loading, offline, and recovery UI |
| `apps/web/src/session/useDocumentSession.ts` | Stable React session ownership, subscription, and cleanup |
| `apps/web/src/session/useRecoveryDownload.ts` | Recovery file download and actionable download errors |
| `apps/web/src/theme.ts` and `theme.css` | System/user appearance preference and shared light/dark color tokens |
| `apps/web/src/editor` | Tiptap/ProseMirror schema, Yjs bindings, keyboard behavior, block IDs, participant cursor plugins and caret geometry |
| `apps/web/src/session/local-store.ts` | Typed `idb` transactions for account/page history and the durable outbound journal |
| `apps/web/src/session/index.ts` | Hydration, local persistence, pending batches, truthful state and recovery |
| `apps/web/src/account` | Account lifetime, sign-in, note list and workspace composition; `useWorkspaceExit` owns guarded departure/recovery, with focused leave/recovery views |
| `apps/web/src/sharing` | Explicit join routes and account-bound requests; dialog-scoped invitation/mutation state, confirmation copy and modal focus handling |
| `apps/web/src/session/sync-client.ts` | Authorized page handshake, WebSocket transport, ordered messages and reconnection |
| `apps/server/src/app.ts` | Same-origin server wiring, static assets, connection admission and shutdown |
| `apps/server/src/auth-routes.ts` and `account-routes.ts` | Request identity validation, auth forwarding/revalidation and account/page HTTP handlers |
| `apps/server/src/auth.ts` and `pages.ts` | Better Auth/email integration, session locks, private page creation and access |
| `apps/server/src/sharing-routes.ts` and `sharing.ts` | Authorized queued sharing actions, locked owner/grant/invitation checks and membership transactions |
| `apps/server/src/sync-connection.ts` | Socket lifetime, handshake and incoming message validation |
| `apps/server/src/sync-room.ts` | Page rooms, serialized commit/application, propagation and recovery |
| `apps/server/src/sync-protocol.ts` | Bounded outgoing messages and protocol error mapping |
| `apps/server/src/presence.ts` | Transient frame validation, authenticated identity, client-ID ownership, rate bounds and awareness lifetime |
| `apps/server/src/queue.ts` | Bounded per-page sequencing and shutdown admission |
| `apps/server/src/persistence.ts` | Page access locks, document loading, transactions and receipts |
| `apps/server/src/schema.ts` | Drizzle table definitions and binary column types |
| `apps/server/migrations` | Reviewed SQL migration files and generated metadata |
| `apps/server/src/migrations.ts` | Migration lock, history verification, and Drizzle runner |
| `apps/server/src/development-seed.ts` | Explicit development-only, idempotent page seed |
| `packages/contracts` | Versioned wire messages, constants and binary encoding |

1. The editor changes its Y.Doc immediately.
2. IndexedDB atomically records the update and pending identity in insertion order.
3. The client sends one journal entry at a time and waits for its acknowledgement.
4. A per-page queue validates access/content and commits the update and receipt in one PostgreSQL transaction.
5. The server applies committed bytes to its room, schedules peer propagation, then acknowledges the original batch.
6. The client marks that journal record acknowledged, retaining its document bytes. Lost acknowledgements retry the same identity and bytes.

Reconnect uses a full committed Yjs state handshake. It does not clear pending batches. A reused batch identity with different bytes is rejected. If concurrent deletions remove every body block, the server commits one empty paragraph with the edit and returns that same repair on retries. Any uncertain database commit or room-application failure invalidates the room; connected clients reload committed state and resolve pending outcomes through receipts. No separate REST content-save path exists.

See [the concrete protocol and persistence contract](docs/milestone-contract.md) and [verification evidence](docs/verification.md). [AGENTS.md](AGENTS.md) records project-wide invariants and scope.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:integration
pnpm test:e2e:accounts
pnpm test:restore
```

Run `pnpm db:up` before the integration/browser suites. They use a separate local `kikit_e2e` database. **The fixture browser suite resets that database's public schema**, starts its own backend on 3002 and Vite on 5174, and uses fresh independent browser contexts. The account suite serves the production build on 5198 with actual Better Auth sessions and captured test emails. Neither suite resets `kikit`. Do not run the browser and PostgreSQL integration suites concurrently. The restore drill creates and removes uniquely named local databases and a restricted runtime role; it ignores production connection variables.

`pnpm test` runs fast Vitest checks; PostgreSQL integration tests are explicitly skipped there. `pnpm test:integration` opts into the real database checks. Browser coverage includes concurrent edits, offline reload/reconnect, duplicate IDs, lost acknowledgements, uncertain COMMIT outcomes, restart, a real PostgreSQL write-failure trigger, keyboard split/merge, paste IDs, collaborative undo, composition events and access/version/origin denial. These tests use the real backend and PostgreSQL, without substituting browser-local message passing.

Test fault/metrics routes only exist with `NODE_ENV=test` **and** `KIKIT_TEST_FAULTS=1`, and require loopback. They are absent from development routes. Failure screenshots and traces go to ignored `test-results/fixture/` and `test-results/accounts/`.

The [GitHub Actions workflow](.github/workflows/quality.yml) runs code quality, PostgreSQL integration/restore, and separate fixture/account browser checks for pull requests and `main`. CI uses disposable databases and synthetic notes. Failed browser runs retain summaries/screenshots for seven days; only fixture runs upload traces, keeping account login URLs and cookies out of artifacts. See [CI behavior and diagnostics](docs/ci.md) and [dated verification](docs/verification.md).

## Current limits and next milestone

- One active account server, private notes and authenticated shared pages. PostgreSQL does not coordinate in-memory rooms across replicas. An ownership lock rejects a second account server; deployments require stopping and draining the old instance first.
- Plain text paragraphs/headings only: no marks, lists, attachments, comments, drag reordering, or advanced blocks.
- Full-state handshakes and retained binary update histories; no snapshot compaction/pruning. Updates are limited to 256 KiB and committed documents to 2 MiB. These are guardrails, not measured capacity claims.
- Queues admit at most 64 operations/8 MiB per page and 256 operations/32 MiB globally, including running work. At most 128 sockets; each socket has a 4 MiB outbound budget. Overload leaves uncommitted edits pending.
- PostgreSQL applies 5-second statement, 2-second lock, and 15-second transaction limits. Queue ownership stays with an operation until completion/rollback. Shutdown stops admission, rejects queued work, and waits for active operations; a network blackhole can still delay shutdown. No deployment deadline or production availability target is claimed.
- Binary recovery export has no import UI yet. The local backup/restore and restricted-role drill is automated. Hosted runtime privileges are verified; backups and hosted restoration remain deferred until before valuable notes. No performance capacity study, full screen-reader audit, or native IME/browser compatibility matrix has been completed.
- The Docker image serves the production bundle. Hosted private-account login, editing/isolation and logout recovery have dated evidence; natural session renewal/expiry and hosted sharing remain unverified. The editor bundle produces Vite's large-chunk advisory.

The next release gates are hosted renewal/expiry, shared-page rollout and two-account hosted collaboration, and tested hosted backups before valuable notes. Page deletion awaits its retention/recovery policy. The locally verified sharing slice does not establish hosted sharing or complete v1 readiness.

The selected initial setup is Railway Hobby in Amsterdam, a $5/month Kikit target before tax and an authorized $20 workspace compute limit, Resend Free, with scheduled backups deferred for disposable test notes. Tested backups and restoration are required before valuable notes. The recorded private-account deployment and verification do not include the later shared-page migration/assets. See [deployment](docs/deployment.md) for rollout and recovery limits.

## License

[MIT](LICENSE) © 2026 Maciej Głownia.
