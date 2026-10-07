// Full application subprocess used only by the local SIGKILL integration test.
import { createServer } from '../app.js';

process.once('message', async (request: { schema: string }) => {
  if (!/^crash_test_[a-f0-9]{32}$/.test(request.schema)) throw new Error('Invalid fixture schema');
  const url = new URL(process.env.KIKIT_TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${request.schema}`);
  try {
    const app = await createServer({ databaseUrl: url.toString(), origin: 'http://127.0.0.1:5173' });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    process.send?.({ address });
    // The parent kills this process. No graceful shutdown or app.close occurs.
  } catch {
    process.send?.({ failed: true });
    process.exitCode = 1;
  }
});
