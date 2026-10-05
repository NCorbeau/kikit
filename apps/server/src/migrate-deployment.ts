import { createPool } from './persistence.js';
import { migrateDatabase } from './migrations.js';
import { acquireServerOwnership } from './server-lifecycle.js';

// Separate one-shot service: privileged credentials never enter the application.
async function main() {
  if (process.env.NODE_ENV !== 'production' || process.env.KIKIT_DEV_FIXTURE || process.env.KIKIT_TEST_FAULTS) {
    throw new Error('Deployment migrations require production mode without fixture/test flags.');
  }
  const connectionString = process.env.KIKIT_MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('Missing migration database URL.');
  const pool = createPool(connectionString);
  const ownership = await acquireServerOwnership(pool, false);
  try {
    // The application lock proves the old process released ownership, and keeps
    // another app from starting until migration commit/rollback has settled.
    await migrateDatabase(pool);
    console.info('Kikit deployment migrations completed.');
  } finally {
    ownership?.release(true);
    await pool.end();
  }
}
main().catch(() => {
  console.error('Deployment migration failed. Check configuration, database access, migration history and whether the old app has drained. The app must remain stopped.');
  process.exitCode = 1;
});
