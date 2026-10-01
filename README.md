# Kikit

**A quiet place to write. A shared page when you need one.**

Kikit is a small, local-first notes app built around a simple block editor. Its goal is to make writing feel immediate, keep your work safe through connection changes, and let people work together on the same page.

**Status: first local development milestone.** The editor, browser journal, custom WebSocket synchronization, PostgreSQL persistence, and failure/recovery tests work locally. Real accounts, invitations, production authorization, hosting, and backups are subsequent work. This is not ready for valuable or private notes.

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

`pnpm db:migrate` applies schema migrations, then invokes a separate, explicitly development-only seed. Repeated seeding retains the page's original binary identity. The server does not migrate on startup. This workflow currently supports transactional, forward migrations; operations that must run outside a transaction and production migration privileges remain future work.

## What works

- A collaborative page title, paragraphs, and headings at levels 1–3.
- Normal typing, selection, Enter/Backspace, paste, local collaborative undo/redo, heading shortcuts, labelled controls, visible keyboard focus, and a responsive writing surface.
- Stable block IDs retained for existing blocks and regenerated for split/pasted blocks.
- One Y.Doc per page, bound directly to Tiptap. React does not own another editable copy.
- Atomic IndexedDB storage of each local binary update and its stable outbound batch ID before transmission.
- Transactional PostgreSQL updates and durable, payload-hashed idempotency receipts. Only committed receipts acknowledge pending edits.
- Independent browser sessions synchronize, reopen cached notes offline, and resend locally saved pending edits after reload or reconnect.
- Distinct device-save, server-save, connection, offline, and failure states; retry and binary recovery export.

The status menu explains local and server durability separately. **Saved on this device** means the IndexedDB transaction completed. **Saved to server** means the current session has synchronized and every pending batch has a durable receipt. Being connected alone does not establish that guarantee. A local save failure keeps unsaved work in memory and warns before leaving: keep the tab open, retry, or export recovery.

The development-only service worker caches the app shell after an initial connected load, enabling an actual offline reload. API responses and note contents are never put in that shell cache. Notes live in IndexedDB, namespaced by fixture account and page. Browser cache eviction or clearing site data can remove locally saved work. If source/dependency changes leave a stale development shell, reconnect and reload; unregister only the shell worker/cache when troubleshooting, and preserve IndexedDB.

## Development identity boundary

This milestone has exactly one explicit local identity and seeded page. `pnpm dev` and `pnpm db:migrate` opt into it using `NODE_ENV=development KIKIT_DEV_FIXTURE=1`. Backend creation refuses all other modes, including production even when the fixture flag is set. HTTP/WS fixture access is loopback-restricted and the WebSocket requires the configured Origin. The production frontend build refuses to initialize a fixture session.

Page access is checked separately through PostgreSQL grants on handshake and each transaction. This exercises the integration boundary; it is **not authentication**, and two development browser contexts are not two authenticated accounts. Better Auth sessions, cookie/CSRF policy, active connection revocation, account switching, invitation redemption, and owner/editor controls are not implemented. Do not publish or proxy this development fixture to the Internet.

## Architecture and edit flow

| Module | Responsibility |
| --- | --- |
| `apps/web/src/editor` | Tiptap/ProseMirror schema, Yjs bindings, keyboard behavior, block IDs |
| `apps/web/src/session/local-store.ts` | Account/page IndexedDB update history and ordered durable outbound journal |
| `apps/web/src/session/index.ts` | Hydration, local persistence, pending batches, truthful state and recovery |
| `apps/web/src/session/sync-client.ts` | Fixture handshake, WebSocket transport, ordered messages and reconnection |
| `apps/server/src/app.ts` | Server wiring, development routes, connection admission and shutdown |
| `apps/server/src/sync-connection.ts` | Socket lifetime, handshake and incoming message validation |
| `apps/server/src/sync-room.ts` | Page rooms, serialized commit/application, propagation and recovery |
| `apps/server/src/sync-protocol.ts` | Bounded outgoing messages and protocol error mapping |
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
```

Run `pnpm db:up` before the integration/browser suites. They use a separate local `kikit_e2e` database. **The browser suite resets that database's public schema**, starts its own backend on 3002 and Vite on 5174, and uses fresh independent browser contexts. It never resets `kikit`. Do not run the browser and PostgreSQL integration suites concurrently.

`pnpm test` runs fast Vitest checks; PostgreSQL integration tests are explicitly skipped there. `pnpm test:integration` opts into the real database checks. Browser coverage includes concurrent edits, offline reload/reconnect, duplicate IDs, lost acknowledgements, uncertain COMMIT outcomes, restart, a real PostgreSQL write-failure trigger, keyboard split/merge, paste IDs, collaborative undo, composition events and access/version/origin denial. These tests use the real backend and PostgreSQL, without substituting browser-local message passing.

Test fault/metrics routes only exist with `NODE_ENV=test` **and** `KIKIT_TEST_FAULTS=1`, and require loopback. They are absent from development routes. Failure screenshots and traces go to ignored `test-results/`.

## Current limits and next milestone

- One active server instance, one fixture page, no page list or real accounts. PostgreSQL does not coordinate in-memory rooms across replicas.
- Plain text paragraphs/headings only: no marks, lists, attachments, presence, comments, drag reordering, or advanced blocks.
- Full-state handshakes and retained binary update histories; no snapshot compaction/pruning. Updates are limited to 256 KiB and committed documents to 2 MiB. These are guardrails, not measured capacity claims.
- Queues admit at most 64 operations/8 MiB per page and 256 operations/32 MiB globally, including running work. At most 128 sockets; each socket has a 4 MiB outbound budget. Overload leaves uncommitted edits pending.
- PostgreSQL applies 5-second statement, 2-second lock, and 15-second transaction limits. Queue ownership stays with an operation until completion/rollback. Shutdown stops admission, rejects queued work, and waits for active operations; a network blackhole can still delay shutdown. No deployment deadline or production availability target is claimed.
- Binary recovery export has no import UI yet. No production backups/restore policy, migration-role separation, performance capacity study, full screen-reader audit, or native IME/browser compatibility matrix has been completed.
- `pnpm build` verifies bundling; it is not a runnable production release. The initial editor bundle currently produces Vite's large-chunk advisory.

The recommended next milestone is real Better Auth login with account-scoped pages and enforced owner/editor access, including session expiry/revocation and recovery across account switches. Select the initial login method before that work. Then add invitations and verify collaboration with two distinct authenticated accounts.

Public deployment, Railway plan/region/budget, and backup/retention and recovery targets remain open decisions. No paid infrastructure was provisioned and nothing was publicly deployed. The eventual v1 still targets private notes and signed-in collaboration with invitations; this local milestone is its technical foundation.

## License

[MIT](LICENSE) © 2026 Maciej Głownia.
