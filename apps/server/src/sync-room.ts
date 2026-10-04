import type pg from 'pg';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  DEV_ACCOUNT_ID,
  DOCUMENT_SCHEMA_VERSION,
  MAX_PRESENCE_SNAPSHOT_BYTES,
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
import { RoomPresence } from './presence.js';
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
  presence: RoomPresence;
  presenceIsSerialized: boolean;
}
type UpdateMessage = Extract<ClientMessage, { type: 'update' }>;

/** Owns per-page sequencing from authorization through commit and propagation. */
export class SyncRooms {
  readonly queues = new PageQueues();
  private readonly rooms = new Map<string, Room>();
  private readonly principals = new WeakMap<WebSocket, Principal>();

  constructor(private readonly pool: pg.Pool, private readonly faults: TestFaults) {}

  get size(): number {
    return this.rooms.size;
  }

  /** Membership changes share ordering with admitted joins, writes and broadcasts. */
  accessMutation<T>(pageId: string, task: () => Promise<T>): Promise<T> {
    return this.queues.run(pageId, 0, async () => {
      try {
        const result = await task();
        const room = this.rooms.get(pageId);
        if (room) await this.pruneUnauthorized(pageId, room);
        return result;
      } catch (error) {
        // Even a rejected COMMIT response can hide a committed removal. Fail closed
        // before releasing page serialization; reconnect rechecks stored grants.
        if (!isRejectedUpdate(error)) this.invalidate(pageId);
        throw error;
      }
    });
  }

  join(pageId: string, socket: WebSocket, principal: Principal = { accountId: DEV_ACCOUNT_ID }): Promise<void> {
    this.principals.set(socket, principal);
    return this.queues.run(pageId, 0, async () => {
      const room = await this.loadRoomForJoin(pageId, socket, principal);
      if (!room) return;
      await this.pruneUnauthorized(pageId, room);
      if (socket.readyState !== 1) return;
      room.sockets.add(socket);
      this.sendInitialState(socket, room);
    });
  }

  private async loadRoomForJoin(pageId: string, socket: WebSocket, principal: Principal): Promise<Room | undefined> {
    // Loading independently authorizes this principal, even when a room exists.
    const loaded = await loadPage(this.pool, pageId, principal.accountId, principal.sessionId);
    const existing = this.rooms.get(pageId);
    if (existing && existing.sequence !== loaded.sequence) {
      loaded.doc.destroy();
      this.invalidate(pageId);
      throw new Error('Room sequence changed outside this server');
    }
    if (socket.readyState !== 1) {
      loaded.doc.destroy();
      return;
    }
    if (existing) {
      loaded.doc.destroy();
      return existing;
    }
    const room: Room = {
      ...loaded,
      sockets: new Set(),
      presenceIsSerialized: false,
      presence: new RoomPresence(loaded.doc, update => this.changedPresence(pageId, room, update)),
    };
    this.rooms.set(pageId, room);
    return room;
  }

  private sendInitialState(socket: WebSocket, room: Room): void {
    sendMessage(socket, {
      type: 'sync',
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      sequence: room.sequence,
      update: encodeUpdate(Y.encodeStateAsUpdate(room.doc)),
    });
    const presence = room.presence.encodeState();
    if (presence) this.sendPresence(socket, presence);
  }

  leave(pageId: string, socket: WebSocket): void {
    const room = this.rooms.get(pageId);
    room?.sockets.delete(socket);
    // A closed socket releases its identity immediately; propagation is queued.
    room?.presence.remove(socket);
    if (!room || room.sockets.size > 0) return;
    // Cleanup runs behind accepted work, so no room disappears during COMMIT.
    void this.queues.run(pageId, 0, async () => {
      this.discardEmptyRoom(pageId, room);
    }).catch(() => undefined);
  }

  /** Call only while holding this page's queue, after accepted work settles. */
  private discardEmptyRoom(pageId: string, room: Room): void {
    if (this.rooms.get(pageId) !== room || room.sockets.size > 0) return;
    this.rooms.delete(pageId);
    this.destroyRoom(room);
  }

  presence(pageId: string, socket: WebSocket, update: Uint8Array): Promise<void> {
    return this.queues.run(pageId, update.byteLength, async () => {
      const room = this.rooms.get(pageId);
      if (!room || !room.sockets.has(socket)) throw new AccessError('Handshake has not completed');
      await this.pruneOrInvalidate(pageId, room);
      if (!room.sockets.has(socket)) throw new AccessError('Session expired or revoked');
      this.withSerializedPresence(room, () => room.presence.accept(socket, this.principals.get(socket)!, update));
    });
  }

  private withSerializedPresence(room: Room, change: () => void): void {
    room.presenceIsSerialized = true;
    try {
      change();
    } finally {
      room.presenceIsSerialized = false;
    }
  }

