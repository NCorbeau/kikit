import { DEFAULT_DATABASE_URL, requireDevelopmentFixture } from './config.js';
import { createPool, migrateDatabase } from './persistence.js';

requireDevelopmentFixture();
const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
try { await migrateDatabase(pool); console.info('Kikit database schema and development fixture are ready.'); }
finally { await pool.end(); }
