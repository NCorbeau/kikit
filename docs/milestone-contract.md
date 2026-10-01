# Milestone 1 contracts

Protocol, document schema, and database schema independently start at version 1.

## Document

One Y.Doc per page. `title` is a Y.XmlFragment containing exactly one paragraph, with plain text. `body` is a Y.XmlFragment containing paragraphs and headings (levels 1–3), with plain text and a stable `id` attribute per block. No marks or extra blocks. The server initializes both fragments exactly once in a transaction. Browsers never seed an empty page. The editor mounts only after a persisted cache or server state is hydrated. Tiptap Collaboration supplies CRDT-aware local undo; UniqueID handles local split/paste, filtering remote transactions.

## Transport

Same-origin `/api/dev/session` returns the explicitly enabled development fixture `{accountId,pageId,protocolVersion,schemaVersion}`. This milestone has no real login. Server startup fails unless NODE_ENV is development/test AND KIKIT_DEV_FIXTURE=1; bind loopback by default and verify WebSocket Origin. `/api/sync` upgrades a WebSocket. A client sends `hello` with pageId and both versions, server authorizes the fixture and sends `sync` containing the full committed binary Yjs state (base64) and committed sequence. This intentionally simple full-state handshake does not acknowledge local edits.

Client `update` has a page-scoped UUID batchId and base64 binary update. Server sends `ack` with batchId and its original committed sequence only after PostgreSQL COMMIT, and propagates a `committed` binary update to peers. Server `error` includes code, message, retryable, optionally batchId. Terminal errors preserve the journal and permit recovery export. Reconnect rehydrates committed state and resends existing journal entries with unchanged IDs and bytes.

## Persistence and sequencing

Browser IndexedDB is namespaced by account and page. A local Yjs update and its outbound batch identity are stored in one transaction before transmission. Acknowledgement deletes only its pending marker, retaining document state. Remote committed state is persisted without making an outbound batch. Unpersisted edits stay in memory on local failure; expose retry/export and warn before leaving. Reload recovery is only promised for successful local commits.

PostgreSQL stores page ownership/schema/sequence, binary updates, and page-scoped receipts containing payload hash and sequence. Page locking and one p-queue (concurrency 1) per active page cover validation, commit, room apply, ordered outgoing scheduling. Same identity/same bytes returns its original receipt; different bytes is a terminal conflict. Unknown commit outcome is resolved by retry, never acknowledged speculatively. Room apply failures invalidate and rebuild from committed storage. No snapshots/pruning in milestone 1.

Admission is bounded by count and bytes per page and globally; socket output is bounded. Database operations have server-side statement/lock timeouts and keep queue ownership until completed or rolled back. Shutdown stops admission and drains, closing connections within a documented deadline. Queue metrics contain counts/times, never content. One active server only.

## Module ownership / interface

`packages/contracts`: wire types, versions, constants and binary codec (lead owns).

`apps/web/src/session`: LocalStore, DocumentSession and SyncClient (local persistence owner). Public entry exports `createDocumentSession()` returning a DocumentSession with `doc: Y.Doc`, `start(): Promise<void>`, `subscribe(listener): () => void`, `getSnapshot(): SessionSnapshot`, `retry(): void`, `exportRecovery(): string`, `destroy(): void`. Snapshot is referentially stable until changed and has `{ready:boolean, connection:'connecting'|'online'|'offline'|'error', local:'saving'|'saved'|'error', pending:number, serverSaved:boolean, error:string|null}`. Default fixture IDs come from shared constants to open cached notes offline; live endpoint must verify them before connecting. Ready requires successful cache hydration or server initialization. Session owns doc lifetime. UI mounts editors after ready and unmounts before destroy.

`apps/web/src/editor`, `App.tsx`, `styles.css`, `main.tsx`, `index.html`: UI/editor owner. UI derives all editable content from Y.Doc. No shadow editable React copy. Distinct labels for saving locally, saved on this device, saved to server, offline and errors. Provide recovery download and retry on failure.

`apps/server/src`: backend owner. `createServer()` exported from `app.ts` for test harness; `main.ts` runs server; `migrate.ts` applies SQL and seeds fixture. PostgreSQL default local URL is `postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit`, overridden by DATABASE_URL; default server port 3001; default browser origin http://127.0.0.1:5173. Test failure hooks, if needed, must require NODE_ENV=test AND KIKIT_TEST_FAULTS=1 and loopback, and never exist in development/production routes.

Lead owns all package manifests, lockfile, root config, Vite config, end-to-end tests and delivery documentation. Owners may add tests within their source directories. Communicate interface changes before implementation.
