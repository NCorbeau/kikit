import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { WebSocket } from 'ws';
import type { SyncRooms } from './sync-room.js';

/** One account server owns the database's live rooms at a time. */
export async function acquireServerOwnership(pool: Pool, fixture: boolean): Promise<PoolClient | undefined> {
  if (fixture) return undefined;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock(719422) AS acquired');
    if (!row.acquired) throw new Error('Another Kikit account server is active. Stop and drain it before deployment.');
    return client;
  } catch (error) {
    client?.release();
    await pool.end();
    throw error;
  }
}

/** Own shutdown admission, socket cleanup, and the database ownership lock. */
export function registerServerLifecycle(
  app: FastifyInstance,
  pool: Pool,
  rooms: SyncRooms,
  connections: Set<WebSocket>,
  ownershipConnection: PoolClient | undefined,
) {
  let shuttingDown = false;
  let ownershipLost = false;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;

  app.addHook('preClose', async () => {
    shuttingDown = true;
    clearInterval(expiryTimer);
    for (const socket of connections) socket.close(1001, 'Server shutdown');
    const closeTimer = setTimeout(() => {
      for (const socket of connections) socket.terminate();
    }, 1000);
    closeTimer.unref();
    await rooms.queues.drain();
    clearTimeout(closeTimer);
    for (const socket of connections) socket.terminate();
  });
  app.addHook('onClose', async () => {
    rooms.destroy();
    if (ownershipConnection) {
      if (!ownershipLost) await ownershipConnection.query('SELECT pg_advisory_unlock(719422)').catch(() => undefined);
      ownershipConnection.release(ownershipLost);
    }
    await pool.end();
  });
  ownershipConnection?.on('error', () => {
    ownershipLost = true;
    shuttingDown = true;
    // Stop queue admission synchronously; never keep rooms alive after losing ownership.
    void rooms.queues.drain().catch(() => undefined);
    for (const socket of connections) socket.terminate();
    console.error('Database ownership connection lost; stopping Kikit.');
    void app.close().catch(() => {
      console.error('Kikit shutdown failed.');
    });
  });

  return {
    get shuttingDown() { return shuttingDown; },
    startExpiryChecks() {
      let revalidating = false;
      expiryTimer = setInterval(() => {
        if (revalidating || shuttingDown) return;
        revalidating = true;
        void rooms.revalidate().finally(() => {
          revalidating = false;
        });
      }, 10_000);
      expiryTimer.unref();
    },
  };
}
