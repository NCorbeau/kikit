import { and, asc, eq, gt, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as Y from 'yjs';
import { documentUpdates, pages } from './schema.js';

/** Caller holds the page lock, so snapshot and committed tail are one boundary. */
export async function hydrateStoredDocument(db: NodePgDatabase, page: typeof pages.$inferSelect, doc: Y.Doc): Promise<number> {
  const boundary = page.snapshotSequence;
  if (boundary < 0 || boundary > page.sequence || (!page.snapshotState && boundary !== 0)) {
    throw new Error('Invalid document snapshot boundary');
  }
  Y.applyUpdate(doc, page.snapshotState ?? page.initialState);
  const updates = await db.select({ sequence: documentUpdates.sequence, payload: documentUpdates.payload })
    .from(documentUpdates).where(and(eq(documentUpdates.pageId, page.id),
      gt(documentUpdates.sequence, boundary), lte(documentUpdates.sequence, page.sequence)))
    .orderBy(asc(documentUpdates.sequence));
  if (updates.length !== page.sequence - boundary
    || updates.some((row, index) => row.sequence !== boundary + index + 1)) {
    throw new Error('Incomplete committed document tail');
  }
  let bytes = 0;
  for (const row of updates) { Y.applyUpdate(doc, row.payload); bytes += row.payload.byteLength; }
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete committed document state');
  return bytes;
}
