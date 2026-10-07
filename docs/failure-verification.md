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

These checkpoints do not exhaust every instruction or packet race. Killing a worker is not a hosted database crash, power-loss test or permanent network partition. The PostgreSQL process remains running.

## Socket overload and slow recipients

[Socket-pressure tests](../apps/server/src/socket-pressure.integration.test.ts) use actual loopback TCP WebSockets, `attachSyncConnection`, page queues, live rooms and PostgreSQL, with an explicit fixture principal. They exercise transport/persistence bounds; authenticated access and browser journals are verified separately.

A real held page-row lock delays processing while 70 valid batches enter the socket. The per-page limit admits 64 and rejects six with retryable `OVERLOADED`, leaving them without receipts. Releasing the lock delivers ordered committed sequences to a healthy recipient; retrying the exact rejected IDs/bytes produces one receipt each and sequences 1–70.

Another case pauses a recipient's TCP reads after hydration while 48 committed replacements carry roughly 192 KiB of text each. The actual 4 MiB outgoing socket budget closes only the stalled server socket with code 1013; a healthy peer continues receiving ordered updates and the author receives durable receipts. A fresh recipient reconnects to the exact final binary state, with 48 receipts. Production resource bounds and fault routes are unchanged.

These finite workloads do not measure sustainable load or guarantee that every slow client is detected within a particular latency. They do not prove replica coordination, hosted network behavior, or browser storage retention by themselves. Existing authenticated offline/revocation tests and the [recovery import](recovery-contract.md) tests establish the separate journal/recovery boundaries. See [dated execution evidence](verification.md) and [release gates](v1-release.md).
