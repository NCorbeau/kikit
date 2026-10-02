import { createServer } from './app.js';
import { fixtureEnabled } from './config.js';

const fixture = fixtureEnabled();
const app = await createServer({ serveWeb: !fixture });
let closing = false;
app.addHook('onClose', async () => {
  if (!closing) process.exitCode = 1;
});

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch {
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
await app.listen({ host: fixture ? '127.0.0.1' : '0.0.0.0', port: Number(process.env.PORT ?? 3001) });
console.info(`Kikit ${fixture ? 'development fixture' : 'application'} listening on port ${process.env.PORT ?? 3001}`);
