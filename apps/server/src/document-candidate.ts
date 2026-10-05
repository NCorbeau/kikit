import * as Y from 'yjs';
import { normalizeEmptyBody, projectTitle } from './document.js';
import { DependencyMissing, InvalidDocument } from './sync-protocol.js';

interface PreparedUpdate {
  title: string;
  repairedUpdate?: Uint8Array;
}

/** Validate an isolated candidate; the live room changes only after COMMIT. */
export function prepareCommittedUpdate(committedDoc: Y.Doc, update: Uint8Array): PreparedUpdate {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(committedDoc));
    Y.applyUpdate(candidate, update);
    if (candidate.store.pendingStructs || candidate.store.pendingDs) throw new DependencyMissing();
    const beforeRepair = Y.encodeStateVector(candidate);
    const needsRepair = normalizeEmptyBody(candidate);
    const title = projectTitle(candidate);
    // Receipt hashes cover submitted bytes. Repairs join them in the committed payload.
    if (needsRepair) {
      return { title, repairedUpdate: Y.mergeUpdates([update, Y.encodeStateAsUpdate(candidate, beforeRepair)]) };
    }
    return { title };
  } catch (error) {
    if (error instanceof DependencyMissing) throw error;
    throw new InvalidDocument();
  } finally {
    candidate.destroy();
  }
}
