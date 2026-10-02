# Shared-page access contract

The shared-page slice extends the private account contract. Document schema remains version 1; wire protocol advances to 2 for transient presence, and database schema advances to 3 through `0002_shared_pages.sql`. Existing notes, binary updates and receipts are retained. Version-1 clients are rejected before editable synchronization; deploy matching web/server versions together and retain offline drafts for recovery.

## Invitations and membership

Pages remain private by default. The canonical page owner and an owner grant are required for invitation/member management. Editors may read and edit; they cannot manage sharing or remove the owner. Invitations never alter the collaborative document.

Each page has at most one current invitation. The server creates a 32-byte random base64url token and stores only its SHA-256 hash. A replacement invalidates the previous token. Invitations remain usable until disabled/replaced; there is no automatic expiry. Disabling or replacing a link preserves current members.

The plaintext token is returned only when generating a link. The owner can copy/show its QR code in that dialog; later visits offer an explicit replacement. A lost generation response may have committed: refresh sharing state and replace the link deliberately. Token-bearing requests use bounded POST bodies, never API query parameters. No invitation secret is written to document journals or workspace hints.

Opening a link or completing sign-in does not create membership. An explicit authenticated join validates the current invitation and creates an editor grant atomically. Duplicate joins preserve the existing grant, including the owner role. Granted pages appear in the member's notes on every device.

| Route | Contract |
| --- | --- |
| `GET /api/pages/:pageId/sharing` | Owner-only invitation availability and member list; never returns the current secret |
| `POST /api/pages/:pageId/invitation` | Owner creates/replaces the invitation; returns its new token once |
| `DELETE /api/pages/:pageId/invitation` | Owner disables future joins; existing grants remain |
| `DELETE /api/pages/:pageId/members/:accountId` | Owner removes an editor; repeated removal is idempotent; owner removal is denied |
| `POST /api/invitations/join` | Explicit signed-in redemption of `{token}`; returns the granted page |

Successful sharing responses identify their account with `X-Kikit-Account`. Browser code sends its mounted account in the same request header; the server rejects a changed cookie identity before mutating membership, and the browser also rejects mismatched responses. The same-origin mutation and no-store boundaries from the account contract apply. The development fixture cannot use invitation routes. Authentication denial is 401, page/owner denial 403, and an unavailable invitation 410.

## Transactions and live access

Transactions acquire locks in the order session SHARE, page UPDATE, then grant/invitation rows. Invitation redemption rechecks the token under the page lock, so disable/replace/removal cannot race an unchecked insertion. Authorization precedes durable receipt lookup, including duplicate batches.

HTTP access mutations use the same bounded per-page queue as admitted socket joins, writes and broadcasts. After a committed membership change, unauthorized sockets are removed from the room and sent terminal access denial before the HTTP operation returns success. A write ordered before removal can commit; subsequent writes cannot. Unexpected storage failures or an uncertain mutation COMMIT invalidate the room before releasing serialization. Reconnect checks committed grants again.

Removing a member leaves invitation availability unchanged. The removed account may explicitly rejoin with a still-valid link. Disable/replace it as well when preventing reentry. Removal cannot erase downloaded copies, and account/page journals are never automatically deleted.

Revoked clients lock/hide the editor and retain binary state, pending identities and any unpersisted in-memory edits for recovery export. Offline drafts are rejected on reconnect while unauthorized. If a member later explicitly rejoins, existing batch identities resume: an already committed batch returns its original receipt rather than committing twice.

## Join navigation

Invitation links and QR codes encode the same fragment URL, `/#/join/<token>`, keeping the secret out of the initial HTTP request. Login returns to a generic local join route. A pending invitation may be retained in tab-only session storage, never in the magic-link callback query or email. The original invitation tab can detect the new login; another browser/device must reopen its invitation. Every path still requires an explicit Join action.

Navigation away from an open document uses the existing pause/local-persistence/recovery gate. Failed local writes prevent departure until recovery download succeeds. Offline owner metadata is only a display hint; sharing operations require live server authorization.

Cancelling voluntary navigation restores the previous editing permission, including while offline. Terminal authorization/compatibility failures remain locked; cancelling a dialog does not restore that permission.

## Transient presence

The version-2 `hello` includes the mounted `accountId`. The server compares it with the independently authenticated socket principal before admitting the page, closing the cookie-switch gap between HTTP session validation and WebSocket upgrade even when both accounts have page membership.

Each page session owns one `y-protocols` Awareness instance, bound to both title and body through the existing Yjs/ProseMirror binding. Participants and colored cursors/selections use relative Yjs positions; they do not enter the Y.Doc, IndexedDB journal, PostgreSQL updates, receipts or save status. Incoming presence bypasses asynchronous document persistence. The server never appears as a participant.

Protocol 2 adds `{type:'presence', update:<base64 awareness bytes>}` in both directions. Clients send only their own single awareness entry; the server reserves one client ID per socket, rejects another socket's ID or a changed identity, validates the entire frame before applying it, and replaces claimed user data with the authenticated account's bounded name and deterministic color. Cursor positions admit only the title/body relative-position shape. Inbound frames are bounded to 4 KiB, server snapshots to 128 KiB. Cursor traffic is coalesced to at most ten sends/second in the browser and excess frames above twenty/second/socket are dropped before server queue admission. Existing connection, page-queue and outbound-buffer bounds remain in force.

Presence admission and broadcast share page ordering with authorization and membership mutations. Every broadcast checks current recipients. Socket removal, revocation and logout remove their awareness state; heartbeat expiry also clears absent peers. Timeout-triggered removal broadcasts are queued and authorized. Revalidation admission failure closes transports while retaining the document owned by an active commit until serialized cleanup; it does not destroy an in-flight room.

Disconnect/pause clears local cursors and remote participants. A verified reconnect sends current local presence again, while the server supplies a transient snapshot of authorized peers. Awareness timers/listeners end with their document session or room. Recent departed clocks have a bounded tail; live sockets retain their client-ID reservation even after a null state or timeout. No presence frame acknowledges an edit or claims durable storage.

While concurrent deletions leave the shared body temporarily empty, cursor-only metadata refreshes wait for committed repair. This prevents ProseMirror's implicit ID-less paragraph from becoming a document update. Actual document edits remain admitted; server repair retains the stable-ID validation boundary.

## Release boundary

Two distinct real Better Auth accounts must demonstrate invitation joins, owner/editor boundaries, concurrent durable editing, invitation invalidation, active/offline revocation and recovery. Local captured-email tests establish local behavior only. The matching sharing build was deployed on 2026-10-02 and passed these hosted checks with actual email login and three independent Chromium contexts; see [dated evidence](verification.md#2026-10-02-hosted-shared-page-rollout-and-two-account-proof). Page deletion requires the separate retention/recovery policy decision; hosted auth renewal/expiry and backup/restore remain open.
