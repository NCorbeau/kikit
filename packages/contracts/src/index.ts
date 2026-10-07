import { z } from 'zod';
import { MAX_UPDATE_BYTES } from './protocol-schema.js';
export { PROTOCOL_VERSION, MAX_UPDATE_BYTES } from './protocol-schema.js';

export { DOCUMENT_SCHEMA_VERSION, TITLE_FRAGMENT, BODY_FRAGMENT, MAX_DOCUMENT_BYTES } from './document-schema.js';
export { validateDocument, validateRepairableDocument } from './document-validation.js';
export * from './recovery.js';

export const DATABASE_SCHEMA_VERSION = 7;
export const DEV_ACCOUNT_ID = 'dev-writer';
export const DEV_PAGE_ID = '00000000-0000-4000-8000-000000000001';
export const MAX_WIRE_BYTES = 400 * 1024;
export const MAX_PRESENCE_BYTES = 4 * 1024;
export const MAX_PRESENCE_SNAPSHOT_BYTES = 128 * 1024;

const base64UpdateSchema = z.string()
  .min(4)
  .max(Math.ceil(MAX_UPDATE_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const batchIdSchema = z.string().uuid();
const presenceUpdateSchema = (maxBytes: number) => z.string().min(4)
  .max(Math.ceil(maxBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    schemaVersion: z.number().int(),
    pageId: z.string().uuid(),
    // Optional only so an older hello reaches the explicit version rejection.
    accountId: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    type: z.literal('update'),
    batchId: batchIdSchema,
    update: base64UpdateSchema,
  }).strict(),
  z.object({ type: z.literal('presence'), update: presenceUpdateSchema(MAX_PRESENCE_BYTES) }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync'),
    protocolVersion: z.number().int(),
    schemaVersion: z.number().int(),
    update: z.string(),
    sequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal('committed'),
    update: z.string(),
    sequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal('ack'),
    batchId: batchIdSchema,
    sequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({ type: z.literal('presence'), update: presenceUpdateSchema(MAX_PRESENCE_SNAPSHOT_BYTES) }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    batchId: batchIdSchema.optional(),
  }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export interface DevSession {
  accountId: string;
  pageId: string;
  protocolVersion: number;
  schemaVersion: number;
}

export type PageRole = 'owner' | 'editor';
// Older account hints have no role. They never authorize sharing controls.
export interface PageSummary { id: string; title: string; createdAt: string; role?: PageRole }
export interface WorkspaceSession { accountId: string; email: string; fixture: boolean }
export const workspaceAccountSchema = z.object({ accountId: z.string().min(1), email: z.string(), fixture: z.boolean() });
export const pageRoleSchema = z.enum(['owner', 'editor']);
export const pageSummarySchema = z.object({ id: z.string().uuid(), title: z.string(), createdAt: z.string(), role: pageRoleSchema.optional() });
export const invitationTokenSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);
export const joinInvitationSchema = z.object({ token: invitationTokenSchema }).strict();
export const invitationSchema = z.object({ token: invitationTokenSchema });
export const sharingStateSchema = z.object({
  invitationActive: z.boolean(),
  members: z.array(z.object({ accountId: z.string().min(1), name: z.string(), email: z.string(), role: pageRoleSchema })),
});
export type SharingState = z.infer<typeof sharingStateSchema>;
export const workspaceSchema = z.object({ account: workspaceAccountSchema.nullable(), pages: z.array(pageSummarySchema) });
export const pageSessionSchema = z.object({
  accountId: z.string().min(1), pageId: z.string().uuid(),
  protocolVersion: z.number().int(), schemaVersion: z.number().int(),
});

export function encodeUpdate(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeUpdate(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
