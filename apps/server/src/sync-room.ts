import type pg from 'pg';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  BODY_FRAGMENT,
  DEV_ACCOUNT_ID,
  DOCUMENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  encodeUpdate,
  type ClientMessage,
} from '@kikit/contracts';
import { commitUpdate, loadPage, type CommitResult } from './persistence.js';
import { normalizeEmptyBody, projectTitle } from './document.js';
import { canAccessPage, type Principal } from './pages.js';
import { AccessError } from './persistence-errors.js';
import { PageQueues } from './queue.js';
import { TestFaults } from './test-faults.js';
import {
  DependencyMissing,
  InvalidDocument,
  isRejectedUpdate,
  reportFailure,
  sendMessage,
} from './sync-protocol.js';

interface Room {
  doc: Y.Doc;
  sequence: number;
  sockets: Set<WebSocket>;
}
type UpdateMessage = Extract<ClientMessage, { type: 'update' }>;

/** Owns per-page sequencing from authorization through commit and propagation. */
export class SyncRooms {
  readonly queues = new PageQueues();
  private readonly rooms = new Map<string, Room>();
  private readonly principals = new WeakMap<WebSocket, Principal>();

  constructor(private readonly pool: pg.Pool, private readonly faults: TestFaults) {}

  get size(): number { return this.rooms.size; }

  join(pageId: string, socket: WebSocket, principal: Principal = { accountId: DEV_ACCOUNT_ID }): Promise<void> {
    this.principals.set(socket, principal);
    return this.queues.run(pageId, 0, async () => {
      const loaded = await loadPage(this.pool, pageId, principal.accountId, principal.sessionId);
      let room = this.rooms.get(pageId);
      if (room && room.sequence !== loaded.sequence) {
        loaded.doc.destroy();
        this.invalidate(pageId);
        throw new Error('Room sequence changed outside this server');
      }
      if (socket.readyState !== 1) {
        loaded.doc.destroy();
        return;
      }
      if (room) loaded.doc.destroy();
      else {
        room = { ...loaded, sockets: new Set() };
        this.rooms.set(pageId, room);
      }
      if (socket.readyState !== 1) return;
      room.sockets.add(socket);
      sendMessage(socket, {
        type: 'sync',
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        sequence: room.sequence,
        update: encodeUpdate(Y.encodeStateAsUpdate(room.doc)),
      });
    });
  }

  leave(pageId: string, socket: WebSocket): void {
    const room = this.rooms.get(pageId);
    room?.sockets.delete(socket);
    if (!room || room.sockets.size > 0) return;
    // Cleanup runs behind accepted work, so no room disappears during COMMIT.
    void this.queues.run(pageId, 0, async () => {
      if (this.rooms.get(pageId) === room && room.sockets.size === 0) {
        this.rooms.delete(pageId);
        room.doc.destroy();
      }
    }).catch(() => undefined);
  }

  update(pageId: string, socket: WebSocket, message: UpdateMessage, update: Uint8Array): Promise<void> {
    return this.queues.run(pageId, update.byteLength, async () => {
      const room = this.rooms.get(pageId);
      if (!room || !room.sockets.has(socket)) throw new Error('Handshake has not completed');
      await this.pruneUnauthorized(pageId, room);
      if (!room.sockets.has(socket)) throw new AccessError('Session expired or revoked');
      const result = await this.commitToStorage(pageId, socket, room, message, update);
      // Database revocation/expiry during a commit must be checked before propagation.
      try { await this.pruneUnauthorized(pageId, room); }
      catch (error) { this.invalidate(pageId); throw error; }
      // A duplicate receipt keeps its original sequence. Only new commits advance the room.
      if (!result.duplicate) this.applyCommittedUpdate(pageId, room, socket, result, update);
      // The author needs the original server repair before its receipt, even on retry.
      if (result.committedUpdate) {
        sendMessage(socket, {
          type: 'committed',
          update: encodeUpdate(result.committedUpdate),
          sequence: result.sequence,
        });
      }
      if (this.faults.consumeDroppedAcknowledgement()) {
        socket.close(1012, 'Injected lost acknowledgement');
        return;
      }
      sendMessage(socket, { type: 'ack', batchId: message.batchId, sequence: result.sequence });
    });
  }

