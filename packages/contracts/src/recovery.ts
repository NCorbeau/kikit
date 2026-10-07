import * as Y from 'yjs';
import { z } from 'zod';
import { BODY_FRAGMENT, DOCUMENT_SCHEMA_VERSION, MAX_DOCUMENT_BYTES, TITLE_FRAGMENT } from './document-schema.js';
import { validateRepairableDocument } from './document-validation.js';
import { MAX_UPDATE_BYTES, PROTOCOL_VERSION } from './protocol-schema.js';

export const RECOVERY_FORMAT_VERSION = 2;
export const MAX_RECOVERY_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RECOVERY_PENDING_BATCHES = 4096;

export class RecoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryValidationError';
  }
}

export interface RecoveryFile {
  formatVersion: 1 | 2;
  sourceSchemaVersion: 1 | 2;
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  protocolVersion: typeof PROTOCOL_VERSION;
  accountId: string;
  pageId: string;
  exportedAt: string;
  update: Uint8Array;
  pending: Array<{ batchId: string; update: Uint8Array }>;
  title: string;
}

const base64 = (maxBytes: number) => z.string().min(4)
  .max(Math.ceil(maxBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const common = {
  format: z.literal('kikit-recovery'),
  accountId: z.string().min(1).max(128),
  pageId: z.string().uuid(),
  exportedAt: z.string().datetime(),
  update: base64(MAX_DOCUMENT_BYTES),
  cachedUpdates: z.array(z.unknown()).length(0).optional(),
  pending: z.array(z.object({ batchId: z.string().uuid(), update: base64(MAX_UPDATE_BYTES) }).strict())
    .max(MAX_RECOVERY_PENDING_BATCHES),
};
const fileSchema = z.discriminatedUnion('formatVersion', [
  z.object({ ...common, formatVersion: z.literal(1), schemaVersion: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ ...common, formatVersion: z.literal(2), schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
    protocolVersion: z.literal(PROTOCOL_VERSION) }).strict(),
]);

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const binary = atob(value);
  if (binary.length > maxBytes || btoa(binary) !== value) {
    throw new RecoveryValidationError('The recovery file contains an invalid or oversized binary update.');
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Validate without rewriting the source bytes or discarding deleted structures. */
export function validateRecoveryState(update: Uint8Array): string {
  const doc = new Y.Doc({ gc: false });
  try {
    loadState(doc, update);
    const paragraph = doc.getXmlFragment(TITLE_FRAGMENT).get(0) as Y.XmlElement;
    return paragraph.toArray().map(node => node.toString()).join('').slice(0, 150);
  } catch {
    throw new RecoveryValidationError('The recovery document is damaged, incomplete or contains unsupported content.');
  } finally {
    doc.destroy();
  }
}

function loadState(doc: Y.Doc, update: Uint8Array): void {
  if (update.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Oversized document');
  // Decode first so malformed binary fails before attempting integration.
  decodeCompleteUpdate(update);
  Y.applyUpdate(doc, update);
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete document');
  validateRepairableDocument(doc);
}

function decodeCompleteUpdate(update: Uint8Array): ReturnType<typeof Y.decodeUpdate> {
  let reader: Y.UpdateDecoderV1 | undefined;
  class CompleteDecoder extends Y.UpdateDecoderV1 {
    constructor(decoder: ConstructorParameters<typeof Y.UpdateDecoderV1>[0]) {
      super(decoder);
      reader = this;
    }
  }
  const decoded = Y.decodeUpdateV2(update, CompleteDecoder);
  if (!reader || reader.restDecoder.pos !== update.byteLength) throw new Error('Trailing binary data');
  return decoded;
}

/** Format 1/schema 1 can be promoted only when its binary content is unchanged. */
function validateLegacyState(doc: Y.Doc): void {
  for (const block of doc.getXmlFragment(BODY_FRAGMENT).toArray()) {
    if (!(block instanceof Y.XmlElement) || !['paragraph', 'heading'].includes(block.nodeName)) {
      throw new RecoveryValidationError('The older recovery file contains content outside its document version.');
    }
  }
}

function assertIncludedPending(doc: Y.Doc, pending: RecoveryFile['pending']): void {
  const state = Y.decodeStateVector(Y.encodeStateVector(doc));
  const deleted = Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds;
  for (const record of pending) {
    const decoded = decodeCompleteUpdate(record.update);
    for (const struct of decoded.structs) {
      if (struct.id.clock + struct.length > (state.get(struct.id.client) ?? 0)) {
        throw new Error('Pending structure is absent from full state');
      }
    }
    for (const [client, ranges] of decoded.ds.clients) {
      const covered = deleted.clients.get(client) ?? [];
      for (const range of ranges) {
        if (!covered.some(existing => existing.clock <= range.clock
          && existing.clock + existing.len >= range.clock + range.len)) {
          throw new Error('Pending deletion is absent from full state');
        }
      }
    }
    Y.applyUpdate(doc, record.update);
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete pending update');
  }
}

function projectFragment(fragment: Y.XmlFragment): unknown {
  return fragment.toArray().map(node => node instanceof Y.XmlElement
    ? { node: node.nodeName, attributes: Object.entries(node.getAttributes()).sort(([first], [second]) => first.localeCompare(second)),
      children: projectFragment(node) }
    : { text: (node as Y.XmlText).toString() });
}

function assertPendingOrderConsistent(full: Y.Doc, update: Uint8Array, pending: RecoveryFile['pending']): void {
  // A repeated client/clock with different data can be ignored by Yjs when full
  // state is applied first. The journal restores pending records first, so prove
  // that this ordering has the same visible document as the exported full state.
  // Comparing projections permits extra *deleted* history from non-GC pending
  // records when the exporter already garbage-collected that history.
  const pendingFirst = new Y.Doc({ gc: false });
  try {
    for (const record of pending) Y.applyUpdate(pendingFirst, record.update);
    Y.applyUpdate(pendingFirst, update);
    if (pendingFirst.store.pendingStructs || pendingFirst.store.pendingDs) throw new Error('Incomplete pending state');
    validateRepairableDocument(pendingFirst);
    for (const fragment of [TITLE_FRAGMENT, BODY_FRAGMENT]) {
      if (JSON.stringify(projectFragment(full.getXmlFragment(fragment)))
        !== JSON.stringify(projectFragment(pendingFirst.getXmlFragment(fragment)))) {
        throw new Error('Pending content conflicts with full state');
      }
    }
  } finally {
    pendingFirst.destroy();
  }
}

/** The account/page checks bind an import; they never grant server access. */
export function parseRecoveryFile(text: string, context: { accountId: string; pageId?: string }): RecoveryFile {
  if (text.length > MAX_RECOVERY_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_RECOVERY_FILE_BYTES) {
    throw new RecoveryValidationError('The recovery file exceeds the 16 MiB import limit.');
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new RecoveryValidationError('Choose a valid Kikit recovery JSON file.'); }
  const header = raw as Record<string, unknown> | null;
  if (header?.cachedUpdates && (!Array.isArray(header.cachedUpdates) || header.cachedUpdates.length > 0)) {
    throw new RecoveryValidationError('This recovery file contains an incompatible local cache. Keep the file for recovery with a compatible version.');
  }
  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    throw new RecoveryValidationError('The recovery file has an unsupported version, invalid metadata or invalid binary encoding.');
  }
  const file = result.data;
  if (file.accountId !== context.accountId) throw new RecoveryValidationError('Sign in to the account that exported this recovery file.');
  if (context.pageId !== undefined && file.pageId !== context.pageId) {
    throw new RecoveryValidationError('This recovery file belongs to a different note.');
  }
  const seen = new Set<string>();
  for (const record of file.pending) {
    // PostgreSQL UUID identities are case insensitive; keep the source spelling
    // while rejecting aliases that would target the same durable receipt.
    const identity = record.batchId.toLowerCase();
    if (seen.has(identity)) throw new RecoveryValidationError('The recovery file repeats a pending batch identity.');
    seen.add(identity);
  }
  const doc = new Y.Doc({ gc: false });
  try {
    const update = decodeBase64(file.update, MAX_DOCUMENT_BYTES);
    const pending = file.pending.map(record => ({ batchId: record.batchId, update: decodeBase64(record.update, MAX_UPDATE_BYTES) }));
    loadState(doc, update);
    if (file.schemaVersion === 1) validateLegacyState(doc);
    assertIncludedPending(doc, pending);
    assertPendingOrderConsistent(doc, update, pending);
    const paragraph = doc.getXmlFragment(TITLE_FRAGMENT).get(0) as Y.XmlElement;
    return {
      formatVersion: file.formatVersion, sourceSchemaVersion: file.schemaVersion,
      schemaVersion: DOCUMENT_SCHEMA_VERSION, protocolVersion: PROTOCOL_VERSION,
      accountId: file.accountId, pageId: file.pageId, exportedAt: file.exportedAt,
      update, pending, title: paragraph.toArray().map(node => node.toString()).join('').slice(0, 150),
    };
  } catch (error) {
    if (error instanceof RecoveryValidationError) throw error;
    throw new RecoveryValidationError('The recovery document or its pending batches are damaged, incomplete or contain unsupported content.');
  } finally {
    doc.destroy();
  }
}
