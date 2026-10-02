# Private account slice

Implemented locally on 2026-10-02. This extends [milestone 1](milestone-contract.md); its fixture-only startup and shell-cache restrictions describe the earlier milestone. The binary durability, receipt, editor, and queue contracts remain in force.

## Versions and data

This original account slice used document/wire version 1 and database schema 2: Better Auth tables and a derived page-list title were added by `0001_accounts.sql`. The subsequent [shared-page slice](shared-pages-contract.md) keeps document schema 1 and advances wire protocol to 2 and database schema to 3. Existing binary states, updates, receipts, ownership, and grants are retained. The list title is updated inside the document commit transaction and truncated to 150 characters; it is not editable storage. No REST document save exists.

Better Auth 1.7.7 uses the Drizzle PostgreSQL adapter. Authentication records live in `auth_user`, `auth_session`, `auth_account`, and `auth_verification`. Credentials and permissions remain outside the Y.Doc. Fixture/historical ownership values are retained rather than silently adopted by newly registered users.

## Login and HTTP boundary

Magic links expire after 10 minutes, are consumed once, and store hashed tokens. Resend delivers plaintext email using a verified sender. The test delivery callback is accepted only with `NODE_ENV=test`; it never exposes a discovery endpoint. Provider response bodies and sign-in URLs are not logged.

Sessions last seven days and renew through the HTTP auth handler after one day. Cookies are HttpOnly and SameSite=Lax, with Secure enabled for the required production HTTPS origin. Cookie session caching is disabled. Better Auth's session lookup validates identity; page authorization is independent. HTTP mutation requests and WebSocket upgrades require the exact configured origin. API responses use `Cache-Control: no-store`; referrer policy is `no-referrer`.

The auth limiter is enabled (60 requests/minute globally per IP, with the magic-link plugin's stricter endpoint limits). Production trusts one reverse-proxy hop. Fastify supplies the client IP through an overwritten internal header; callers cannot choose that header's effective value. Direct public access to the backend outside its trusted proxy is outside this deployment setup.

| Route | Contract |
| --- | --- |
| `/api/auth/*` | Better Auth handler; renewal cookies forwarded to the browser |
| `GET /api/session` | Current account identity, or 401 |
| `GET /api/pages` | Granted pages only; `X-Kikit-Account` identifies the response account |
| `POST /api/pages` | Client UUID; retry preserves initial Yjs identity; another owner's UUID is denied |
| `GET /api/pages/:pageId/session` | Authorized identity and document/protocol versions |
| `/api/sync` | Authenticated WebSocket; page access checked on join and every update |
| `GET /api/health` | 200 only when the database is reachable with the application's expected schema version: 2 for the original account slice, 3 after shared pages |

Each new note is initialized once with an empty title and one empty body paragraph. The owner grant is created in the same transaction. Creation is serialized per account and bounded to 100 owned notes as an initial resource guardrail. Deletion remains deferred. The [shared-page slice](shared-pages-contract.md) adds invitation and membership controls with database schema 3.

## Revocation and durable writes

Each load/write transaction locks the active session row for sharing and the authorized page/grant rows. Logout deletion waits behind an authorized transaction already in progress; later writes fail. Per-page queues order room joins, writes, and revalidation. Auth mutations revalidate admitted joins and live rooms before returning. Existing sockets also undergo a 10-second expiry/revocation sweep, plus checks before commits and propagation. Rejected work is never acknowledged as stored.

One account server holds a database advisory ownership lock for its lifetime. A second server refuses startup. Losing that connection stops admission, closes sockets, drains, and shuts down. This guard is not distributed fencing or replica coordination. Operate one instance and drain/stop it before replacement; a database network partition remains a hardening limitation.

## Browser account changes and recovery

Document journals use the existing IndexedDB format, namespaced by account and page. The shell cache contains static assets only. Local storage retains the last account's identity and page-list metadata as an offline hint, with no cookies/tokens or document body. An offline browser can reopen previously cached notes from that last account; local device access is not protected by fresh server authentication or encryption.

Sign-out removes the offline hint and retains journals. No cache removal is automatic. Listing and creation responses identify their account so a cookie change between requests cannot place another account's response in the mounted workspace. Polling, focus, online events, and cross-tab storage events detect session/account changes.

Before navigation/logout, the session pauses editing and transport, then settles local persistence. Pending committed journal records remain for the same account's next login. Failed local writes remain in memory; leaving is blocked until recovery export succeeds. Session changes and access loss hide the previous editor while keeping its session alive for export, then release it only after the user continues. Recovery files contain binary document state and stable pending batch identities; there is no import UI yet.

## Release boundary

The slice covers magic-link accounts and private notes. Same-account devices synchronize through the custom backend. The [shared-page slice](shared-pages-contract.md) adds invitations, membership management, revocation recovery and transient presence/cursors, advancing the wire protocol to 2 and database schema to 3. Note deletion remains deferred. Hosted private-page denial and two-account sharing passed on 2026-10-02 under the [recorded conditions](verification.md#2026-10-02-hosted-shared-page-rollout-and-two-account-proof).

See [verification](verification.md) for executed checks and [deployment](deployment.md) for hosted setup. Real email login, HTTPS cookie attributes, private synchronization/isolation and logout recovery have recorded hosted evidence. Natural session renewal/expiry remains open. Scheduled Railway backups and a hosted restore must still be tested before valuable production notes are stored.
