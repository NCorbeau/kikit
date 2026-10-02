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

type HelloMessage = Extract<ClientMessage, { type: 'hello' }>;
type PresenceMessage = Extract<ClientMessage, { type: 'presence' }>;
type UpdateMessage = Extract<ClientMessage, { type: 'update' }>;
const MAX_PRESENCE_FRAMES_PER_SECOND = 20;

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

  socket.on('message', receiveMessage);

  function receiveMessage(data: RawData, binary: boolean): void {
    let message: ClientMessage;
    try {
      message = parseClientMessage(data, binary);
    } catch (error) {
      reportFailure(socket, error);
      return;
    }
    if (message.type === 'hello') {
      handleHello(message);
      return;
    }
    if (!pageId || !helloReceived) {
      reportFailure(socket, new InvalidDocument(), message.type === 'update' ? message.batchId : undefined);
      return;
    }
    if (message.type === 'presence') {
      handlePresence(pageId, message);
      return;
    }
    handleDocumentUpdate(pageId, message);
  }

  function handleHello(message: HelloMessage): void {
    if (helloReceived) {
      reportFailure(socket, new InvalidDocument());
      return;
    }
    // Record the attempt here; page authorization and admission finish in the queue.
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
  }

  function admitPresenceFrame(): boolean {
    const now = Date.now();
    if (now - presenceWindow >= 1000 || now < presenceWindow) {
      presenceWindow = now;
      presenceFrames = 0;
    }
    return ++presenceFrames <= MAX_PRESENCE_FRAMES_PER_SECOND;
  }

  function handlePresence(targetPageId: string, message: PresenceMessage): void {
    // Drop excess motion before it can consume page-queue or database work.
    if (!admitPresenceFrame()) return;
    try {
      const update = decodeBoundedUpdate(message.update, MAX_PRESENCE_BYTES);
      void rooms.presence(targetPageId, socket, update).catch(error => {
        // Transient state can be dropped under overload; durable work keeps its retry contract.
        if (!(error instanceof OverloadError)) reportFailure(socket, error);
      });
    } catch (error) {
      reportFailure(socket, error);
    }
  }

  function handleDocumentUpdate(targetPageId: string, message: UpdateMessage): void {
    let update: Uint8Array;
    try {
      update = decodeBoundedUpdate(message.update, MAX_UPDATE_BYTES);
    } catch {
      reportFailure(socket, new InvalidDocument(), message.batchId);
      return;
    }
    void rooms.update(targetPageId, socket, message, update)
      .catch(error => reportFailure(socket, error, message.batchId));
  }
}

function decodeBoundedUpdate(encoded: string, maxBytes: number): Uint8Array {
  const update = decodeUpdate(encoded);
  if (update.byteLength > maxBytes) throw new InvalidDocument();
  return update;
}

function parseClientMessage(data: RawData, binary: boolean): ClientMessage {
  if (binary) throw new InvalidDocument();
  try {
    const parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
    if (parsed.success) return parsed.data;
  } catch {
    // Malformed JSON and unsupported messages share the same protocol failure.
  }
  throw new InvalidDocument();
}