  private changedPresence(pageId: string, room: Room, update: Uint8Array): void {
    if (this.rooms.get(pageId) !== room) return;
    if (room.presenceIsSerialized) {
      this.broadcastPresence(room, update);
      return;
    }
    // Awareness timeouts and socket closes run outside page serialization.
    // Recheck recipients before publishing these transient removals.
    void this.queues.run(pageId, update.byteLength, async () => {
      if (this.rooms.get(pageId) !== room) return;
      try {
        await this.pruneUnauthorized(pageId, room);
        this.broadcastPresence(room, update);
      } catch {
        this.invalidate(pageId);
      }
    }).catch(() => {
      // Queue overload/shutdown may drop transient removals; Awareness expires
      // them. Never destroy a room outside serialization during an active commit.
    });
  }

  private broadcastPresence(room: Room, update: Uint8Array): void {
    for (const socket of room.sockets) this.sendPresence(socket, update);
  }

  private sendPresence(socket: WebSocket, update: Uint8Array): void {
    if (update.byteLength > MAX_PRESENCE_SNAPSHOT_BYTES) {
      socket.close(1013, 'Presence limit reached; reconnect');
      return;
    }
    sendMessage(socket, { type: 'presence', update: encodeUpdate(update) });
  }

  update(pageId: string, socket: WebSocket, message: UpdateMessage, update: Uint8Array): Promise<void> {
    return this.queues.run(pageId, update.byteLength, async () => {
      const room = this.rooms.get(pageId);
      if (!room || !room.sockets.has(socket)) throw new Error('Handshake has not completed');
      await this.pruneUnauthorized(pageId, room);
      if (!room.sockets.has(socket)) throw new AccessError('Session expired or revoked');
      const result = await this.commitToStorage(pageId, socket, room, message, update);
      // Database revocation/expiry during a commit must be checked before propagation.
      await this.pruneOrInvalidate(pageId, room);
      // A duplicate receipt keeps its original sequence. Only new commits advance the room.
      if (!result.duplicate) this.applyCommittedUpdate(pageId, room, socket, result, update);
      this.acknowledgeCommittedBatch(socket, message.batchId, result);
    });
  }

  private acknowledgeCommittedBatch(socket: WebSocket, batchId: string, result: CommitResult): void {
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
    sendMessage(socket, { type: 'ack', batchId, sequence: result.sequence });
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
    await Promise.all([...pageIds].map(pageId => this.revalidatePage(pageId)));
  }

  private revalidatePage(pageId: string): Promise<void> {
    return this.queues.run(pageId, 0, async () => {
      const room = this.rooms.get(pageId);
      if (!room) return;
      try {
        await this.pruneUnauthorized(pageId, room);
        this.discardEmptyRoom(pageId, room);
      } catch {
        this.invalidate(pageId);
      }
    }).catch(() => {
      // Admission rejection can occur while another task owns COMMIT. Stop
      // exposure now, but retain its document until serialized cleanup.
      const room = this.rooms.get(pageId);
      if (room) this.closeSockets(room, 'Revalidate access on reconnect');
    });
  }

  private async pruneOrInvalidate(pageId: string, room: Room): Promise<void> {
    try {
      await this.pruneUnauthorized(pageId, room);
    } catch (error) {
      this.invalidate(pageId);
      throw error;
    }
  }

  private async pruneUnauthorized(pageId: string, room: Room): Promise<void> {
    const removed: WebSocket[] = [];
    for (const socket of room.sockets) {
      const principal = this.principals.get(socket)!;
      if (!principal.sessionId) continue;
      if (!await canAccessPage(this.pool, pageId, principal)) {
        removed.push(socket);
      }
    }
    // Delete every unauthorized recipient before the first presence removal.
    for (const socket of removed) room.sockets.delete(socket);
    this.withSerializedPresence(room, () => {
      for (const socket of removed) room.presence.remove(socket);
    });
    for (const socket of removed) reportFailure(socket, new AccessError('Session expired or revoked'));
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
    this.destroyRoom(room);
    this.closeSockets(room, 'Reload committed state');
  }

  private destroyRoom(room: Room): void {
    room.presence.destroy();
    room.doc.destroy();
  }

  private closeSockets(room: Room, reason: string): void {
    for (const socket of room.sockets) socket.close(1012, reason);
  }

  destroy(): void {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const room of rooms) this.destroyRoom(room);
  }
}

function prepareCommittedUpdate(committedDoc: Y.Doc, update: Uint8Array, onTitle: (title: string) => void): Uint8Array | void {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(committedDoc));
    Y.applyUpdate(candidate, update);
    if (candidate.store.pendingStructs || candidate.store.pendingDs) throw new DependencyMissing();
    const beforeRepair = Y.encodeStateVector(candidate);
    const needsRepair = normalizeEmptyBody(candidate);
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
