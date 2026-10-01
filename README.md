# Kikit

A small block editor for personal notes, built to make writing feel immediate and synchronization understandable end to end.

Kikit aims for a calm, polished editing experience: open a page, write naturally, and keep working when the connection drops. The project combines a deliberately narrow product scope with explicit persistence, synchronization, and recovery behavior.

**Status: planning.** This repository currently contains the project introduction and agent instructions. The application, tests, and deployment have not been implemented yet.

## First release

- Accounts and persistent personal notes, private by default.
- A page title, paragraphs, and headings with natural keyboard, selection, paste, split, merge, and undo behavior.
- Immediate local editing and recovery of locally saved changes after reload.
- Synchronization across devices and between multiple signed-in collaborators.
- Owner-managed invite links and QR codes; recipients sign in and join shared pages as editors.
- Simple owner/editor permissions, member removal, participant indicators, and colored cursors.
- Clear feedback distinguishing local persistence from durable server storage.
- A focused, accessible interface with careful typography and restrained controls.

Nested workspaces, databases, attachments, comments, AI features, and native applications are outside the first release.

Sharing requires login in v1. Disabling an invite link stops new joins; removing a member revokes their page access. Existing members keep access when a link is disabled. Guest access may be considered later.

## Architecture

Start with a modular monolith: one web client, one active Node server, and PostgreSQL. Keep editor behavior, document sessions, local storage, synchronization, authorization, and persistence in explicit modules.

| Area | Selected direction |
| --- | --- |
| Web application | React, TypeScript, Vite |
| Editor mechanics | Tiptap / ProseMirror |
| Concurrent edit merging | Yjs; one collaborative document per page |
| Browser storage | IndexedDB document data and durable outbound journal |
| Backend | Node, TypeScript, Fastify, custom WebSocket synchronization |
| Authentication | Better Auth inside the backend, backed by PostgreSQL |
| Persistence | PostgreSQL updates, snapshots, and idempotency receipts |
| Live update sequencing | `p-queue`, one queue per active page, concurrency one |
| Hosting | Railway for the application and PostgreSQL |
| Repository and verification | pnpm workspace; Vitest, Playwright, GitHub Actions, Docker |

We own the synchronization protocol, retries, authorization, database transactions, acknowledgements, and recovery. Yjs handles merging concurrent changes; Tiptap/ProseMirror handles editor mechanics. These dependency boundaries should be documented and demonstrated rather than hidden behind claims of building every primitive from scratch.

## Following an edit

1. Apply the edit immediately in the local editor.
2. Persist its update and outbound batch identity together in IndexedDB.
3. Send the pending batch to our server.
4. Authorize and validate it, then commit the update and receipt together in PostgreSQL.
5. Apply the committed update to the room, propagate it to other clients, and acknowledge the batch.
6. Clear its pending marker locally after acknowledgement.

An interrupted connection leaves unacknowledged work pending. Retrying a stable batch ID must recognize an existing commit. A connection or synchronization event alone never means an edit is durably saved.

The server's live queues are in memory. Recovery depends on the browser journal and committed PostgreSQL state. Queue admission limits, safe database timeout handling, and shutdown behavior are part of the design.

## Build sequence

1. Prove a tiny editor and sync flow across two independent browser sessions.
2. Deliver a polished local editor with persistence, cached offline reopening, and recovery.
3. Integrate real login, owner/editor membership, link/QR invitations, cross-device synchronization, and restrained presence. Verify collaboration between distinct accounts.
4. Verify failure scenarios, compatibility, resource limits, backup restoration, and deployment.
5. Publish a usable demo, setup instructions, architecture decisions, and measured results.

The early proof must exercise lost acknowledgements, duplicate delivery, reloads, server restarts, and database failure. Collaboration tests must use the actual backend, not rely on same-browser communication shortcuts.

## Working on the project

Read [AGENTS.md](AGENTS.md) for scope, architectural invariants, and the development workflow. Executable setup commands will be added with the first working implementation.

Keep evidence honest: document supported behavior and limitations, and report performance with test conditions. Cached offline access is limited to previously opened notes; browser storage can be cleared or evicted. Before relying on Kikit for real notes, implement and test the selected backup and recovery policy.

Login method, hosting plan and budget, recovery targets, and licensing remain to be decided. Durable background processing is deferred until a concrete task requires it; `pg-boss` and Graphile Worker are candidates.
