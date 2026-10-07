# Local hard-failure checks

The integration command includes real subprocess and TCP checks as of 2026-10-07. Each new case creates and removes a unique PostgreSQL schema in the local test database; no existing note, `public` schema, provider service or production data is modified. These are bounded correctness tests, not a soak or availability guarantee.

## Process and database-response failure

[Hard-crash integration tests](../apps/server/src/hard-crash.integration.test.ts) run the actual persistence/compaction code in a [worker process](../apps/server/src/fixtures/crash-worker.ts), then send OS `SIGKILL` at explicit boundaries:

- Before edit COMMIT: PostgreSQL rolls back; retrying the original batch commits once.
- After edit COMMIT, before its result reaches the caller: the committed receipt replays the original sequence without another update.
- Before snapshot COMMIT: the original seed/tail and receipts remain reconstructible.
- After snapshot COMMIT: committed snapshot state survives with the still-covered tail; recovery and another prune retain exact state.
- During an uncommitted prune: deletion rolls back and recovery retains exact binary state and receipts.

A loopback TCP proxy forwards the actual PostgreSQL COMMIT packet while dropping its server response. An independent database connection observes the committed receipt, the blocked worker is killed, and retrying its original ID/bytes resolves that outcome exactly once. This verifies an unknown successful commit through real `pg` transport, beyond an injected post-commit exception.

A separate [application subprocess](../apps/server/src/fixtures/crash-app.ts) starts the full `createServer` HTTP/WebSocket application on loopback. Its existing test-only fault route withholds one author acknowledgement after COMMIT, while an independent PostgreSQL connection confirms the receipt and another socket observes the committed update. OS `SIGKILL` terminates that application without graceful shutdown. A new application process against the same stored schema hydrates the room to sequence 1; retrying the exact original UUID/bytes returns its original receipt with one update row. A continued edit commits at sequence 2, reaches a new peer in order, and reconstructs the same binary state from PostgreSQL. This case uses the explicit development fixture identity under `NODE_ENV=test`; authenticated accounts and browser journals remain separate checks.

The focused seven-case hard-crash file passed on 2026-10-07 against PostgreSQL 17.9 on `127.0.0.1:54329/kikit_e2e`, using unique temporary schemas: 4.50 seconds for the file, 1.67 seconds for the full-application case. The full sequential `pnpm test:integration` then passed all 58 tests across seven files in 18.08 seconds, including the full-application case and separate authenticated account/sharing/presence checks. Server typecheck passed. The existing integration command already includes this file.

These checkpoints do not exhaust every instruction or packet race. Neither killing a worker nor killing the full application is a hosted database crash, power-loss test or permanent network partition. The PostgreSQL process remains running.

## Socket overload and slow recipients

[Socket-pressure tests](../apps/server/src/socket-pressure.integration.test.ts) use actual loopback TCP WebSockets, `attachSyncConnection`, page queues, live rooms and PostgreSQL, with an explicit fixture principal. They exercise transport/persistence bounds; authenticated access and browser journals are verified separately.

A real held page-row lock delays processing while 70 valid batches enter the socket. The per-page limit admits 64 and rejects six with retryable `OVERLOADED`, leaving them without receipts. Releasing the lock delivers ordered committed sequences to a healthy recipient; retrying the exact rejected IDs/bytes produces one receipt each and sequences 1–70.

Another case pauses a recipient's TCP reads after hydration while 48 committed replacements carry roughly 192 KiB of text each. The actual 4 MiB outgoing socket budget closes only the stalled server socket with code 1013; a healthy peer continues receiving ordered updates and the author receives durable receipts. A fresh recipient reconnects to the exact final binary state, with 48 receipts. Production resource bounds and fault routes are unchanged.

These finite workloads do not measure sustainable load or guarantee that every slow client is detected within a particular latency. They do not prove replica coordination, hosted network behavior, or browser storage retention by themselves. Existing authenticated offline/revocation tests and the [recovery import](recovery-contract.md) tests establish the separate journal/recovery boundaries. See [dated execution evidence](verification.md) and [release gates](v1-release.md).
