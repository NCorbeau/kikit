# Milestone 1 verification

Verified on 2026-10-01 using macOS/Apple Silicon, Node 24.21.0, pnpm 12.5.1, Docker PostgreSQL 17.9, and Playwright 1.63.0's Chromium 153. All browser tests use the actual Fastify backend and PostgreSQL, fresh browser contexts, and a separate local test database. This is correctness evidence for small fixture documents, not a performance/capacity benchmark.

## Automated results

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed for shared contracts, server, web, test harness and root configuration |
| `pnpm test` | 32 passed; 5 PostgreSQL integration tests intentionally skipped without opt-in |
| `pnpm test:integration` | All 5 real PostgreSQL/WebSocket tests passed |
| `pnpm test:e2e` | All 11 Chromium scenarios passed |
| `pnpm build` | Passed; Vite reports a large editor chunk (724.91 kB before gzip) |

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
10. Keyboard split/merge, isolated merge undo, heading shortcut, paste ID regeneration, selection, title-to-toolbar Tab order and title Enter focus.
11. Chromium composition events followed by a Unicode commit, synchronized without the intermediate composition text remaining.

Vitest checks additionally cover atomic IndexedDB aborts, namespace isolation, insertion-ordered replay, unsupported cached versions, unpersisted recovery exports, local acknowledgement persistence failure, stale handshakes, terminal readonly state, bounded queues, failed tasks, orderly shutdown, and production fixture denial. PostgreSQL checks exercise atomic rollback, duplicate receipts, concurrent row locking, cross-account denial, lost acknowledgement and uncertain commit recovery.

## Manual inspection

Inspected the running application in regular Chrome using its screenshot and accessibility tree: the writing surface, typography, spacing, restrained controls, distinct device/server status, and labelled title/body/formatting controls were visible. The frontend implementer also inspected desktop and 390px screenshots and checked for horizontal overflow. Persistent Playwright tests provide the keyboard/paste/undo evidence above.

No full screen-reader audit, native operating-system IME session, Safari/Firefox suite, mobile keyboard/device check or user usability study was performed. Chromium's composition-event test does not replace those checks.

## Independent review and resolved findings

An independent durability review identified two concrete races:

- A lost database COMMIT result left the room stale; a later peer commit could hide the missing update behind an advanced sequence. Persistence failures with uncertain outcomes now invalidate the room and close its sockets. Both PostgreSQL/WebSocket and independent-browser regressions verify reconstruction and stable receipts.
- An older batch's successful acknowledgement cleared a newer edit's local append failure. Append/load errors and local receipt-write errors are now separate. The regression verifies that the newer edit remains recoverable and its error stays actionable.

No unresolved blocker was reported by that review. This is a local development milestone, not the authenticated-account release gate in AGENTS.md.

## Limits of the evidence

The unknown-COMMIT test injects an exception immediately after a real successful COMMIT; it does not cut a physical network link to PostgreSQL. Server restart is an orderly close/recreate. A PostgreSQL trigger supplies the tested database failure. Queue overload/drain are deterministic unit checks; sustained overload, process kill during COMMIT, socket blackholes and slow-recipient soak testing remain further hardening work.

There is no snapshot compaction, production deployment, backup/restore validation, real-login security verification or measured latency/capacity claim. The recovery file preserves binary state and batch identities but has no import UI. Browser storage eviction is not prevented.
