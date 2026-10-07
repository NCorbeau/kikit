# Local performance measurements

This is a bounded measurement of the current notes implementation, not a capacity limit or hosted latency guarantee. The runner exercises actual authenticated browsers, the production web bundle, IndexedDB, the custom WebSocket server and PostgreSQL.

## Reproduce

With the local Compose PostgreSQL running, from the repository root:

```sh
pnpm build
pnpm exec tsx scripts/measure-performance.ts
```

The runner ignores production database environment variables. It creates a uniquely named `kikit_perf_*` database on the fixed local PostgreSQL fixture, applies migrations, starts an account server on an available loopback port, then closes browsers/server/pools and drops only that database. It neither resets `kikit_e2e` nor reads development notes. Do not rebuild assets while it runs; a changed asset digest rejects the measurement. For comparable results, avoid concurrent verification or other heavy workloads on the same host.

Synthetic magic links are captured inside the test server, and two-editor scenarios use distinct Better Auth accounts, actual invitation redemption and separate browser storage. Setup seeds plain-text paragraph content before a live room opens; note creation/import is not timed. Raw samples and source/asset digests are written under ignored `.artifacts/performance/`. Cookies, account IDs, invitation tokens, note text and network payloads are excluded.

## Method

Each of six scenarios starts with a fresh note and browser contexts: 1, 32 or 128 KiB of ASCII body text, in paragraphs of 1,024 characters, with one or two editors. After three warm-up rounds, each editor inserts one ASCII character per round for 20 rounds. Two editors receive their insertions concurrently. Every round waits for all editors to report their durable save before starting the next; this is a paced typing workload, not saturation or a throughput benchmark.

All input durations use `performance.now()` in the editing browser, starting at its body `beforeinput` event:

| Measurement | Observed boundary |
| --- | --- |
| DOM mutation | First body child/text MutationObserver delivery after input; visible document mutation, not a full rendering or editor-state profiler |
| Next frame | First animation-frame callback after input; scheduling delay, not proof that pixels have been painted |
| Local commit | `complete` event of the IndexedDB transaction inserting the pending update/batch record, with the application's requested strict durability |
| Durable ACK | WebSocket `ack` reception for that same batch; the server issues it after database commit |
| Stored ACK | Completion of the IndexedDB transaction clearing that batch's pending marker |
| Editor ready | Navigation-start to observing a mounted editable body in a fresh context; includes shell/assets, account/page checks and committed-state hydration |

Server queue deltas begin and end with no queued/running work. Their mean wait/processing durations cover **all** admitted page operations during the interval, including presence and access work, rather than only content updates. Samples use the nearest-rank median/p95 and maximum; 20 or 40 samples per row cannot describe rare tail behavior. Browser timer precision and automation also limit comparison of small differences.


After paced typing, every context goes offline and inserts ten further characters. Each input waits for its IndexedDB commit before the next, producing ten pending batches per editor. The runner verifies that these IDs have no server receipts, then restores both contexts' networking concurrently. Per-batch reconnect timing begins at a browser clock marker immediately before its network restoration request; it includes automation coordination and reconnection/handshake, not just network round-trip time. The separately reported wall duration runs from issuing restoration to observing all editors' “Saved to server” statuses and includes Playwright polling overhead.

Replay passes only when original batch IDs and bytes remain unchanged, each has exactly one PostgreSQL receipt with the original payload hash, the page sequence increases by exactly the backlog count, no pending records remain, and all browser document projections equal reconstructed PostgreSQL binary state. These assertions do not export IDs, hashes or note content.

At four boundaries—after warm-up, after paced typing, with the offline backlog committed, and after replay—the runner records CDP `Performance.getMetrics` V8 heap used/allocated bytes per page and Node `process.memoryUsage()`. No collection is forced. Node includes Fastify, server rooms, automation, instrumentation and earlier scenario results retained by the runner; it is not a standalone server memory figure. Page V8 heaps exclude total browser/native/GPU/process memory. Snapshots are observations, not peaks, retained-live-heap measurements or a leak test.

## 2026-10-07: Final local baseline

