# Live synchronization demo

`live-sync.gif` and `live-sync.mp4` show the same 18-second recording: typing paragraphs, creating a heading, and changing the title from two independent Chromium browser contexts with separate browser storage.

Captured on 2026-10-01 using sample notes and the actual Fastify/PostgreSQL path in a disposable local database. The window views share a capture clock and sit side by side; playback preserves elapsed recording time. The GIF loops at 12 fps; the MP4 uses H.264 at 20 fps.

The capture checked that both documents converged and both sessions displayed **Saved to server**. PostgreSQL contained 190 document updates and 190 corresponding durable receipts. The user's development page was not used or changed.
