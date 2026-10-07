# Document snapshots and compaction

Implemented locally on 2026-10-07. This extends [milestone 1](milestone-contract.md) and [permanent deletion](deletion-contract.md). Database compatibility advances from 5 to 6 through `0005_document_snapshots.sql`. Document schema 2 and wire protocol 2 are unchanged. No hosted rollout is claimed.

## Stored boundary

The original `pages.initial_state` remains unchanged. `snapshot_state` stores a complete binary Yjs update and `snapshot_sequence` names the committed page sequence it covers. Before the first snapshot, the sequence is zero and loading starts from the original initial state. Thereafter loading starts from the snapshot and applies only the ordered committed updates with sequence greater than its boundary. The page lock makes this a consistent read. Missing tail sequences, invalid boundaries and unresolved causal dependencies fail closed.

Snapshots are reconstructed from committed binary storage in a Y.Doc with garbage collection disabled. Deleted structures and their identities are retained; JSON, HTML and text projections never become persistence. The existing schema and 2 MiB encoded-document validation applies to snapshots too. A history-heavy snapshot exceeding that guard fails without pruning its source; this is a safe failure, not a claim that every history fits indefinitely. Receipt storage has no age expiry in this slice.

## Commit before prune

The existing page queue remains held through both transactions. Each transaction locks the active session, page and grant in the same order as document writes.

1. Read the current committed state under the page lock, validate its binary document, and commit the snapshot at that exact sequence.
2. Start a separate transaction, revalidate access and the persisted boundary, then remove only update rows at or below that boundary. Commit the removal.

The second phase never starts before the snapshot commit succeeds. A crash, failed response or interrupted prune can leave extra covered update rows, which loading skips. Retrying is safe. Newer updates survive even when committed between the two phases. No snapshot changes the logical document sequence or live room content.

## Receipts and repairs

The migration removes the receipt's foreign key to an update row, retaining its page foreign key. Receipts continue to contain the immutable submitted SHA-256 hash, batch identity and original sequence. A nullable `repair_payload` stores the exact committed bytes only when the server added a repair; ordinary batches retain their hash/sequence without duplicating their payload. The migration copies existing repairs before pruning can occur, identifying them with PostgreSQL's [built-in SHA-256](https://www.postgresql.org/docs/18/functions-binarystring.html).

Same identity and same submitted bytes return the original receipt after compaction; different bytes still fail. A repaired retry returns the same original repair without regenerating blocks. Authorization precedes receipt access. Deletion removes both receipt repair bytes and snapshot bytes along with other note content.

## Trigger, failure and shutdown

After committing, applying and scheduling an edit's acknowledgement, the live room attempts compaction after 100 updates or 1 MiB of additional committed tail since its last attempt. These are maintenance thresholds chosen for the current small-note implementation, not measured performance guarantees. A failure retains committed state and receipts and increments content-free maintenance metrics; it does not undo a save or invalidate a correctly applied room. Another attempt waits for a new threshold, avoiding a failed snapshot transaction on every keystroke. A newly loaded room reads the stored boundary and tail size.

Compaction runs within the existing in-process queue and PostgreSQL transaction limits. Shutdown drains the running operation and rejects waiting work without racing a timeout against a still-live transaction. There is no separate worker, scheduler, service or new dependency. Idle notes compact on later admitted updates; no periodic scan rewrites inactive notes. PostgreSQL space reclamation remains its own vacuum behavior.

## Deployment and recovery

Stop/drain the old server, apply the reviewed forward migration with the migration role, and start compatible web/server assets. The current runtime table grants cover the added columns; no new table or extension privilege is needed. Do not run database-schema-5 code against schema 6.

Logical backups include initial state, snapshot, tail and independent receipts. Document compaction does not replace Railway volume backups or establish hosted recovery targets. See [verification](verification.md) for the actual PostgreSQL, browser and disposable restore checks.
