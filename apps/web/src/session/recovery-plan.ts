import * as Y from 'yjs';
import { MAX_UPDATE_BYTES, validateRepairableDocument, type RecoveryFile } from '@kikit/contracts';
import type { StoredDocument, StoredUpdate } from './local-store';

interface RecoveryImportPlan {
  pendingUpdates: StoredUpdate[];
  prerequisite?: StoredUpdate;
  cachedState?: StoredUpdate;
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/** Plan server replay and local hydration separately, without touching the live
 * editor or journal. The session commits the whole plan before applying it. */
export function planRecoveryImport({ currentState, journal, recovery, committedState }: {
  currentState: Uint8Array;
  journal: StoredDocument;
  recovery: RecoveryFile;
  committedState: Uint8Array;
}): RecoveryImportPlan {
  const candidate = new Y.Doc({ gc: false });
  const server = new Y.Doc({ gc: false });
  const prerequisiteCheck = new Y.Doc({ gc: false });
  const local = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(candidate, currentState);
    for (const record of journal.updates) Y.applyUpdate(candidate, record.update);
    for (const record of recovery.pending) Y.applyUpdate(candidate, record.update);
    Y.applyUpdate(candidate, recovery.update);
    validateRepairableDocument(candidate);

    Y.applyUpdate(server, committedState);
    const committedVector = Y.encodeStateVector(server);
    const known = new Set(journal.updates.map(record => record.id.toLowerCase()));
    const replay = [...journal.updates.filter(record => record.pending),
      ...recovery.pending.filter(record => !known.has(record.batchId.toLowerCase()))];
    // Check every actual outbound prefix: final convergence can hide a batch
    // whose parent appears later or disappeared from restored server storage.
    let ordered = true;
    for (const record of replay) {
      Y.applyUpdate(server, record.update);
      if (server.store.pendingStructs || server.store.pendingDs) ordered = false;
      else {
        try { validateRepairableDocument(server); } catch { ordered = false; }
      }
    }
    const before = Y.encodeStateAsUpdate(server);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(candidate));
    const after = Y.encodeStateAsUpdate(server);
    const missing = sameBytes(before, after) && ordered
      ? new Uint8Array([0, 0]) : Y.diffUpdate(after, committedVector);
    if (missing.byteLength > MAX_UPDATE_BYTES) {
      throw new Error('This recovery is too large to merge in one batch. Recover it as a new private copy.');
    }
    let prerequisite: StoredUpdate | undefined;
    if (missing.length > 2) {
      // Missing history must apply independently to actual committed storage,
      // before every existing/imported pending batch, including after reload.
      Y.applyUpdate(prerequisiteCheck, committedState);
      Y.applyUpdate(prerequisiteCheck, missing);
      if (prerequisiteCheck.store.pendingStructs || prerequisiteCheck.store.pendingDs) {
        throw new Error('This recovery needs missing dependencies. Keep the file and recover a new private copy.');
      }
      validateRepairableDocument(prerequisiteCheck);
      prerequisite = { id: crypto.randomUUID(), update: missing, pending: true };
    }

    const pendingUpdates = recovery.pending.map(record => ({ id: record.batchId, update: record.update, pending: true }));
    // Server coverage does not imply device durability. Reconstruct the journal
    // that will commit and cache any recovery history it still lacks. This
    // includes deletion-only changes and creates no additional outbound batch.
    if (prerequisite) Y.applyUpdate(local, prerequisite.update);
    for (const record of journal.updates) Y.applyUpdate(local, record.update);
    for (const record of pendingUpdates) Y.applyUpdate(local, record.update);
    const cachedBefore = Y.encodeStateAsUpdate(local);
    Y.applyUpdate(local, recovery.update);
    const cachedState = sameBytes(cachedBefore, Y.encodeStateAsUpdate(local))
      ? undefined : { id: crypto.randomUUID(), update: recovery.update, pending: false };
    return { pendingUpdates, prerequisite, cachedState };
  } finally {
    candidate.destroy();
    server.destroy();
    prerequisiteCheck.destroy();
    local.destroy();
  }
}
