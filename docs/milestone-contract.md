# Milestone 1 contracts

This records the original local fixture milestone. The [private account slice](accounts-contract.md), implemented on 2026-10-02, extends its startup/authentication and shell-cache boundaries and advances the database schema to version 2. Its binary document and durability contracts remain in force.

The subsequent [shared-page contract](shared-pages-contract.md) records invitations, membership/revocation and transient presence. It advances database schema to 3 and wire protocol to 2 while retaining document schema 1 and the durable update/receipt flow below.

Protocol, document schema, and database schema independently start at version 1.

## Document

One Y.Doc per page. `title` is a Y.XmlFragment containing exactly one paragraph, with plain text. `body` is a Y.XmlFragment containing paragraphs and headings (levels 1–3), with plain text and a stable `id` attribute per block. No marks or extra blocks. The server initializes both fragments exactly once in a transaction. Browsers never seed an empty page. The editor mounts only after a persisted cache or server state is hydrated. Tiptap Collaboration supplies CRDT-aware local undo; UniqueID handles local split/paste, filtering remote transactions.

Valid concurrent deletions can merge into a body with no blocks even though each client's editor retained a paragraph. Before committing that merge, the server inserts one empty paragraph with a stable ID into the candidate document. The repair preserves the original Yjs identities and is committed atomically with the submitted edit. This is normalization of an existing page, not another initialization or replacement of its binary history.

## Transport

Same-origin `/api/dev/session` returns the explicitly enabled development fixture `{accountId,pageId,protocolVersion,schemaVersion}`. This milestone has no real login. Server startup fails unless NODE_ENV is development/test AND KIKIT_DEV_FIXTURE=1; bind loopback by default and verify WebSocket Origin. `/api/sync` upgrades a WebSocket. A client sends `hello` with pageId and both versions, server authorizes the fixture and sends `sync` containing the full committed binary Yjs state (base64) and committed sequence. This intentionally simple full-state handshake does not acknowledge local edits.

Client `update` has a page-scoped UUID batchId and base64 binary update. Server sends `ack` with batchId and its original committed sequence only after PostgreSQL COMMIT, and propagates a `committed` binary update to peers. Server `error` includes code, message, retryable, optionally batchId. Terminal errors preserve the journal and permit recovery export. Reconnect rehydrates committed state and resends existing journal entries with unchanged IDs and bytes.

## Persistence and sequencing

Browser IndexedDB is namespaced by account and page. A local Yjs update and its outbound batch identity are stored in one transaction before transmission. Acknowledgement deletes only its pending marker, retaining document state. Remote committed state is persisted without making an outbound batch. Unpersisted edits stay in memory on local failure; expose retry/export and warn before leaving. Reload recovery is only promised for successful local commits.

PostgreSQL stores page ownership/schema/sequence, binary updates, and page-scoped receipts containing payload hash and sequence. Page locking and one p-queue (concurrency 1) per active page cover validation, commit, room apply, ordered outgoing scheduling. Same identity/same bytes returns its original receipt; different bytes is a terminal conflict. Unknown commit outcome is resolved by retry, never acknowledged speculatively. Room apply failures invalidate and rebuild from committed storage. No snapshots/pruning in milestone 1.

Admission is bounded by count and bytes per page and globally; socket output is bounded. Database operations have server-side statement/lock/transaction timeouts and keep queue ownership until completed or rolled back. Shutdown stops admission, rejects queued work, and waits for running operations; socket close handshakes are bounded separately. A database network blackhole can still delay shutdown. Queue metrics contain counts/times, never content. One active server only.

## Module interfaces

`packages/contracts`: wire types, versions, constants and binary codec.

`apps/web/src/session`: LocalStore, DocumentSession and SyncClient. Public entry exports `createDocumentSession()` returning a DocumentSession with `doc: Y.Doc`, `start(): Promise<void>`, `subscribe(listener): () => void`, `getSnapshot(): SessionSnapshot`, `retry(): void`, `exportRecovery(): string`, `destroy(): void`. Snapshot is referentially stable until changed and has `{ready:boolean, editable:boolean, connection:'connecting'|'online'|'offline'|'error', local:'saving'|'saved'|'error', pending:number, serverSaved:boolean, error:string|null}`. Terminal compatibility/access errors lock editing until verified synchronization succeeds, keeping recovery available. Default fixture IDs come from shared constants to open cached notes offline; live endpoint must verify them before connecting. Ready requires successful cache hydration or server initialization. Session owns doc lifetime. UI mounts editors after ready and unmounts before destroy.

`apps/web/src/editor` and the application UI derive all editable content from Y.Doc. There is no shadow editable React copy. Distinct labels identify saving locally, saved on this device, saved to server, offline and errors. Recovery download and retry remain available on failure.

