import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, customType, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

// pg returns bytea as Buffer. Preserve the exact Yjs bytes without text/JSON conversion.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// Better Auth owns these records; page permissions stay in page_grants.
export const user = pgTable('auth_user', {
  id: text('id').primaryKey(), name: text('name').notNull(),
  email: text('email').notNull().unique(), emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'), createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const session = pgTable('auth_session', {
  id: text('id').primaryKey(), token: text('token').notNull().unique(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'), userAgent: text('user_agent'),
  createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('auth_session_user_idx').on(table.userId)]);
export const account = pgTable('auth_account', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'), password: text('password'),
  createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('auth_account_user_idx').on(table.userId)]);
export const verification = pgTable('auth_verification', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('auth_verification_identifier_idx').on(table.identifier)]);

export const schemaVersions = pgTable('schema_versions', {
  version: integer('version').primaryKey(),
});

export const pages = pgTable('pages', {
  id: uuid('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull().default(''),
  schemaVersion: integer('schema_version').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
  initialState: bytea('initial_state').notNull(),
  creationInputHash: text('creation_input_hash'),
  snapshotState: bytea('snapshot_state'),
  snapshotSequence: bigint('snapshot_sequence', { mode: 'number' }).notNull().default(0),
  createdAt: createdAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [index('pages_owner_idx').on(table.ownerId)]);

export const pageGrants = pgTable('page_grants', {
  pageId: uuid('page_id').notNull(),
  accountId: text('account_id').notNull(),
  role: text('role').$type<'owner' | 'editor'>().notNull(),
}, table => [
  primaryKey({ name: 'page_grants_pkey', columns: [table.pageId, table.accountId] }),
  foreignKey({ name: 'page_grants_page_id_fkey', columns: [table.pageId], foreignColumns: [pages.id] }),
  check('page_grants_role_check', sql`${table.role} IN ('owner', 'editor')`),
]);

// Only the current invitation hash is retained. Replacement invalidates the old
// link without changing any grants; the plaintext secret is returned once.
export const pageInvitations = pgTable('page_invitations', {
  pageId: uuid('page_id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: createdAt(),
}, table => [
  foreignKey({ name: 'page_invitations_page_id_fkey', columns: [table.pageId], foreignColumns: [pages.id] }),
  check('page_invitations_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
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
  repairPayload: bytea('repair_payload'),
  createdAt: createdAt(),
}, table => [
  primaryKey({ name: 'receipts_pkey', columns: [table.pageId, table.batchId] }),
  foreignKey({ name: 'receipts_page_id_fkey', columns: [table.pageId], foreignColumns: [pages.id] }),
]);
