# Permanent note deletion

Implemented locally on 2026-10-07. This extends the [account](accounts-contract.md) and [shared-page](shared-pages-contract.md) slices and follows the accepted [data policy](data-policy.md). Database compatibility advances to 5 through `0004_page_deletion.sql`; the subsequent [snapshot slice](snapshot-contract.md) advances it to 6. Document schema 2 and wire protocol 2 are unchanged. This source is not deployed.

## Authorization and transaction

`DELETE /api/pages/:pageId` requires a real Better Auth session, the same-origin mutation guard, a valid UUID and an `X-Kikit-Account` header matching the session account. The server holds the page queue through the transaction and live-access revalidation. Session, page and owner grant are checked under locks; an editor cannot delete a note.

One transaction removes the note's receipts (including repair bytes), binary updates, invitations and grants, clears title/initial binary content and snapshot content/boundary, and marks `pages.deleted_at`. The retained content-free page identity, owner, schema/sequence and creation/deletion timestamps prevent a delayed creation retry from seeding the page again. Deleted pages do not appear in lists or count against the active owned-note limit. Load, write, invitation and membership paths deny access. Repeated deletion by the same authenticated owner succeeds without changing the marker.

The page lock orders deletion behind an already authorized database commit. An ordinary failure rolls back all changes. An uncertain commit invalidates the room through the existing access-mutation recovery path; an owner retry resolves the persisted marker. No client success response precedes commit and room revalidation. The queue remains held until the operation settles.

## Browser recovery

Only owners see the deletion action. It pauses the document session and waits for local writes before opening the confirmation dialog. Escape/cancel restores editing and menu focus. A failed local save disables confirmation until the in-memory binary recovery file is downloaded. A failed delete request keeps the document alive and offers retry/cancel.

Successful deletion returns the owner to the note list. Connected collaborators lose access before the response returns; disconnected devices learn of deletion when revalidating or reconnecting. Editors are then hidden, with recovery export available. IndexedDB journals, pending batch identities and downloaded copies are not erased. Pending work cannot synchronize to the deleted identity. The [recovery-import slice](recovery-contract.md) can initialize a distinct private copy for the same account.

Pre-deletion backups can retain the content until expiry; disaster restoration must reconcile known deletions. This is permanent deletion from the live application, not a promise to erase offline devices or every historical backup immediately.

## Migration and verification

Stop/drain the old server, apply the forward migration, and start matching web/server assets. Existing page content, identities and receipts are unchanged by adding the nullable marker. The current least-privilege runtime table grants cover the new column; no new table grant is required. Do not start old database-schema-4 code against schema 5.

See the [dated verification record](verification.md) for checks run for this slice. Hosted deployment, deletion and restore reconciliation remain unverified release gates.
