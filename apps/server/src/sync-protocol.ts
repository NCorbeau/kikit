import type { WebSocket } from 'ws';
import { type ServerMessage } from '@kikit/contracts';
import { AccessError, CompatibilityError, ReceiptConflict } from './persistence.js';
import { OverloadError, ShutdownError } from './queue.js';

export class InvalidDocument extends Error {}
export class DependencyMissing extends Error {}
const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;

export function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== 1) return;
  const payload = JSON.stringify(message);
  if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_OUTBOUND_BYTES) {
    socket.close(1013, 'Slow connection; reconnect to recover');
    return;
  }
  socket.send(payload, error => {
    if (error) socket.terminate();
  });
}

function describeFailure(error: unknown): Omit<Extract<ServerMessage, { type: 'error' }>, 'type' | 'batchId'> {
  if (error instanceof AccessError) {
    return { code: 'ACCESS_DENIED', message: 'Page access denied', retryable: false };
  }
  if (error instanceof CompatibilityError) {
    return { code: 'INCOMPATIBLE', message: 'Client or document version is unsupported', retryable: false };
  }
  if (error instanceof ReceiptConflict) {
    return { code: 'BATCH_CONFLICT', message: 'Batch identity was reused with different bytes', retryable: false };
  }
  if (error instanceof InvalidDocument) {
    return { code: 'INVALID_DOCUMENT', message: 'This edit does not match the supported document schema', retryable: false };
  }
  if (error instanceof DependencyMissing) {
    return { code: 'DEPENDENCY_MISSING', message: 'Replay earlier pending edits before this update', retryable: true };
  }
  if (error instanceof OverloadError) {
    return { code: 'OVERLOADED', message: 'Server synchronization queue is full; retry later', retryable: true };
  }
  if (error instanceof ShutdownError) {
    return { code: 'SHUTTING_DOWN', message: 'Server is restarting; reconnect shortly', retryable: true };
  }
  return {
    code: 'STORAGE_UNAVAILABLE',
    message: 'Server storage is unavailable. Your pending edits are retained.',
    retryable: true,
  };
}

export function reportFailure(socket: WebSocket, error: unknown, batchId?: string): void {
  const failure = describeFailure(error);
  sendMessage(socket, { type: 'error', ...failure, ...(batchId ? { batchId } : {}) });
  if (!failure.retryable) socket.close(1008, failure.code);
}

/** These failures occur before a new commit and leave the existing room trustworthy. */
export function isRejectedUpdate(error: unknown): boolean {
  return error instanceof AccessError
    || error instanceof CompatibilityError
    || error instanceof ReceiptConflict
    || error instanceof InvalidDocument
    || error instanceof DependencyMissing;
}
