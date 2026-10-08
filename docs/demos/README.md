# Live collaboration demo

`live-sync.gif` and `live-sync.mp4` show the same 21.7-second recording of two signed-in collaborators. Alex uses the light theme; Sam uses the dark theme. The recording shows the updated note header, live cursors, headings, checkbox lists, and an offline edit reaching the other browser after reconnect.

## Capture conditions · 2026-10-07

- Local feature source: `15d4f3a43ba34d1e92fee1efe1f1ab657db97eac` (`dev/v1-release-closure`), using its production web bundle. The recorded feature source is ahead of the hosted build. This README refresh changes documentation and media only.
- Two independent Playwright 1.63.0 Chromium contexts on macOS/Apple Silicon, with separate cookies and IndexedDB storage. Each viewport is 720 × 610 pixels.
- Two distinct Better Auth accounts with synthetic `example.test` identities. Magic-link delivery is captured inside the test harness; no external email is sent. The owner creates an invitation through Share; the editor explicitly chooses Join note before recording starts.
- Actual Fastify/WebSocket synchronization and PostgreSQL 17.9, in a uniquely named disposable local database. Existing development notes are not used. The temporary database is removed after capture.
- Browser screenshots share one capture clock. Side-by-side composition adds account labels and short captions outside the app. The GIF plays at 10 fps and loops; the H.264 MP4 plays at 20 fps. Both preserve elapsed capture time.

## Checks during this capture

Typing and checked state propagated between the browsers. Sam’s offline edit stayed absent from Alex’s document until reconnect. After reconnect, both body texts matched, the first task remained checked, and both sessions displayed **Saved to server** when optional sync details were opened after recording.

PostgreSQL contained **85 document updates and 85 durable receipts**, at committed sequence 85. Reconstructing the Yjs document from committed binary storage retained the offline task, “Meet at 10 am”. This recording is a local demonstration, not hosted email delivery, a full account/sharing release audit, or a performance benchmark. See the [verification record](../verification.md) for the separate test and rollout evidence.

The previous 2026-10-01 recording used the development identity fixture and the older UI. It has been replaced by this authenticated capture.

## Supplemental explicit-join recording · 2026-10-07

[authenticated-sync.mp4](authenticated-sync.mp4) is a separate 15.55-second H.264 recording that begins on the authenticated **Join shared note** view and shows Sam choosing **Join note**. Alex and Sam then edit concurrently, use the shared checklist and participant cursors, make an offline edit and converge after reconnect. Both final views display **Saved to server**. The existing `live-sync` clips above remain unchanged.

This capture uses two distinct synthetic Better Auth accounts, independent cookies/IndexedDB, the production web bundle, actual Fastify/WebSocket synchronization and PostgreSQL 17.9 in a separate disposable local database. Email delivery is captured before recording, with no external email. The join view's sample email is masked in viewport screenshots; no email, invitation token, address bar, cookie or private material appears in the released media. Caret setup uses the editor's focus command; text entry uses actual browser keyboard events. This is a demonstration, not a native keyboard/IME audit.

The 720 × 610 browser screenshots are initiated in pairs on a shared elapsed clock. Measured frame durations are retained during side-by-side composition; the 1,480 × 680 MP4 plays at 20 fps, without speeding up typing or reconnect. Its 15.55-second encoded duration differs from the 15.576-second capture by less than one output frame. It contains no audio. The MP4 was decoded successfully and representative join, cursor/checklist, offline and final-save frames were visually inspected.

Pre-join access was denied, explicit join produced exactly owner/editor membership, and both final editor projections matched the complete reconstructed PostgreSQL binary document. The final page was at sequence **104**, with snapshot boundary **100**, **4** retained tail updates and **104** independent receipts. Four task items survived, including the checked first item and the offline task. The temporary database was removed after capture.

Recorded at 21:28:36 UTC with Playwright 1.63.0 Chromium 153.0.8010.12, Node 24.21.0 on macOS/Apple Silicon; document schema 2, database schema 7 and protocol 2. Built assets precede the final import-only UUID-alias correction; this recording exercises ordinary shared editing and does not verify that recovery-import change. Source-tree SHA-256: `e5d13a892856f6a51119e84cd9b7c51d6702c1ffe9863b7f32615eb6547cf91d`; built-assets SHA-256: `edffdac2eebf1c4b1950ebd9f50fc650b11d64193da5cc75c7b10587bf45b36a`. No hosted rollout, real email delivery, performance target or complete v1 release is established by this clip.

To reproduce after building the web app and starting local PostgreSQL, run `pnpm exec tsx scripts/record-authenticated-demo.ts` with an installed FFmpeg encoder on PATH, or set `FFMPEG_BIN` to its executable path. The default title font is macOS SFNS; `KIKIT_DEMO_FONT` can select another installed font. Capture metadata and temporary frames remain under ignored `.artifacts/authenticated-demo/`; the script stages and decodes the MP4 before replacing only `authenticated-sync.mp4`.
