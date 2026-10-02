import type { RawData, WebSocket } from 'ws';
import {
  clientMessageSchema,
  decodeUpdate,
  DOCUMENT_SCHEMA_VERSION,
  DEV_ACCOUNT_ID,
  MAX_UPDATE_BYTES,
  MAX_PRESENCE_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '@kikit/contracts';
import { AccessError, CompatibilityError } from './persistence.js';
import { InvalidDocument, reportFailure } from './sync-protocol.js';
import type { SyncRooms } from './sync-room.js';
import type { Principal } from './pages.js';
import { OverloadError } from './queue.js';

/** One connection owns its handshake deadline and page association. */
export function attachSyncConnection(
  socket: WebSocket,
  rooms: SyncRooms,
  onClose: () => void,
  principal?: Principal,
): void {
  let pageId: string | undefined;
  let helloReceived = false;
  let presenceWindow = Date.now();
  let presenceFrames = 0;
  const handshakeTimer = setTimeout(() => socket.close(1008, 'Handshake required'), 10_000);
  handshakeTimer.unref();
  socket.on('error', () => undefined);
  socket.on('close', () => {
    clearTimeout(handshakeTimer);
    onClose();
    if (pageId) rooms.leave(pageId, socket);
  });

  socket.on('message', (data, binary) => {
    let message: ClientMessage;
    try {
      message = parseClientMessage(data, binary);
    } catch (error) {
      reportFailure(socket, error);
      return;
    }
    if (message.type === 'hello') {
      if (helloReceived) {
        reportFailure(socket, new InvalidDocument());
        return;
      }
      helloReceived = true;
      clearTimeout(handshakeTimer);
      pageId = message.pageId;
      if (message.protocolVersion !== PROTOCOL_VERSION || message.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
        reportFailure(socket, new CompatibilityError());
        return;
      }
      if (message.accountId !== (principal?.accountId ?? DEV_ACCOUNT_ID)) {
        reportFailure(socket, new AccessError('Account changed before synchronization'));
        return;
      }
      void rooms.join(pageId, socket, principal).catch(error => reportFailure(socket, error));
      return;
    }
    if (!pageId || !helloReceived) {
      reportFailure(socket, new InvalidDocument(), message.type === 'update' ? message.batchId : undefined);
      return;
    }
    if (message.type === 'presence') {
      // Drop excess motion before it can consume page-queue or database work.
      const now = Date.now();
      if (now - presenceWindow >= 1000 || now < presenceWindow) { presenceWindow = now; presenceFrames = 0; }
      if (++presenceFrames > 20) return;
      try {
        const update = decodeUpdate(message.update);
        if (update.byteLength > MAX_PRESENCE_BYTES) throw new InvalidDocument();
        void rooms.presence(pageId, socket, update).catch(error => {
          // Transient state can be dropped under overload; durable work keeps its retry contract.
          if (!(error instanceof OverloadError)) reportFailure(socket, error);
        });
      } catch (error) { reportFailure(socket, error); }
      return;
    }
    let update: Uint8Array;
    try {
      update = decodeUpdate(message.update);
      if (update.byteLength > MAX_UPDATE_BYTES) throw new InvalidDocument();
    } catch {
      reportFailure(socket, new InvalidDocument(), message.batchId);
      return;
    }
    void rooms.update(pageId, socket, message, update)
      .catch(error => reportFailure(socket, error, message.batchId));
  });
}

function parseClientMessage(data: RawData, binary: boolean): ClientMessage {
  if (binary) throw new InvalidDocument();
  try {
    const parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
    if (parsed.success) return parsed.data;
  } catch { /* Malformed JSON and unsupported messages share the same protocol failure. */ }
  throw new InvalidDocument();
}
