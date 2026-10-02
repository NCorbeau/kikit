import { useLayoutEffect } from 'react';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import Text from '@tiptap/extension-text';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import UniqueID from '@tiptap/extension-unique-id';
import Placeholder from '@tiptap/extension-placeholder';
import { BODY_FRAGMENT, TITLE_FRAGMENT } from '@kikit/contracts';
import type { Doc, XmlFragment } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { yCursorPlugin, yCursorPluginKey } from '@tiptap/y-tiptap';
import { Plugin } from '@tiptap/pm/state';
import { FormattingToolbar } from './FormattingToolbar';
import { caretLabels } from './caret-labels';

const TitleDocument = Document.extend({ content: 'paragraph' });

function participantCursors(awareness: Awareness, body?: XmlFragment) {
  return Extension.create({
    name: 'participantCursors',
    addProseMirrorPlugins() {
      return [...(body ? [new Plugin({
        filterTransaction(transaction) {
          // Concurrent deletions can temporarily leave an empty Yjs body while
          // ProseMirror displays an implicit paragraph without a block ID.
          // The binding writes that projection even on a cursor-only refresh.
          // Wait for the committed repair; real document edits remain admitted.
          return transaction.docChanged || !transaction.getMeta(yCursorPluginKey)?.awarenessUpdated || body.length > 0;
        },
      })] : []), yCursorPlugin(awareness, {
        cursorBuilder(user: { accountId?: string; name?: string; color?: string }, clientId: number) {
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
        },
        selectionBuilder(user: { accountId?: string; color?: string }) {
          return { class: 'collaboration-selection', style: `background-color: ${presenceColor(user.color)}26`, 'data-account-id': user.accountId ?? '' };
        },
      }), caretLabels(awareness)];
    },
  });
}

function presenceColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#5083b7';
}

export function PageEditor({ doc, awareness, editable }: { doc: Doc; awareness: Awareness; editable: boolean }) {
  const body = useEditor({
    editable,
    extensions: [
      Document,
      Paragraph,
      Heading.configure({ levels: [1, 2, 3] }),
      Text,
      Collaboration.configure({ document: doc, field: BODY_FRAGMENT }),
      participantCursors(awareness, doc.getXmlFragment(BODY_FRAGMENT)),
      UniqueID.configure({
        types: ['paragraph', 'heading'],
        generateID: () => crypto.randomUUID(),
        // Remote edits already carry their author's IDs. Only local splits and
        // pasted blocks should mint new identities.
        filterTransaction: transaction => !isChangeOrigin(transaction),
      }),
      Placeholder.configure({ placeholder: 'Write something…' }),
    ],
    editorProps: {
      attributes: {
        class: 'body-editor',
        role: 'textbox',
        'aria-label': 'Page body',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
    },
  }, [doc]);

  const title = useEditor({
    editable,
    extensions: [
      TitleDocument,
      Paragraph,
      Text,
      Collaboration.configure({ document: doc, field: TITLE_FRAGMENT }),
      participantCursors(awareness),
      Placeholder.configure({ placeholder: 'Untitled' }),
      Extension.create({
        name: 'titleNavigation',
        addKeyboardShortcuts() {
          const focusBody = () => {
            body?.commands.focus('start');
            return true;
          };
          return { Enter: focusBody, 'Shift-Enter': focusBody };
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: 'title-editor',
        role: 'textbox',
        'aria-label': 'Page title',
        'aria-multiline': 'false',
        spellcheck: 'true',
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined) return false;
        view.dispatch(view.state.tr.insertText(text.replace(/\r?\n|\r/g, ' ')));
        return true;
      },
    },
  }, [doc, body]);

  useLayoutEffect(() => {
    body?.setEditable(editable);
    title?.setEditable(editable);
  }, [body, title, editable]);

  // Destroy bindings during layout cleanup, before the session destroys its Doc
  // in the parent's passive cleanup.
  useLayoutEffect(() => () => {
    title?.destroy();
    body?.destroy();
  }, [title, body]);

  const selection = useEditorState({
    editor: body,
    selector: ({ editor }) => ({
      paragraph: editor?.isActive('paragraph') ?? false,
      heading: [1, 2, 3].find(level => editor?.isActive('heading', { level })) ?? 0,
      undo: editor?.can().undo() ?? false,
      redo: editor?.can().redo() ?? false,
    }),
  });

  return (
    <>
      <div className="page-title"><EditorContent editor={title} /></div>
      <FormattingToolbar editor={body} editable={editable} selection={selection} />
      <EditorContent editor={body} className="page-body" />
    </>
  );
}
