# Working on Kikit

## Purpose and current state

Kikit is a small, polished block editor for persistent personal notes. It is also a learning project: its editing, local persistence, authorization, synchronization, and recovery should be inspectable end to end.

The first local development milestone implements the editor, IndexedDB journal, custom synchronization, PostgreSQL persistence, and automated checks. The account slice is in progress; inspect the current code, working tree, and verification record before describing it as complete. The development identity does not satisfy the authenticated v1 release gate. Production deployment remains future work. Implement the next agreed slice rather than interpreting a planning discussion as authorization to build the entire system.

## Project documentation for agents

Before implementation or a planning update, read `README.md`, `docs/milestone-contract.md`, and the relevant parts of `docs/verification.md`, then inspect the affected code and existing changes. `docs/demos/README.md` records the independent-browser demonstration and its conditions. Distinguish recorded test results from checks run for the current change.

Notion is the product planning hub. If `.codex/project-docs.md` exists, read it for the private hub and document links. Fetch the hub and the documents relevant to the task through the connected Notion tools: Vision & Product Scope for product/UX work; Architecture & Infrastructure for technical boundaries; Build Plan & Quality Gates for sequencing and acceptance; Decisions & Open Trade-offs for accepted choices and unresolved decisions. Treat a planning target as a requirement, not proof of implementation or permission to build it.

Current user instructions and recorded authorization take precedence. Notion records product intent and decisions; repository contracts describe implemented technical behavior; verification records establish evidence only under their stated conditions. Reconcile stale statements against code and tests, and surface material conflicts rather than silently choosing a new scope, login method, provider, budget, or reliability promise. Uncommitted work is not a completed milestone or a recorded product decision. Preserve changes already in progress.

When documentation updates are within the requested scope, keep the hub and affected planning summaries aligned with implementation, date the update, link technical evidence, and separate implemented, in-progress, and deferred work. Otherwise report relevant documentation drift. Do not duplicate detailed technical contracts in Notion or claim unrun checks passed.

Keep `.codex/project-docs.md` ignored and never copy its private workspace links or personal context into tracked files, commits, PRs, public docs, or logs. It is a local reference and is not distributed with a clone. If it or Notion access is unavailable, continue authorized work from repository evidence and report the limitation; request missing context only when a consequential decision depends on it. Do not invent or search for private URLs.

## Product scope

The first release includes accounts, private notes, page titles, paragraphs, headings, local persistence, cross-device sync, and authorized collaboration. Natural typing, selection, paste, composition input, split/merge, local undo, accessibility, and visual quality are core requirements.

Keep controls restrained and writing central. Use a compact set of typography, spacing, color, border, focus, and motion tokens. Give loading, failure, and recovery states the same care as the happy path.

Keep UI copy functional and concise; avoid decorative slogans. Support light and dark themes with a system default and a remembered user choice. Keep application roots focused on composition, with session lifetimes and browser interactions in focused hooks. Extract responsibilities to improve reading, not merely to reduce line counts or introduce wrappers.

Do not expand into nested workspaces, drag reordering, databases, attachments, comments, AI features, native apps, or a plugin system without an explicit scope decision.

## Selected architecture

- React + TypeScript + Vite for the web application.
- Tiptap/ProseMirror for editor mechanics and its Yjs binding for shared content.
- One Y.Doc per page; editor-compatible body content and a separate simple title fragment. Stable block IDs require explicit split/paste handling.
- IndexedDB through `idb` for locally persisted document updates and pending outbound batches.
- Node + TypeScript + Fastify for HTTP, authentication, and custom WebSocket sync.
- Better Auth inside the backend, with authentication records and sessions in PostgreSQL.
- PostgreSQL for page metadata, access grants, binary document updates, snapshots, and durable receipts.
- Drizzle ORM for typed database queries and Drizzle Kit for generated, reviewed SQL migration files. Keep transaction and row-lock boundaries explicit; development fixture seeding stays separate from schema migrations.
- `p-queue` for in-process per-page sequencing.
- Railway for one active application instance and PostgreSQL in the same environment and region, using private database networking.
- A pnpm workspace when code is introduced. Initial applications may live in `apps/web` and `apps/server`; extract shared document/protocol contracts only where genuinely shared.

Start as a modular monolith. Keep editor, document-session, local-store, sync-client, pages/access, sync-server, and persistence responsibilities separate. Avoid speculative interfaces, layers, or independently deployed services.

Prefer established, focused libraries for generic infrastructure when they reduce maintenance and make the code easier to understand. Keep product-specific durability, authorization, transport, and recovery decisions explicit. Add a dependency for a concrete simplification in the current implementation, with verification that its behavior preserves the relevant invariants.

## Editing and synchronization invariants

1. The collaborative document is the source of truth for editable content. Do not keep a second editable copy in React or add a competing whole-document REST save path.
2. Preserve Yjs binary state, history, and identity. Readable JSON, HTML, and plaintext are derived projections, not a replacement persistence format.
3. Initialize a page once on the server. Hydrate before mounting an editable client view; multiple clients must not independently seed empty content.
4. Apply edits locally without waiting for the network. Persist the update and its pending batch identity atomically before sending it.
5. Use stable, page-scoped batch identities. Commit an update and its receipt atomically. Retries must return a consistent result for the same batch; never reinterpret a reused identity with different content as a new update.
6. Server save acknowledgement follows a successful database commit. Connection state, state-vector exchange, and Yjs convergence are not proof of durable storage.
7. Apply committed state to the room and propagate it consistently. Recover from committed storage if an apply/broadcast failure leaves room state uncertain.
8. Snapshot at a committed sequence boundary. Persist the snapshot before pruning covered updates, retain the tail, and treat receipt retention separately.
9. Preserve recoverable local edits after storage failures, rejected updates, compatibility errors, or access loss. Never silently clear pending work.
10. Version document schema, network protocol, and database schema separately. Incompatible clients must not strip unsupported content or lose offline drafts.

