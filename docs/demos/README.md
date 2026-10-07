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
