# Kikit

**A quiet place to write. A shared page when you need one.**

Kikit is a small, local-first notes app built around a simple block editor. Its goal is to make writing feel immediate, keep your work safe through connection changes, and let people work together on the same page.

**Early development:** the first implementation is in progress. There is no runnable release or hosted demo yet. The features below describe the intended first version.

## The experience

- **Simple writing.** Page titles, paragraphs, and headings, with natural keyboard, selection, paste, and undo behavior.
- **Personal notes.** Sign in to keep private pages and access them across devices.
- **Shared pages.** Invite others with a link or QR code. Collaborators sign in and join as editors.
- **Live collaboration.** Edit together, with participant indicators and colored cursors.
- **Local-first editing.** Keep writing through connection interruptions and recover locally saved changes after reload.
- **Clear save status.** Know whether changes are saved on your device or confirmed by the server.

The first version focuses on writing and collaboration. Rich databases, attachments, comments, and nested workspaces are beyond its initial scope.

## Built for understandable synchronization

Kikit's design combines established editing tools with an explicit synchronization layer. Tiptap and ProseMirror provide editor mechanics; Yjs merges concurrent edits. The application handles delivery, retries, access control, persistence, and recovery.

In the planned flow, edits appear immediately and are recorded in IndexedDB before transmission. The server commits each update and its receipt together in PostgreSQL, then acknowledges it. Interrupted delivery leaves changes pending for retry; stable batch identities let the server recognize updates it has already committed.

Browser storage is a recovery layer, not a permanent backup. Offline reopening requires a cached application and page.

## Stack

| Layer | Technology |
| --- | --- |
| Web | React, TypeScript, Vite |
| Editor and collaboration | Tiptap, ProseMirror, Yjs |
| Local storage | IndexedDB |
| Server | Node.js, Fastify, WebSockets, p-queue |
| Database and authentication | PostgreSQL, Better Auth |
| Planned hosting | Railway |

The system starts with one web client, one active application server, and PostgreSQL.

## Development

Setup instructions and test commands will accompany the first working implementation. See [AGENTS.md](AGENTS.md) for contributor and coding-agent guidance.

A license has not been selected yet.
