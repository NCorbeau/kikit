# Flat to-do lists

Added on 2026-10-04. This extends the [document contract](milestone-contract.md) and [shared-page contract](shared-pages-contract.md). The current source uses document schema 2, wire protocol 2 and database schema 4. The previously recorded hosted build uses document schema 1/database schema 3; implementing this slice does not deploy it.

## Document and editing

The title remains exactly one plain-text paragraph. The body accepts paragraphs, headings at levels 1–3 and `taskList` nodes. A task list contains `taskItem` nodes; each item has a boolean `checked` attribute and exactly one plain-text paragraph. Paragraphs, headings, task lists and task items carry stable IDs. Lists cannot be nested, and marks or extra attributes remain unsupported.

The browser schema also permits temporarily empty lists/items after concurrent deletions. This prevents the editor binding from deleting their Yjs identities while waiting for the server. Before committing, the server repairs otherwise-valid empty containers with stable unchecked items/paragraphs and validates the required durable shape. Repair bytes commit with the submitted update, reach the author before acknowledgement and replay unchanged on duplicate delivery; receipt hashes still cover the original submitted bytes. Cursor-only refreshes wait for that repair. Remote transactions bypass Tiptap's local select-all clearing behavior, preserving repaired wrappers and IDs. Initial task-first hydration also normalizes text-selection endpoints into editable text without changing document content, and keyboard focus restores the matching browser caret.

Both item text and checked state live in the page's existing Yjs body fragment. They use the existing atomic browser journal, custom synchronization and committed receipt flow. There is no separate task database, React copy of checked state, REST task-save route or durable presence update.

The formatting controls convert selected blocks into a to-do list. Typing `[ ] ` or `[x] ` at the beginning of a paragraph creates an unchecked or checked item. Enter splits an item and creates an unchecked new item; Enter on an empty item exits to a paragraph. Text and heading conversions lift selected items out of their list while retaining their text. Completed items stay in place with a visual strikethrough; this is styling rather than a persisted text mark.

Checkboxes have accessible labels, visible focus and keyboard activation. They are immutable when editing is disabled. Local checkbox changes participate in collaborative undo; remote changes remain outside the local user's undo history. Local splits and paste generate fresh node identities; remote transactions keep their author's IDs. Simultaneous changes to the same checked attribute converge through Yjs, with no wall-clock ordering promise.

## Upgrade and rollout

The forward migration advances existing version-1 page metadata to version 2 and records database compatibility version 4. It retains initial document bytes, update histories, receipt hashes, batch IDs, sequences, ownership, grants and invitation records. Applied migrations remain unchanged. No task-specific tables or runtime privilege changes are required.

Browser journals retain their existing account/page namespace and IndexedDB format. Version-1 metadata is upgraded atomically while keeping stored updates and pending flags intact. The new client can replay an older client's paragraph/heading edits with their original batch identities. Unknown document or local-format versions fail closed and remain exportable.

Already-compatible journals are read without requiring storage writes. Legacy upgrades re-read their journal inside the exclusive write transaction so another tab cannot append unnoticed. If the upgrade cannot commit, its readable original bytes remain available for recovery export; initialized caches without document bytes are rejected.

Do not deploy this as a rolling mixture of old and new application instances. Stop admission and drain/stop the existing server before the migration; then start matching new web/server assets. The new server rejects schema-1 handshakes before publishing document state. Existing old sockets end with the stopped server. An older browser tab cannot write into an upgraded journal because its metadata check fails. Old offline shells may still retain version-1 drafts until they reload the updated application; do not clear site data or discard those drafts.

Schema-2 content cannot be safely edited with a schema-1 client. A rollback must preserve both server and browser data rather than downgrade metadata or convert tasks into text. Binary recovery export remains available; compatible files can be imported through the [binary recovery flow](recovery-contract.md).

## Verification boundary

Task-specific validation, upgrades, editing, offline recovery, committed acknowledgements, authenticated collaboration and local backup restoration are checked under the conditions recorded in [verification](verification.md). Hosted rollout, broader browser/native IME coverage and a full screen-reader audit remain separate evidence.
