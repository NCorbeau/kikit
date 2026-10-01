import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const DOCUMENT_SCHEMA_VERSION = 1;
export const DATABASE_SCHEMA_VERSION = 1;
export const DEV_ACCOUNT_ID = 'dev-writer';
export const DEV_PAGE_ID = '00000000-0000-4000-8000-000000000001';
export const TITLE_FRAGMENT = 'title';
export const BODY_FRAGMENT = 'body';
export const MAX_UPDATE_BYTES = 256 * 1024;
export const MAX_WIRE_BYTES = 400 * 1024;

const base64UpdateSchema = z.string()
  .min(4)
  .max(Math.ceil(MAX_UPDATE_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const batchIdSchema = z.string().uuid();

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    schemaVersion: z.number().int(),
    pageId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal('update'),
    batchId: batchIdSchema,
    update: base64UpdateSchema,
  }).strict(),
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

export function encodeUpdate(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeUpdate(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
