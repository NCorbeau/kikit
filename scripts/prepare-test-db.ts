import pg from 'pg';

// Fixed local-only test database. Never truncate or replace the development database.
const pool = new pg.Pool({ connectionString: 'postgres://kikit:kikit_local_only@127.0.0.1:54329/postgres' });
try {
  const existing = await pool.query("SELECT 1 FROM pg_database WHERE datname='kikit_e2e'");
  if (!existing.rowCount) await pool.query('CREATE DATABASE kikit_e2e');
  console.log('Local kikit_e2e database ready.');
} finally {
  await pool.end();
}
