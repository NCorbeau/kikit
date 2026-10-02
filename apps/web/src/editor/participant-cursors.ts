import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { yCursorPlugin, yCursorPluginKey } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';
import type { XmlFragment } from 'yjs';
import { caretLabels } from './caret-labels';

type PresenceUser = {
  accountId?: string;
  name?: string;
  color?: string;
};

function presenceColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#5083b7';
}

function buildParticipantCaret(user: PresenceUser, clientId: number): HTMLElement {
  const cursor = document.createElement('span');
  cursor.className = 'collaboration-caret';
  cursor.dataset.clientId = String(clientId);
  cursor.dataset.accountId = user.accountId ?? '';
  cursor.style.borderColor = presenceColor(user.color);
  cursor.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'collaboration-caret-label';
  label.textContent = user.name?.slice(0, 80) || 'Participant';
  cursor.append(label);
  return cursor;
}

function buildParticipantSelection(user: PresenceUser) {
  return {
    class: 'collaboration-selection',
    style: `background-color: ${presenceColor(user.color)}26`,
    'data-account-id': user.accountId ?? '',
  };
}

function emptyBodyAwarenessGuard(body: XmlFragment): Plugin {
  return new Plugin({
    filterTransaction(transaction) {
      // Concurrent deletions can temporarily leave an empty Yjs body while
      // ProseMirror displays an implicit paragraph without a block ID.
      // The binding writes that projection even on a cursor-only refresh.
      // Wait for the committed repair; real document edits remain admitted.
      const awarenessUpdated = transaction.getMeta(yCursorPluginKey)?.awarenessUpdated;
      return transaction.docChanged || !awarenessUpdated || body.length > 0;
    },
  });
}

export function participantCursors(awareness: Awareness, body?: XmlFragment) {
  return Extension.create({
    name: 'participantCursors',
    addProseMirrorPlugins() {
      const plugins: Plugin[] = [];
      if (body) {
        plugins.push(emptyBodyAwarenessGuard(body));
      }
      plugins.push(
        yCursorPlugin(awareness, {
          cursorBuilder: buildParticipantCaret,
          selectionBuilder: buildParticipantSelection,
        }),
        caretLabels(awareness),
      );
      return plugins;
    },
  });
}
