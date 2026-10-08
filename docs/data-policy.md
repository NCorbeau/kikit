# V1 deletion and recovery policy

Accepted on 2026-10-07. This records the user's choices; implementation and hosted verification have separate gates in [the release checklist](v1-release.md).

## Deletion

Only a note's owner may permanently delete it after explicit confirmation. V1 has no Trash, per-note restore or deletion undo. Deletion ends shared access, invalidates the invitation and removes the server's note content, snapshots, update history, receipts and access grants atomically. Minimal page identity/owner/deletion metadata is retained to prevent an old create retry from recreating a deleted note.

Active devices lose editing access; offline devices learn of deletion when they reconnect. Local journals and recoverable drafts are retained rather than automatically cleared. Downloaded copies cannot be recalled. A failed local save must be recovered before the deleting browser can leave its draft. Pending edits cannot synchronize to the deleted page; the [recovery flow](recovery-contract.md) can initialize a distinct private copy.

Pre-deletion backups can contain deleted notes until backup expiry. Disaster recovery is separate from a user-facing Trash feature: reconcile known deletions before reopening a restored system. Restoration can lose deletion records newer than the selected backup within the accepted recovery window; do not claim immediate erasure from every historical copy.

## Hosted recovery targets

- Daily backups, with six-day snapshot retention.
- Target recovery point: no more than 24 hours of server data lost when the daily backup schedule is functioning.
- Target recovery time: restore within four hours after recovery starts.
- Keep the existing hosting plan and spending limits; review actual costs before enabling paid backup/restore resources.

These are targets to validate, not an established availability guarantee or incident-response SLA. [MAC-102](https://linear.app/mglownia/issue/MAC-102) must prove an isolated hosted recovery, account access, binary note state, receipts and continued synchronization before valuable notes are stored. Previously recorded local restore checks do not establish these hosted targets.

Railway's [volume backup documentation](https://docs.railway.com/volumes/backups) currently describes daily snapshots retained for six days and restoration in the same project/environment. Provider volume snapshots and application-level Yjs document snapshots protect different boundaries. The actual isolated restore procedure and cost still require verification.
