// Only launched by hard-crash.integration.test.ts; no application route or flag.
import pg from 'pg';
import { DEV_ACCOUNT_ID } from '@kikit/contracts';
import { commitUpdate } from '../persistence.js';
import { compactPage } from '../document-snapshots.js';

type Request = {
  schema: string;
  pageId: string;
  batchId: string;
  update: string;
  phase: 'before-commit' | 'after-commit' | 'before-snapshot-commit' | 'after-snapshot-commit' | 'before-prune-commit' | 'partition-commit';
};

process.once('message', async (request: Request) => {
  if (!/^crash_test_[a-f0-9]{32}$/.test(request.schema)) throw new Error('Invalid fixture schema');
  const pool = new pg.Pool({
    connectionString: process.env.KIKIT_TEST_DATABASE_URL,
    options: `-c search_path=${request.schema}`,
  });
  const checkpoint = async () => {
    process.send?.({ checkpoint: request.phase });
    // The parent sends SIGKILL. Do not throw, roll back or close this connection.
    await new Promise<void>(() => undefined);
  };
  try {
    if (request.phase === 'partition-commit') {
      await commitUpdate(pool, request.pageId, DEV_ACCOUNT_ID, request.batchId, Buffer.from(request.update, 'base64'));
      process.send?.({ acknowledged: true });
      await new Promise<void>(() => undefined);
    } else if (request.phase === 'before-commit' || request.phase === 'after-commit') {
      await commitUpdate(pool, request.pageId, DEV_ACCOUNT_ID, request.batchId, Buffer.from(request.update, 'base64'), {
        ...(request.phase === 'before-commit' ? { beforeCommit: checkpoint } : {
          afterCommit: () => { process.send?.({ checkpoint: request.phase }); },
        }),
      });
      // A post-COMMIT crash occurs before the caller can acknowledge the batch.
      await new Promise<void>(() => undefined);
    } else {
      await compactPage(pool, request.pageId, { accountId: DEV_ACCOUNT_ID }, {
        ...(request.phase === 'before-snapshot-commit' ? { beforeSnapshotCommit: checkpoint } : {}),
        ...(request.phase === 'after-snapshot-commit' ? { afterSnapshotCommit: checkpoint } : {}),
        ...(request.phase === 'before-prune-commit' ? { beforePruneCommit: checkpoint } : {}),
      });
      throw new Error('Fixture checkpoint was not reached');
    }
  } catch {
    process.send?.({ failed: true });
    await pool.end();
    process.exitCode = 1;
  }
});