The successful run ended at 21:40:49 UTC, after the project's build and automated verification completed. No other project build or heavy verification ran concurrently. Background operating-system activity was not controlled.

- Apple M5 Pro, 15 logical CPUs, 24 GiB RAM, macOS/Darwin 25.5.0, arm64.
- Node 24.21.0; Playwright 1.63.0 Chromium 153.0.8010.12, headless, 1280 × 900 viewport.
- PostgreSQL 17.9 in local Docker; Fastify in the runner's Node process. HTTP/WebSocket/database traffic used the same host's loopback interfaces, with no injected delay, loss or throttling.
- Local source used document schema 2, database schema 7 and protocol 2, including the reviewed recovery implementation. The local code commit was `52b9125c3c96c22bbd240cbebcc73a17b6097fd6`; this was not a hosted rollout or a claim that this exact source had been published. Source and production assets remained unchanged throughout this successful run.
- Source-tree SHA-256: `2b5363adc1d74be7b748e682450055b97d86481709f8581a7490d5d1b0810672`; built-assets SHA-256: `31ec6480acf0d9908213c4108b3e74bd1d691dfc369c9c33ff6d3b4188a9a51d`.

Durations below are milliseconds, rounded to one decimal. Body size excludes the title and binary metadata.

| Body KiB / paragraphs | Editors | Samples | DOM p95 | Local commit p95 | ACK median | ACK p95 | ACK max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 / 1 | 1 | 20 | 0.9 | 2.4 | 8.5 | 11.5 | 14.8 |
| 1 / 1 | 2 | 40 | 1.0 | 2.7 | 11.9 | 19.1 | 23.1 |
| 32 / 32 | 1 | 20 | 1.1 | 2.5 | 9.5 | 11.4 | 13.5 |
| 32 / 32 | 2 | 40 | 1.2 | 3.6 | 16.7 | 27.9 | 34.8 |
| 128 / 128 | 1 | 20 | 1.2 | 3.9 | 11.9 | 14.2 | 17.1 |
| 128 / 128 | 2 | 40 | 1.4 | 4.8 | 20.5 | 31.8 | 40.6 |

Initial binary state was 1,275 / 36,089 / 144,089 bytes for the respective body sizes. Editor-ready observations ranged from 78.3 to 156.1 ms across the nine contexts; these are single navigations, not a startup percentile. Next-frame p95 ranged from 14.5 to 17.4 ms. Stored-ACK p95 ranged from 12.2 to 32.4 ms.

| Body KiB | Editors | Admitted/completed queue tasks | Mean wait ms | Mean processing ms |
| --- | --- | --- | --- | --- |
| 1 | 1 | 25 | 0.69 | 5.55 |
| 1 | 2 | 52 | 4.24 | 5.81 |
| 32 | 1 | 25 | 0.21 | 6.24 |
| 32 | 2 | 58 | 5.14 | 7.30 |
| 128 | 1 | 25 | 0.01 | 7.98 |
| 128 | 2 | 70 | 5.61 | 7.86 |

All 180 measured input batches reached local commit, received durable acknowledgements and stored those acknowledgements locally. Queue intervals recorded no failures or overload rejections, and no snapshot attempts. Every measurement database was removed, including earlier exploratory runs. The final raw artifact is `.artifacts/performance/2026-10-07T21-40-49.439Z.json`.

Earlier instrumentation, asset-drift and typing-only runs are excluded from this baseline. The 21:32:11 UTC typing-only run used the same production assets but did not cover offline replay or memory. A successful 20:43:44 UTC run overlapped other authenticated verification and observed a maximum ACK of 87.5 ms; later 21:17:03 and 21:22:40 UTC runs preceded the final recovery guards and UUID-alias handling. Their raw artifacts remain local, and their values are not combined with the final sample set.

## Offline replay observations

Each backlog held 10 batches/editor, with 24 encoded bytes per character update in this particular fresh-document workload. All 90 offline batches passed the exact identity/bytes/receipts/sequence/convergence checks. Timings include reconnection; they are separate from online typing samples.

