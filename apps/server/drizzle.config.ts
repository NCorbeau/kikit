import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  migrations: { schema: 'public', table: '__drizzle_migrations' },
});
