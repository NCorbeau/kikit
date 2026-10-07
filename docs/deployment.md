# Railway deployment

Updated on 2026-10-07. Merged main `d9de585` remains the recorded deployment with document schema 2, database schema 4 and wire protocol 2. Health/app-shell and unauthenticated-denial checks passed; hosted checklist editing/synchronization remains unverified. The first command run required manual app deployment after a one-shot status-check bug; the correction is merged into main `0d86fff`, but a full automated rollout remains unverified. The current deletion/compaction/recovery source requires database schema 7 and has not been deployed. See [the dated rollout record](verification.md#2026-10-05-task-list-rollout-and-migration-job-status-correction), [deletion contract](deletion-contract.md) and [snapshot contract](snapshot-contract.md).

Historical shared-page rollout on 2026-10-02: Merged main `3353cc8` is deployed with one application instance and the existing PostgreSQL service in Amsterdam. Matching web/server assets use protocol 2, document schema 1 and database schema 3. Hosted two-account checks passed invitation/QR joins, concurrent editing, owner/editor controls, private-page denial, invitation invalidation, active/offline revocation, binary recovery/rejoin and transient presence/cursors. Natural session renewal/expiry remains unverified; scheduled backups and hosted restoration are deferred for disposable test notes. See [dated verification](verification.md#2026-10-02-hosted-shared-page-rollout-and-two-account-proof).

## Selected setup

Use one application instance and PostgreSQL in the same Railway environment and Amsterdam region, with private database networking. The application serves the built web app, authentication routes, and custom WebSocket sync from one HTTPS origin.

The selected Kikit budget is a $5/month resource-usage target before tax, including its application, database, and storage. Railway Hobby starts at $5/month and includes $5 of resource usage across the workspace; the actual bill depends on usage. The authorized compute hard limit is $20/month for the whole workspace. Railway supports project usage tracking but not a separate project dollar cap, so $5 is a planning target rather than an enforced Kikit limit. Reaching the workspace hard limit takes all workspace workloads offline. Backups/storage count toward usage; the target is not a measured cost guarantee. Verify the configured limit and current/projected workspace usage before provisioning. [Railway plans](https://docs.railway.com/pricing/plans), [cost controls](https://docs.railway.com/pricing/cost-control).

Use Resend Free, currently 3,000 emails/month and 100/day. Add a sender subdomain you control, apply the DNS records Resend provides, and wait for verification. Turn off email link tracking so the one-use login URL is not rewritten. Configure a sending-only API key and sender address in secret settings. [Resend pricing](https://resend.com/pricing), [domain verification](https://resend.com/docs/dashboard/domains/introduction).

## Build and service settings

The to-do list source added on 2026-10-04 was deployed on 2026-10-05 at merged main `d9de585`. It applied `0003_task_lists.sql` (database schema 4), document schema 2 and matching web/server assets; wire protocol remains 2. Stop/drain the old server before applying the migration so old sockets cannot continue editing after the compatibility upgrade. No new tables or runtime grants are needed. Preserve existing browser journals, including pending schema-1 drafts, and verify checklist editing/reload/synchronization after any separately authorized rollout. See [the task-list upgrade contract](task-lists-contract.md).

The sharing rollout applied `0002_shared_pages.sql` (database schema 3), granted the restricted runtime role access to `page_invitations`, and deployed matching protocol-2 web/server assets. Existing account/document/update/receipt fingerprints were unchanged across migration. The temporary private-network migration service was removed. Subsequent deployments still require the stop/drain procedure below; automatic deployments remain disabled.

1. Use the repository root as the service root. The root `Dockerfile` builds Node 24/pnpm 12.5.1, then copies the web bundle and production server dependencies into a non-root runtime image. `.dockerignore` excludes environment files and private local agent references.
2. Remove stale build/start overrides that target the fixture. Use the Dockerfile's default start command. Root `pnpm start` also exists for a prepared Node workspace, fixing the original Railpack detection failure; Docker is the selected build route.
3. Set one replica, no overlap, healthcheck `/api/health`, and a 30-second shutdown grace. Keep automatic deployments disabled until the stop/drain procedure below is in place.
4. Use an HTTPS domain and set `KIKIT_ORIGIN` to its exact origin, without a trailing slash. Configure these server-only variables:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` (also set by the image) |
| `DATABASE_URL` | Private PostgreSQL URL for the restricted runtime role |
| `KIKIT_ORIGIN` | Exact public HTTPS origin |
| `BETTER_AUTH_SECRET` | At least 32 random characters, generated/stored through secret settings |
| `RESEND_API_KEY` | Sending key for the verified domain |
| `KIKIT_EMAIL_FROM` | Verified sender, e.g. `Kikit <sign-in@auth.example.com>` |
| `PORT` | Railway-provided listening port |

Leave `KIKIT_DEV_FIXTURE` and `KIKIT_TEST_FAULTS` unset. Do not supply migration credentials to the application process. The app binds `0.0.0.0`, trusts one proxy hop, and uses HTTPS Secure cookies in production.

This setup uses the Dockerfile and explicit service settings; it does not require a `railway.json` or `railway.toml` file. [Configuration reference](https://docs.railway.com/config-as-code/reference).

## One-command updates

Added 2026-10-05. After the setup below, run updates from the repository root:

```sh
pnpm run deploy
```

The command uploads a clean Git archive of committed `HEAD`, including migrations and matching web/server assets. It does not push Git or include uncommitted/ignored files. It refuses a dirty working tree, an unfinished app deployment, an active migration job, or another local deployment for the same project/environment. Complete the normal release checks before running it. You can preview targets with `pnpm run deploy --dry-run` without changing Railway.

One-time setup:

1. Install Railway CLI and run `railway login` (the command flags were checked against CLI 5.63.1). Copy `deploy.config.example.json` to ignored `deploy.config.json`; fill in the existing project, environment, app service UUIDs and exact HTTPS origin. Use service UUIDs to avoid ambiguous names. Keep automatic deployments disabled and one app replica with `/api/health` and 30-second draining as above.
2. Create an empty service named `kikit-migrations` in the existing environment and Amsterdam region. Set its root to the repository root, use the root Dockerfile, and set its start command to `node apps/server/node_modules/tsx/dist/cli.mjs apps/server/src/migrate-deployment.ts`. Set no public domain, volume, healthcheck, scheduled trigger or GitHub automatic deployment; set its restart policy to **Never** and one replica. The script uploads source to this service each time, so it need not have a GitHub source attached. Add its UUID to the local configuration.
3. Give only this service `NODE_ENV=production` and `KIKIT_MIGRATION_DATABASE_URL` using the existing migration role and private PostgreSQL host. Leave fixture/test flags unset. Do not put migration credentials in shared variables or the app service. The migration service retains its secret for subsequent runs, but its process exits after each job; it is not a second running app. Each release builds the snapshot for both services and consumes build/short-lived job resources within the existing plan; no new plan or cost guarantee is implied.
4. Review runtime grants for the migrations being released. The task-list migration needs no additional grants; future new tables may. The script does not grant privileges automatically. Commit the deployment automation before its first run, so the uploaded archive contains the new migration entry point.

The script checks both services before stopping the app, requests removal of the current successful app deployment, and waits until the listing reports it removed or no longer includes active deployments. It then deploys the migration job and waits for that exact deployment to reach `SUCCESS` with `deploymentStopped=true`, a nonempty set of `EXITED` instances, and the exact job’s final completion log marker. Railway retains `SUCCESS` for successful one-shot exits; startup status alone is insufficient. The job acquires the same database ownership lock as the app before applying migrations and holds it until completion; an old server still holding the lock makes the job fail safely. Applied migrations are validated/skipped by the existing runner. After successful job exit, the script deploys the app from the same archive, waits for its exact deployment's `SUCCESS` status and the public `/api/health` response. It retains the idle migration service for the next command. The manual temporary-service procedure below remains available.

Failures stop the sequence and may leave the app offline. Inspect the named deployment in Railway before retrying `pnpm run deploy`; pending migrations are retry-safe. Do not automatically redeploy an older app against an upgraded schema. A timeout stops local polling, not the remote job or database operation. If interrupted, inspect running deployments before removing the local lock file named in the error. Coordinate operators: the local lock does not serialize deployment commands from different computers, and this script must not run alongside dashboard deployments or another release process. Hosted validation of this automation remains pending.

The 2026-10-05 first run exposed the original `COMPLETED`-status assumption. The merged correction recognizes a stopped successful migration job and waits for its completion marker after connection cleanup. The original command stalls after migration and refuses the retained stopped job on its next run. A full hosted rollout using the corrected command remains a release gate.

Provider command references: [upload](https://docs.railway.com/cli/up), [deployment listing](https://docs.railway.com/cli/deployment), [stop](https://docs.railway.com/cli/down).

## Migration and runtime roles

Create separate login roles through a privileged database connection. The migration role owns the application schema/tables and can apply DDL. Grant it `CONNECT` and `CREATE` on the application database: Drizzle issues `CREATE SCHEMA IF NOT EXISTS` even for an existing schema, which requires the database-level `CREATE` privilege. This does not grant the role PostgreSQL `CREATEDB` or superuser privileges. Grant the runtime role only `CONNECT` on the database and the narrower schema/table privileges below. The runtime role has no superuser, database creation, role creation, schema creation, or migration-history write privileges. Keep passwords in provider secrets; do not paste them into tracked SQL.

Run schema migration as a separate one-off process in the private network using the same image. Give that process only `KIKIT_MIGRATION_DATABASE_URL` for the privileged role and override its command with:

```sh
node apps/server/node_modules/tsx/dist/cli.mjs apps/server/src/migrate.ts
```

Do not attach the application's HTTP healthcheck to this one-off process. It exits after reporting that the schema is ready. Remove the process and its migration secret when finished. The initial hosted one-off service was removed after successful migration on 2026-10-02. For an installed Node workspace the equivalent command is `pnpm db:migrate:production`. Never run `pnpm db:migrate` in production: that script explicitly opts into the development fixture and is rejected there.

After migration, grant the runtime role the following access in the dedicated application schema (the example uses `public`):

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kikit_runtime;
GRANT SELECT ON schema_versions TO kikit_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  auth_user, auth_session, auth_account, auth_verification,
  pages, page_grants, page_invitations, document_updates, receipts
TO kikit_runtime;
```

No runtime sequence grant is needed by the current tables. Review grants after each new migration. The local restore drill exercises these grants through real account signup, page creation, loading/writing, and verifies runtime DDL denial. Hosted PostgreSQL 18.6 role creation and initial private-network migration were verified on 2026-10-02. The sharing rollout rechecked schema 3, invitation privileges and actual runtime DDL denial; the new table is owned by the existing migration role. Hosted restore remains pending.

## First start and subsequent deployment

First start: apply migrations, grant runtime access, then deploy the account app. Health remains unavailable if the database schema is missing. Verify a real magic-link login, cookies, a private note, two-device synchronization, and denial from a second account.

Subsequent releases require brief downtime. Stop and drain the old application before starting the replacement or applying migrations. The database ownership lock intentionally rejects a second account server with independent rooms. A default rolling deployment starts the new process before stopping the old one and will fail this guard, even with overlap set to zero. Manually remove/stop the active deployment, wait for shutdown, then trigger the new one. Preserve the PostgreSQL service/volume. Browser journals retain offline edits through that interval. [Railway deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

Drain has no timeout that releases a still-running transaction. A database network blackhole can exceed the platform grace; forced termination leaves unacknowledged work recoverable through receipts and client retries. No zero-downtime or availability target is claimed. Restore a compatible database backup rather than running an old app against a newer incompatible schema.

## Backups and restore

On 2026-10-02 the user chose to deploy first for disposable test notes and defer scheduled backups and the hosted restore drill. On 2026-10-07 the user selected daily backups, six-day snapshot retention, up to 24 hours of server-data loss, and restoration within four hours after recovery starts as v1 targets. These targets are unverified; the deployment still has no tested hosted recovery guarantee. Review actual cost within the existing plan and spending limits before enabling paid resources. Missed backups can exceed the intended recovery window. See the [accepted policy](data-policy.md) and [Railway backup behavior](https://docs.railway.com/volumes/backups).

Before valuable notes, run a hosted restore drill with synthetic data:

The [prepared hosted recovery plan](hosted-recovery-plan.md) records the current provider constraints, a disposable capability/isolation experiment and its proposed cost allowance. Provisioning that experiment and enabling production backups require separate authorization; neither has run.

1. Create two test accounts and a private note; record its title, document sequence, binary state, and a known receipt. Trigger a manual backup and confirm its completion.
2. Prove an isolated restoration path without replacing the active volume. Railway volume restores are constrained to their existing project/environment; validate isolation and resource cost before enabling the drill. Do not treat the local logical restore as proof of volume recovery. Keep the active database and its volume intact until a concrete recovery procedure is reviewed.
3. Start the compatible app with the same auth secret. Verify existing account access, private-page denial, exact binary records/receipt identity, a duplicate retry returning its original sequence, and another successful edit.
4. Record the backup timestamp, actual restore duration, results, and retained volume. Reconcile known deletions before reopening a restored system; pre-deletion backups can retain note content until expiry. Confirm daily scheduling continues. Do not claim the daily schedule, six-day retention or four-hour restoration target is met until hosted evidence supports it.

The local equivalent is `pnpm test:restore` after `pnpm db:up`. It dumps/restores uniquely named temporary databases in local Compose, compares account/session/document/history/receipt records, checks retry identity and continued editing, and cleans up. This proves logical PostgreSQL restoration locally; it does not prove Railway volume recovery or the daily schedule. A restored server cannot recall downloaded copies, and drafts predating or following the backup still depend on their browser journal or recovery export.
