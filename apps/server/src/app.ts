import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  clientMessageSchema, decodeUpdate, encodeUpdate, PROTOCOL_VERSION, DOCUMENT_SCHEMA_VERSION,
  DEV_ACCOUNT_ID, DEV_PAGE_ID, BODY_FRAGMENT, MAX_UPDATE_BYTES, MAX_WIRE_BYTES, type ServerMessage,
} from '@kikit/contracts';
import { DEFAULT_DATABASE_URL, isLoopback, requireDevelopmentFixture } from './config.js';
import { AccessError, CompatibilityError, ReceiptConflict, createPool, loadPage, commitUpdate } from './persistence.js';
import { normalizeEmptyBody } from './document.js';
import { OverloadError, PageQueues, ShutdownError } from './queue.js';

class InvalidDocument extends Error {}
class DependencyMissing extends Error {}
interface Room { doc: Y.Doc; sequence: number; sockets: Set<WebSocket> }
const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;

export async function createServer(options: { databaseUrl?: string; origin?: string } = {}): Promise<FastifyInstance> {
  requireDevelopmentFixture();
  const origin = options.origin ?? process.env.KIKIT_ORIGIN ?? 'http://127.0.0.1:5173';
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname) || parsedOrigin.origin !== origin) throw new Error('The development fixture requires an exact loopback browser origin');
  const pool = createPool(options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const queues = new PageQueues();
  const rooms = new Map<string, Room>();
  const connections = new Set<WebSocket>();
  let shuttingDown = false;
  let dropNextAck = false;
  let failNextCommit = false;
  let postCommitError = false;
  const testFaults = process.env.NODE_ENV === 'test' && process.env.KIKIT_TEST_FAULTS === '1';
  await app.register(websocket, { options: { maxPayload: MAX_WIRE_BYTES } });
  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== 1) return;
    const payload = JSON.stringify(message);
    if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_OUTBOUND_BYTES) { socket.close(1013, 'Slow connection; reconnect to recover'); return; }
    socket.send(payload, error => { if (error) socket.terminate(); });
  }
  function fail(socket: WebSocket, error: unknown, batchId?: string): void {
    let code = 'STORAGE_UNAVAILABLE', message = 'Server storage is unavailable. Your pending edits are retained.', retryable = true;
    if (error instanceof AccessError) { code = 'ACCESS_DENIED'; message = 'Page access denied'; retryable = false; }
    else if (error instanceof CompatibilityError) { code = 'INCOMPATIBLE'; message = 'Client or document version is unsupported'; retryable = false; }
    else if (error instanceof ReceiptConflict) { code = 'BATCH_CONFLICT'; message = 'Batch identity was reused with different bytes'; retryable = false; }
    else if (error instanceof InvalidDocument) { code = 'INVALID_DOCUMENT'; message = 'This edit does not match the supported document schema'; retryable = false; }
    else if (error instanceof DependencyMissing) { code = 'DEPENDENCY_MISSING'; message = 'Replay earlier pending edits before this update'; }
    else if (error instanceof OverloadError) { code = 'OVERLOADED'; message = 'Server synchronization queue is full; retry later'; }
    else if (error instanceof ShutdownError) { code = 'SHUTTING_DOWN'; message = 'Server is restarting; reconnect shortly'; }
    send(socket, { type: 'error', code, message, retryable, ...(batchId ? { batchId } : {}) });
    if (!retryable) socket.close(1008, code);
  }
  function invalidate(pageId: string): void {
    const room = rooms.get(pageId);
    if (!room) return;
    rooms.delete(pageId); room.doc.destroy();
    for (const socket of room.sockets) socket.close(1012, 'Reload committed state');
  }
  app.get('/api/dev/session', async (request, reply) => {
    if (!isLoopback(request.ip) || (request.headers.origin && request.headers.origin !== origin)) return reply.code(403).send({ error: 'Development fixture is restricted to the local browser' });
    // This is an identity fixture, not real authentication. Authorization still runs
    // independently for every handshake and every committed batch.
    return { accountId: DEV_ACCOUNT_ID, pageId: DEV_PAGE_ID, protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION };
  });
  if (testFaults) {
    app.post('/api/test/faults', async (request, reply) => {
      if (!isLoopback(request.ip)) return reply.code(403).send({ error: 'Loopback only' });
      const body = request.body as { dropNextAck?: boolean; failNextCommit?: boolean; postCommitError?: boolean } | undefined;
      if (!body || Object.keys(body).some(key => !['dropNextAck', 'failNextCommit', 'postCommitError'].includes(key)) || Object.values(body).some(value => typeof value !== 'boolean')) return reply.code(400).send({ error: 'Invalid fault request' });
      dropNextAck = body.dropNextAck ?? dropNextAck; failNextCommit = body.failNextCommit ?? failNextCommit; postCommitError = body.postCommitError ?? postCommitError;
      return { ok: true };
    });
    app.get('/api/test/metrics', async (request, reply) => {
      if (!isLoopback(request.ip)) return reply.code(403).send({ error: 'Loopback only' });
      return { ...queues.metrics, rooms: rooms.size, connections: connections.size };
    });
  }
  app.get('/api/sync', { websocket: true, preValidation: async (request, reply) => {
    if (!isLoopback(request.ip) || request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin denied' });
    if (shuttingDown || connections.size >= 128) return reply.code(503).send({ error: 'Server unavailable' });
  } }, (socket) => {
    connections.add(socket);
    let pageId: string | undefined;
    let helloReceived = false;
    const timer = setTimeout(() => socket.close(1008, 'Handshake required'), 10000);
    timer.unref();
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer); connections.delete(socket);
      if (pageId) {
        const room = rooms.get(pageId); room?.sockets.delete(socket);
        // Run cleanup behind accepted work; no room can disappear during COMMIT.
        if (room?.sockets.size === 0) void queues.run(pageId, 0, async () => {
          if (rooms.get(pageId!) === room && room.sockets.size === 0) { rooms.delete(pageId!); room.doc.destroy(); }
        }).catch(() => undefined);
      }
    });
    socket.on('message', (data, binary) => {
      if (binary) { fail(socket, new InvalidDocument()); return; }
      let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
      try { parsed = clientMessageSchema.safeParse(JSON.parse(data.toString())); }
      catch { fail(socket, new InvalidDocument()); return; }
      if (!parsed.success) { fail(socket, new InvalidDocument()); return; }
      const message = parsed.data;
      if (message.type === 'hello') {
        if (helloReceived) { fail(socket, new InvalidDocument()); return; }
        helloReceived = true; clearTimeout(timer); pageId = message.pageId;
        if (message.protocolVersion !== PROTOCOL_VERSION || message.schemaVersion !== DOCUMENT_SCHEMA_VERSION) { fail(socket, new CompatibilityError()); return; }
        void queues.run(pageId, 0, async () => {
          const loaded = await loadPage(pool, message.pageId, DEV_ACCOUNT_ID);
          let room = rooms.get(message.pageId);
          if (room && room.sequence !== loaded.sequence) { loaded.doc.destroy(); invalidate(message.pageId); throw new Error('Room sequence changed outside this server'); }
          if (socket.readyState !== 1) { loaded.doc.destroy(); return; }
          if (room) loaded.doc.destroy();
          else { room = { ...loaded, sockets: new Set() }; rooms.set(message.pageId, room); }
          if (socket.readyState !== 1) return;
          room.sockets.add(socket);
          send(socket, { type: 'sync', protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION, sequence: room.sequence, update: encodeUpdate(Y.encodeStateAsUpdate(room.doc)) });
        }).catch(error => fail(socket, error));
        return;
      }
      if (!pageId || !helloReceived) { fail(socket, new InvalidDocument(), message.batchId); return; }
      let update: Uint8Array;
      try { update = decodeUpdate(message.update); if (update.byteLength > MAX_UPDATE_BYTES) throw new Error(); }
      catch { fail(socket, new InvalidDocument(), message.batchId); return; }
      const activePageId = pageId;
      void queues.run(activePageId, update.byteLength, async () => {
        const room = rooms.get(activePageId);
        if (!room || !room.sockets.has(socket)) throw new Error('Handshake has not completed');
        let result: Awaited<ReturnType<typeof commitUpdate>>;
        try { result = await commitUpdate(pool, activePageId, DEV_ACCOUNT_ID, message.batchId, update, async () => {
          if (failNextCommit) { failNextCommit = false; throw new Error('Injected pre-commit database failure'); }
        }, () => {
          const candidate = new Y.Doc();
          try {
            Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc)); Y.applyUpdate(candidate, update);
            if (candidate.store.pendingStructs || candidate.store.pendingDs) throw new DependencyMissing();
            const needsRepair = candidate.getXmlFragment(BODY_FRAGMENT).length === 0;
            const beforeRepair = Y.encodeStateVector(candidate);
            normalizeEmptyBody(candidate);
            // Preserve the submitted update and merge in server-authored repair
            // structs. The client batch hash still covers only its original bytes.
            if (needsRepair) {
              return Y.mergeUpdates([update, Y.encodeStateAsUpdate(candidate, beforeRepair)]);
            }
          } catch (error) { if (error instanceof DependencyMissing) throw error; throw new InvalidDocument(); }
          finally { candidate.destroy(); }
        }, () => {
          if (postCommitError) { postCommitError = false; throw new Error('Injected unknown commit outcome'); }
        }); } catch (error) {
          // A connection error may have hidden a successful COMMIT. The in-memory
          // room is uncertain until reconstructed from durable updates and receipts.
          if (!(error instanceof AccessError || error instanceof CompatibilityError || error instanceof ReceiptConflict || error instanceof InvalidDocument || error instanceof DependencyMissing)) {
            fail(socket, error, message.batchId); invalidate(activePageId);
          }
          throw error;
        }
        // A duplicate receipt is durable already. Its original sequence is preserved.
        // For a new update, apply and schedule peer output only after COMMIT succeeds.
        if (!result.duplicate) {
          try {
            const committedUpdate = result.committedUpdate ?? update;
            Y.applyUpdate(room.doc, committedUpdate); room.sequence = result.sequence;
            for (const peer of room.sockets) if (peer !== socket) send(peer, { type: 'committed', update: encodeUpdate(committedUpdate), sequence: result.sequence });
          } catch { invalidate(activePageId); throw new Error('Committed room application failed'); }
        }
        // The author also needs a server repair before its receipt is acknowledged.
        // A duplicate retry gets the originally committed repair, never a new one.
        if (result.committedUpdate) send(socket, { type: 'committed', update: encodeUpdate(result.committedUpdate), sequence: result.sequence });
        if (dropNextAck) { dropNextAck = false; socket.close(1012, 'Injected lost acknowledgement'); return; }
        send(socket, { type: 'ack', batchId: message.batchId, sequence: result.sequence });
      }).catch(error => fail(socket, error, message.batchId));
    });
  });
  app.addHook('preClose', async () => {
    shuttingDown = true;
    for (const socket of connections) socket.close(1001, 'Server shutdown');
    // Socket close handshakes are bounded independently of page serialization.
    const timer = setTimeout(() => { for (const socket of connections) socket.terminate(); }, 1000); timer.unref();
    await queues.drain(); clearTimeout(timer);
    for (const socket of connections) socket.terminate();
  });
  app.addHook('onClose', async () => { for (const room of rooms.values()) room.doc.destroy(); rooms.clear(); await pool.end(); });
  return app;
}
