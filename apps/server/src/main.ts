import { createServer } from './app.js';

const app = await createServer();
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try { await app.close(); }
  catch { process.exitCode = 1; }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
console.info(`Kikit development fixture listening on loopback:${process.env.PORT ?? 3001}`);
