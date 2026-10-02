import { DEFAULT_DATABASE_URL, fixtureEnabled } from './config.js';
import { createPool, migrateDatabase } from './persistence.js';
import { seedDevelopmentPage } from './development-seed.js';

const fixture = fixtureEnabled();
const connectionString = process.env.NODE_ENV === 'production'
  ? process.env.KIKIT_MIGRATION_DATABASE_URL
  : process.env.DATABASE_URL ?? (fixture ? DEFAULT_DATABASE_URL : undefined);
if (!connectionString) throw new Error('Set a database URL explicitly; production migrations require KIKIT_MIGRATION_DATABASE_URL.');
const pool = createPool(connectionString);
try {
  await migrateDatabase(pool);
  if (fixture) await seedDevelopmentPage(pool);
  console.info(`Kikit database schema${fixture ? ' and development fixture' : ''} is ready.`);
}
finally {
  await pool.end();
}
