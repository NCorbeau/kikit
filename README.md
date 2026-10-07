# Kikit

A small notes app for writing on your own and working together. Private notes, a simple block editor, and live collaboration, with edits saved locally before they sync.

[Try Kikit](https://kikit.ncstudio.click) · [Run locally](#run-locally) · [Explore the docs](#how-it-works)

![Two collaborators editing a Kikit note, with live cursors and a shared to-do list](docs/demos/live-sync.gif)

Two signed-in collaborators, separate browser storage, and the real local backend. [Watch the MP4](docs/demos/live-sync.mp4) · [Recording details](docs/demos/README.md)

## What you can do

- Write with page titles, paragraphs, headings, and to-do lists.
- Keep notes private, or invite others by link or QR code.
- Edit together with participant indicators and colored cursors.
- Keep writing offline in previously opened notes; sync when you reconnect.
- Use light or dark mode, keyboard shortcuts, and collaborative undo.
- Check device and server save status, retry failed saves, or export a recovery file.

Kikit is under active development. The hosted app runs the task-list build `d9de585` with database schema 4. The recording shows newer local source; deletion, binary recovery import and snapshot compaction require database schema 7 and a matching rollout. Hosted backups/restore, session renewal/expiry and supported-platform checks remain before v1. See the [release checklist](docs/v1-release.md) and [verification record](docs/verification.md) for evidence and remaining limits.

## Run locally

You’ll need **Node.js 24+**, **pnpm 12.5.1**, and **Docker with Compose**.

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm dev
```

Open [127.0.0.1:5173](http://127.0.0.1:5173). A second browser profile or incognito window lets you try synchronization. Local development uses one seeded identity and note; it does not require email setup.

For account configuration, database changes, and test commands, see the [development guide](docs/development.md). For hosting, see the [deployment guide](docs/deployment.md).

## How it works

The editor uses **React, TypeScript, and Tiptap**, with **Yjs** for collaborative content. Edits are stored in **IndexedDB** before a custom **Fastify/WebSocket** service commits them to **PostgreSQL**. **Better Auth** handles accounts; **Drizzle** handles database queries and migrations.

“Saved on this device” means local storage has committed the edit. “Saved to server” means the server has committed it and returned a durable receipt. Retries keep the same batch identity so a lost acknowledgement does not save the edit twice.

- [Architecture and edit flow](docs/architecture.md) · [Editor, synchronization, and persistence](docs/milestone-contract.md)
- [Accounts and offline recovery](docs/accounts-contract.md)
- [Sharing and access controls](docs/shared-pages-contract.md)
- [To-do lists](docs/task-lists-contract.md) · [Recovery files](docs/recovery-contract.md)
- [Input and accessibility checks](docs/accessibility.md) · [Local performance measurements](docs/performance.md)
- [Tests and verification evidence](docs/verification.md) · [CI](docs/ci.md)

## License

[MIT](LICENSE) © 2026 Maciej Głownia.