  private async commitToStorage(
    pageId: string,
    socket: WebSocket,
    room: Room,
    message: UpdateMessage,
    update: Uint8Array,
  ): Promise<CommitResult> {
    try {
      const principal = this.principals.get(socket)!;
      let title = '';
      return await commitUpdate(this.pool, pageId, principal.accountId, message.batchId, update, {
        sessionId: principal.sessionId,
        beforeCommit: this.faults.beforeCommit,
        validate: () => prepareCommittedUpdate(room.doc, update, value => { title = value; }),
        projectTitle: () => title,
        afterCommit: this.faults.afterCommit,
      });
    } catch (error) {
      // A lost COMMIT response can hide success. Rebuild from storage before any
      // more work; receipt retries resolve the original batch's durable outcome.
      if (!isRejectedUpdate(error)) {
        reportFailure(socket, error, message.batchId);
        this.invalidate(pageId);
      }
      throw error;
    }
  }

  /** Auth mutations and the expiry sweep remove sockets before subsequent broadcasts. */
  async revalidate(): Promise<void> {
    // Include admitted joins whose room has not been installed yet. A logout
    // response must wait behind those handshakes as well as existing rooms.
    const pageIds = new Set([...this.rooms.keys(), ...this.queues.pageIds]);
    await Promise.all([...pageIds].map(pageId => this.queues.run(pageId, 0, async () => {
      const room = this.rooms.get(pageId);
      if (room) await this.pruneUnauthorized(pageId, room);
    }).catch(() => this.invalidate(pageId))));
  }

  private async pruneUnauthorized(pageId: string, room: Room): Promise<void> {
    for (const socket of room.sockets) {
      const principal = this.principals.get(socket)!;
      if (!principal.sessionId) continue;
      if (!await canAccessPage(this.pool, pageId, principal)) {
        room.sockets.delete(socket);
        reportFailure(socket, new AccessError('Session expired or revoked'));
      }
    }
  }

  private applyCommittedUpdate(
    pageId: string,
    room: Room,
    author: WebSocket,
    result: CommitResult,
    submittedUpdate: Uint8Array,
  ): void {
    try {
      const committedUpdate = result.committedUpdate ?? submittedUpdate;
      Y.applyUpdate(room.doc, committedUpdate);
      room.sequence = result.sequence;
      for (const peer of room.sockets) {
        if (peer !== author) {
          sendMessage(peer, {
            type: 'committed',
            update: encodeUpdate(committedUpdate),
            sequence: result.sequence,
          });
        }
      }
    } catch {
      this.invalidate(pageId);
      throw new Error('Committed room application failed');
    }
  }

  private invalidate(pageId: string): void {
    const room = this.rooms.get(pageId);
    if (!room) return;
    this.rooms.delete(pageId);
    room.doc.destroy();
    for (const socket of room.sockets) socket.close(1012, 'Reload committed state');
  }

  destroy(): void {
    for (const room of this.rooms.values()) room.doc.destroy();
    this.rooms.clear();
  }
}

function prepareCommittedUpdate(committedDoc: Y.Doc, update: Uint8Array, onTitle: (title: string) => void): Uint8Array | void {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(committedDoc));
    Y.applyUpdate(candidate, update);
    if (candidate.store.pendingStructs || candidate.store.pendingDs) throw new DependencyMissing();
    const needsRepair = candidate.getXmlFragment(BODY_FRAGMENT).length === 0;
    const beforeRepair = Y.encodeStateVector(candidate);
    normalizeEmptyBody(candidate);
    onTitle(projectTitle(candidate));
    // Receipt hashes cover submitted bytes. Repairs join them in the committed payload.
    if (needsRepair) return Y.mergeUpdates([update, Y.encodeStateAsUpdate(candidate, beforeRepair)]);
  } catch (error) {
    if (error instanceof DependencyMissing) throw error;
    throw new InvalidDocument();
  } finally {
    candidate.destroy();
  }
}
