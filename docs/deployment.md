# Railway deployment

Prepared on 2026-10-02 for the private account slice. The local implementation did not create cloud resources or secrets. Railway setup was authorized on 2026-10-02; hosted configuration and verification remain pending.

## Selected setup

Use one application instance and PostgreSQL in the same Railway environment and Amsterdam region, with private database networking. The application serves the built web app, authentication routes, and custom WebSocket sync from one HTTPS origin.

The selected Kikit budget is a $5/month resource-usage target before tax, including its application, database, and storage. Railway Hobby starts at $5/month and includes $5 of resource usage across the workspace; the actual bill depends on usage. The authorized compute hard limit is $20/month for the whole workspace. Railway supports project usage tracking but not a separate project dollar cap, so $5 is a planning target rather than an enforced Kikit limit. Reaching the workspace hard limit takes all workspace workloads offline. Backups/storage count toward usage; the target is not a measured cost guarantee. Verify the configured limit and current/projected workspace usage before provisioning. [Railway plans](https://docs.railway.com/pricing/plans), [cost controls](https://docs.railway.com/pricing/cost-control).

Use Resend Free, currently 3,000 emails/month and 100/day. Add a sender subdomain you control, apply the DNS records Resend provides, and wait for verification. Turn off email link tracking so the one-use login URL is not rewritten. Configure a sending-only API key and sender address in secret settings. [Resend pricing](https://resend.com/pricing), [domain verification](https://resend.com/docs/dashboard/domains/introduction).

## Build and service settings

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

Railway's legacy `railway.json`/`railway.toml` configuration is deprecated in the current provider documentation, so this slice uses the Dockerfile and explicit service settings. [Configuration reference](https://docs.railway.com/config-as-code/reference).

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
  pages, page_grants, document_updates, receipts
TO kikit_runtime;
```

No runtime sequence grant is needed by the current tables. Review grants after each new migration. The local restore drill exercises these grants through real account signup, page creation, loading/writing, and verifies runtime DDL denial. Hosted PostgreSQL 18.6 role creation, migration over the private network, runtime credentials on the database host, and actual runtime DDL denial were verified on 2026-10-02; application signup/writing and hosted restore checks remain pending.

## First start and subsequent deployment

First start: apply migrations, grant runtime access, then deploy the account app. Health remains unavailable if the database schema is missing. Verify a real magic-link login, cookies, a private note, two-device synchronization, and denial from a second account.

Subsequent releases require brief downtime. Stop and drain the old application before starting the replacement or applying migrations. The database ownership lock intentionally rejects a second account server with independent rooms. A default rolling deployment starts the new process before stopping the old one and will fail this guard, even with overlap set to zero. Manually remove/stop the active deployment, wait for shutdown, then trigger the new one. Preserve the PostgreSQL service/volume. Browser journals retain offline edits through that interval. [Railway deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

Drain has no timeout that releases a still-running transaction. A database network blackhole can exceed the platform grace; forced termination leaves unacknowledged work recoverable through receipts and client retries. No zero-downtime or availability target is claimed. Restore a compatible database backup rather than running an old app against a newer incompatible schema.

## Backups and restore

Enable daily backups on the PostgreSQL volume. Railway currently retains daily backups for six days; backup storage is billed incrementally. With a healthy daily schedule, the initial recovery expectation is roughly up to 24 hours of server data loss. Missed backups can increase that window. No restoration time guarantee is set. [Railway backup behavior](https://docs.railway.com/volumes/backups).

Before valuable notes, run a hosted restore drill with synthetic data:

1. Create two test accounts and a private note; record its title, document sequence, binary state, and a known receipt. Trigger a manual backup and confirm its completion.
2. Stop/drain the app. Restore the chosen backup through the PostgreSQL volume's Backups UI, review the staged volume replacement, and deploy it. Keep the previous volume until verification succeeds.
3. Start the compatible app with the same auth secret. Verify existing account access, private-page denial, exact binary records/receipt identity, a duplicate retry returning its original sequence, and another successful edit.
4. Record the backup timestamp, actual restore duration, results, and retained volume. Confirm daily scheduling continues. Do not claim this drill passed until it has run on Railway.

The local equivalent is `pnpm test:restore` after `pnpm db:up`. It dumps/restores uniquely named temporary databases in local Compose, compares account/session/document/history/receipt records, checks retry identity and continued editing, and cleans up. This proves logical PostgreSQL restoration locally; it does not prove Railway volume recovery or the daily schedule. A restored server cannot recall downloaded copies, and drafts predating or following the backup still depend on their browser journal or recovery export.
