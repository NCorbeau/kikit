import type { RawData, WebSocket } from 'ws';
import {
  clientMessageSchema,
  decodeUpdate,
  DOCUMENT_SCHEMA_VERSION,
  MAX_UPDATE_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '@kikit/contracts';
import { CompatibilityError } from './persistence.js';
import { InvalidDocument, reportFailure } from './sync-protocol.js';
import type { SyncRooms } from './sync-room.js';
import type { Principal } from './pages.js';

/** One connection owns its handshake deadline and page association. */
export function attachSyncConnection(
  socket: WebSocket,
  rooms: SyncRooms,
  onClose: () => void,
  principal?: Principal,
): void {
  let pageId: string | undefined;
  let helloReceived = false;
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
      void rooms.join(pageId, socket, principal).catch(error => reportFailure(socket, error));
      return;
    }
    if (!pageId || !helloReceived) {
      reportFailure(socket, new InvalidDocument(), message.batchId);
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