| Body KiB | Editors | Pending batches / bytes | Offline local commit p95 ms | Reconnect ACK p95 ms | Last stored ACK ms | All Saved wall ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 10 / 240 | 2.3 | 81.5 | 82.0 | 180.9 |
| 1 | 2 | 20 / 480 | 1.6 | 123.8 | 130.5 | 176.8 |
| 32 | 1 | 10 / 240 | 6.6 | 86.7 | 87.2 | 179.6 |
| 32 | 2 | 20 / 480 | 3.5 | 156.7 | 162.5 | 179.0 |
| 128 | 1 | 10 / 240 | 8.7 | 118.8 | 119.4 | 178.0 |
| 128 | 2 | 20 / 480 | 2.0 | 249.7 | 260.4 | 282.0 |

## Memory observations

Values are MiB (1,048,576 bytes). For two editors, slash-separated values are the two page heaps, not a sum. Node ranges span the four boundaries within that scenario; fresh contexts are created per row, but the same Node server/runner process continues between rows.

| Body KiB | Editors | V8 used before typing | After typing | Offline backlog | After replay | Node RSS range | Node heap-used range |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 7.36 | 7.85 | 8.39 | 10.14 | 303.59–310.73 | 91.73–131.80 |
| 1 | 2 | 7.43 / 7.43 | 8.89 / 8.89 | 9.61 / 9.60 | 11.80 / 11.63 | 319.12–319.95 | 96.97–139.47 |
| 32 | 1 | 6.87 | 9.23 | 8.47 | 11.69 | 328.59–339.23 | 107.21–139.69 |
| 32 | 2 | 7.93 / 8.18 | 9.75 / 11.53 | 9.60 / 11.38 | 10.49 / 11.75 | 237.86–308.83 | 134.26–193.97 |
| 128 | 1 | 7.66 | 10.23 | 12.82 | 15.87 | 329.58–354.09 | 200.17–259.63 |
| 128 | 2 | 9.23 / 8.95 | 12.51 / 10.58 | 20.26 / 17.42 | 10.00 / 10.05 | 407.03–455.61 | 120.40–203.80 |

Across the 36 page snapshots, V8 used heap was 6.87–20.26 MiB and allocated heap was 11.31–26.17 MiB. The 128 KiB/two-editor row fell from 20.26/17.42 MiB while offline to 10.00/10.05 MiB after replay; ordinary garbage collection can therefore dominate differences between boundaries. Raw allocated heap, Node external and array-buffer observations are retained in the ignored artifact. Browser processes and PostgreSQL are outside the Node RSS figures.

## Observed constraints

Two editors introduced mean page-queue waiting of 4.24–5.61 ms, compared with 0.01–0.69 ms for one editor. The largest two-editor note had the highest online ACK p95 (31.8 ms) and backlog ACK p95 (249.7 ms), while DOM mutation p95 remained at or below 1.4 ms. This locates the observed additional delay after local document mutation; these aggregate timers do not distinguish database, validation, room application or scheduler CPU cost.

The current [sender](../apps/web/src/session/index.ts) admits one pending batch at a time and advances after storing its receipt; [page queues](../apps/server/src/queue.ts) serialize work with concurrency one. Those concrete serialization boundaries limit backlog drain parallelism, and replay pays repeated commit/receipt costs. This run does not justify changing them: they enforce durability/ordering invariants, and a measured remote-network workload is needed before proposing an optimization.

## Limits and next measurements

The results show the separate local and server durability costs for these particular small paced workloads. They do not establish an acceptable latency target, maximum supported note size, sustainable edits per second, memory ceiling, multi-page capacity or maximum concurrent users. The 256 KiB update and 2 MiB encoded-document guards remain validation limits, not benchmarked capacity.

This run does not measure long Yjs histories, checkbox-heavy documents, large pastes, snapshot/compaction overhead, receipt growth, lossy/remote networks, database faults, slow consumers, native IME/mobile input, another browser engine, real hosted email or Railway latency. Measure those conditions separately with a stated workload before making claims about them. Correctness, recovery and hosted release gates remain in [verification](verification.md) and [the v1 checklist](v1-release.md).