`App` composes `useDocumentSession` and `DocumentPage`. The session hook owns one document/session for the mounted page; theme changes and recovery errors do not recreate it. `useRecoveryDownload` owns browser file creation and its error state, leaving the session's binary recovery format unchanged. Save details show device and server durability separately. Light/dark color tokens cover the editor and failure states. Appearance follows the system until a user chooses a theme; that noncritical preference is separate from the note journal, and unavailable preference storage cannot prevent editing.

`apps/server/src`: `createServer()` is exported from `app.ts` for the test harness; `main.ts` runs the server; `migrate.ts` applies SQL and seeds the fixture. PostgreSQL's default local URL is `postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit`, overridden by DATABASE_URL; default server port 3001; default browser origin http://127.0.0.1:5173. Test failure hooks require NODE_ENV=test AND KIKIT_TEST_FAULTS=1 and loopback, and never exist in development/production routes.

The backend entry point wires routes, connection admission, and shutdown. `sync-connection.ts` owns each socket's handshake and message validation; `sync-room.ts` owns page membership and the serialized commit/apply/propagate flow; `sync-protocol.ts` handles bounded output and public errors. `persistence.ts` uses Drizzle query builders while retaining explicit transaction boundaries and named validation/commit hooks. `schema.ts` defines typed tables and preserves `bytea` as Buffer. `migrations.ts` runs versioned SQL files; `development-seed.ts` separately creates the fixture. Fault controls and routes live separately in `test-faults.ts`.

## Concrete recovery decisions

IndexedDB `updates` uses an auto-increment primary key for insertion order and a unique `id` index for immutable batch identities. Update bytes, the pending flag, and initialization metadata commit together with strict durability requested. Acknowledgements change only the pending flag. Multiple tabs can replay the same pending identity safely; fresh browser contexts communicate exclusively through the backend. No IndexedDB cache deletion is automatic.

`idb` supplies typed promise wrappers for IndexedDB requests and transactions. The store waits for `tx.done` before reporting a committed read/write. Only IndexedDB work is awaited inside an active transaction; semantic failures abort it and settle its completion promise before returning the error. The wrapper does not change the existing database name, version, stores, or records.

A local append failure and a failed local acknowledgement write are tracked separately. Receipt success for an older batch cannot clear a newer append failure. Unpersisted edits are retained in memory, included in recovery export, and protected by a before-unload warning; no reload guarantee is made until their IndexedDB transaction completes.

The server validates candidate CRDT state before storing a new batch, retaining the room unchanged until COMMIT. Missing causal dependencies produce a retryable error. Receipt lookup precedes candidate validation for duplicate identities. SHA-256 covers the exact submitted update bytes. A conflict never changes a receipt or creates another update.

When an empty-body repair is needed, the stored update contains both the submitted edit and the repair. The receipt still hashes the original submitted bytes. The server sends the repaired committed update to the author as well as peers before acknowledging it. A duplicate retry reuses the originally stored repair and sequence instead of generating another paragraph.

An exception while committing may mean COMMIT succeeded without a readable response. The server closes the uncertain room's sockets and discards its in-memory document before processing more work. Reconnection reconstructs from committed bytes; retry returns the original receipt. This also applies when committed room application fails. Peer socket transmission failures disconnect the affected peer; reconnect obtains committed state.

The PostgreSQL compatibility version is recorded in `schema_versions`, separately from migration history. Drizzle Kit generates SQL and snapshots in `apps/server/migrations`; Drizzle applies pending SQL and records checksums/timestamps in `__drizzle_migrations` within the active PostgreSQL schema. The wrapper holds a session advisory lock across history verification and migration execution. Applied history must match a prefix of the checked-in files, including their checksums; unknown or modified history is rejected. Pending DDL and history records commit atomically. The baseline intentionally uses idempotent DDL to adopt the original local schema, preserving its constraint names, notes, updates, and receipts. Later migrations are forward changes, not whole-schema recreation. Seed insertion is separately development-gated and idempotent, retaining the original binary identity in `pages.initial_state`. Runtime server creation does not execute migrations. Idle pool connection errors are handled explicitly: pg discards the failed client and subsequent operations can reconnect. The warning omits the raw error, connection string and document content. Local Compose uses one development role for convenience; separate privileged migrations and least-privilege runtime grants are required before production.

The browser shell cache is development-only and excludes all `/api/` requests. It stores no note content. The first connected load warms the shell; subsequent offline navigation can mount a cached page. Schema compatibility remains enforced by the document session even when the shell was cached.

## Library references

- [Tiptap Collaboration](https://tiptap.dev/docs/editor/extensions/functionality/collaboration): fragment binding and collaborative undo.
- [Tiptap UniqueID](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid): local split/paste IDs and collaboration initialization.
- [Yjs document updates](https://docs.yjs.dev/api/document-updates): binary updates and merging. CRDT convergence is separate from our durable receipt contract.
