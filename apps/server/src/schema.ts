import { sql } from 'drizzle-orm';
import {
  bigint, check, customType, foreignKey, integer, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

// pg returns bytea as Buffer. Preserve the exact Yjs bytes without text/JSON conversion.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const schemaVersions = pgTable('schema_versions', {
  version: integer('version').primaryKey(),
});

export const pages = pgTable('pages', {
  id: uuid('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
  initialState: bytea('initial_state').notNull(),
  createdAt: createdAt(),
});

export const pageGrants = pgTable('page_grants', {
  pageId: uuid('page_id').notNull(),
  accountId: text('account_id').notNull(),
  role: text('role').$type<'owner' | 'editor'>().notNull(),
}, table => [
  primaryKey({ name: 'page_grants_pkey', columns: [table.pageId, table.accountId] }),
  foreignKey({ name: 'page_grants_page_id_fkey', columns: [table.pageId], foreignColumns: [pages.id] }),
  check('page_grants_role_check', sql`${table.role} IN ('owner', 'editor')`),
]);

export const documentUpdates = pgTable('document_updates', {
  pageId: uuid('page_id').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  payload: bytea('payload').notNull(),
  createdAt: createdAt(),
}, table => [
  primaryKey({ name: 'document_updates_pkey', columns: [table.pageId, table.sequence] }),
  foreignKey({ name: 'document_updates_page_id_fkey', columns: [table.pageId], foreignColumns: [pages.id] }),
]);

export const receipts = pgTable('receipts', {
  pageId: uuid('page_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
}, table => [
  primaryKey({ name: 'receipts_pkey', columns: [table.pageId, table.batchId] }),
  foreignKey({ name: 'receipts_page_id_fkey', columns: [table.pageId], foreignColumns: [pages.id] }),
  foreignKey({
    name: 'receipts_page_id_sequence_fkey',
    columns: [table.pageId, table.sequence],
    foreignColumns: [documentUpdates.pageId, documentUpdates.sequence],
  }),
]);