Yjs handles CRDT merging. Our code owns transport, access, persistence, receipts, retry, and recovery. Do not substitute Hocuspocus or a hosted sync provider for the selected custom approach without discussing the change.

## Queue behavior

Use one `p-queue` instance per active page with concurrency one. Serialize page-state validation, commit, room application, and ordered scheduling of outgoing updates. Different pages can progress independently within overall resource limits.

Bound pending update count and bytes per page and across the service. Bound outbound socket buffers; a slow recipient must not hold the room indefinitely. Make overload explicit while leaving uncommitted work unacknowledged and recoverable.

A queue timeout does not prove the database operation stopped. Do not release serialization while an operation can still mutate state: finish or safely cancel/roll back it, and resolve unknown commit outcomes through receipts and stable batch IDs.

Handle task rejection explicitly. Measure queue depth, wait time, processing time, and failures. Stop admission during shutdown, drain within the deployment deadline, and clean up idle queues only after running and pending work settles.

`p-queue` is neither durable nor distributed. Adding replicas requires room ownership, routing, coordination, fencing, and recovery first. PostgreSQL alone does not share in-memory rooms.

Defer durable background jobs until a concrete task requires them. Evaluate `pg-boss` and Graphile Worker then. Job handlers need retry-safe behavior; a worker modifying a document must coordinate with its live room.

## Accounts and data isolation

Pages are private by default. Validate Better Auth sessions, independently authorize document access, and enforce ownership/access in database queries and transactions. A page ID is not a permission.

Use secure HttpOnly session cookies, appropriate SameSite/CSRF protections, and WebSocket origin validation for the same-origin app. Handle session expiry, renewal, logout, and revocation on active connections. Keep credentials and permissions outside the CRDT.

Namespace browser storage by account and page. Account switching must not reveal another account's cached notes. Offer recovery/export for pending edits before any cache removal.

Never commit credentials, real notes, private planning material, or production data. Keep privileged database credentials server-side; use least-privilege runtime access and separate migration privileges. Avoid note text, session tokens, and share secrets in logs.

## Shared pages and invitations

V1 supports concurrent editing by multiple signed-in users. Pages are private by default. Use owner/editor roles: owners manage invitations and membership and may delete pages; editors may read and edit.

The owner creates an unguessable invitation link; QR codes encode the same URL. Store invitation tokens as hashes, keep secrets out of logs, and require an explicit authenticated join action to create editor membership. Make redemption idempotent and coordinate redemption with revocation. A joined page appears in the member's notes across devices.

Disabling or replacing an invitation prevents new joins without removing existing memberships. Removing a member revokes active and future document access. A removed member can rejoin using a valid invitation; invalidate it as well when preventing re-entry is intended. Revocation cannot recall downloaded copies. Preserve recoverable local drafts while rejecting unauthorized synchronization.

Keep identity validation, invitation redemption, and page authorization separate. Guest access is a possible later decision, not an implemented v1 feature. Avoid speculative guest frameworks or authentication bypasses. Include restrained participant indicators and colored cursors, with presence separate from durable content.

## Delivery and verification

Deliver the smallest complete slice. The first technical proof is a basic page edited through the full local-store/server/database/acknowledgement flow in two independent browser contexts. Validate editor semantics and failure behavior before broadening features.

Use Vitest for meaningful logic/integration checks and Playwright for actual browser/backend scenarios when those tools are introduced. Prioritize concurrent edits, split/merge, offline reload, lost acknowledgement, duplicate delivery, database failure, interrupted commit, snapshot concurrency, incompatible clients, and cross-account denial.

Before declaring v1 complete, use two distinct authenticated accounts to verify invitation redemption, concurrent editing, private-page denial, owner-only controls, duplicate joins, invalidated links, and member revocation on active sockets and offline recovery. A development identity fixture is insufficient for that release gate.

Exercise queue overload, failure, and shutdown. Check keyboard, clipboard, composition input, focus, and collaborative undo. Tests should verify behavior and concrete risks, not mirror implementation details. Do not add redundant tests for documentation-only changes.

Before storing valuable notes in production, configure and test backups and restore. Record performance with page size, browser, network, and concurrency conditions; never invent capacity or latency claims.

## Changes and decisions

Read the relevant code and instructions before editing. Keep commits coherent, review the diff, and report what changed, how it was verified, and any unresolved limitation. Do not invent runnable commands until the repository actually provides them.

Version technical contracts and implementation decisions in the repository as they become concrete. Notion holds the product planning hub; keep private workspace URLs and personal context out of public documentation.

Discuss changes that alter product scope, recurring cost, data guarantees, major dependencies, or substantial implementation effort. Ordinary reversible details can be selected during implementation. Provisioning, publishing, or other external actions still require authorization in the current conversation; this file itself grants none.

Kikit is licensed under MIT; preserve the root LICENSE and copyright notices. Use the MIT SPDX identifier in package metadata when packages are introduced. Keep third-party license and attribution obligations intact.

Open decisions include the initial login method, exact hosting plan/region and monthly budget, and backup/retention and recovery targets. Do not silently settle them or add paid infrastructure.
