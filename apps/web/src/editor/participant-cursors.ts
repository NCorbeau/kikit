import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { yCursorPlugin, yCursorPluginKey } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';
import { XmlElement, type XmlFragment } from 'yjs';
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

function needsCommittedRepair(body: XmlFragment): boolean {
  if (body.length === 0) return true;
  return body.toArray().some(node => node instanceof XmlElement && node.nodeName === 'taskList'
    && (node.length === 0 || node.toArray().some(item => item instanceof XmlElement
      && item.nodeName === 'taskItem' && item.length === 0)));
}

function emptyContentAwarenessGuard(body: XmlFragment): Plugin {
  return new Plugin({
    filterTransaction(transaction) {
      // Concurrent deletions can temporarily leave an empty body/list/item
      // while ProseMirror displays an implicit paragraph without a block ID.
      // The binding writes that projection even on a cursor-only refresh.
      // Wait for the committed repair; real document edits remain admitted.
      const awarenessUpdated = transaction.getMeta(yCursorPluginKey)?.awarenessUpdated;
      return transaction.docChanged || !awarenessUpdated || !needsCommittedRepair(body);
    },
  });
}

export function participantCursors(awareness: Awareness, body?: XmlFragment) {
  return Extension.create({
    name: 'participantCursors',
    addProseMirrorPlugins() {
      const plugins: Plugin[] = [];
      if (body) {
        plugins.push(emptyContentAwarenessGuard(body));
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
