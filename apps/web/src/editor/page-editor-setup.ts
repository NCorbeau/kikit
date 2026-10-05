import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { UseEditorOptions } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import Text from '@tiptap/extension-text';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import UniqueID from '@tiptap/extension-unique-id';
import Placeholder from '@tiptap/extension-placeholder';
import { TextSelection } from '@tiptap/pm/state';
import { BODY_FRAGMENT, TITLE_FRAGMENT } from '@kikit/contracts';
import type { Doc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { participantCursors } from './participant-cursors';
import { FlatTaskItem } from './task-item';
import { FlatTaskList } from './task-list';

const TitleDocument = Document.extend({ content: 'paragraph' });

/** Keep ProseMirror behavior beside its schema and collaboration setup. */
export function bodyEditorOptions(doc: Doc, awareness: Awareness, editable: boolean): UseEditorOptions {
  return {
    editable,
    extensions: [
      Document,
      Paragraph,
      Heading.configure({ levels: [1, 2, 3] }),
      Text,
      FlatTaskList,
      FlatTaskItem,
      Collaboration.configure({ document: doc, field: BODY_FRAGMENT }),
      participantCursors(awareness, doc.getXmlFragment(BODY_FRAGMENT)),
      UniqueID.configure({
        types: ['paragraph', 'heading', 'taskList', 'taskItem'],
        generateID: () => crypto.randomUUID(),
        // Remote edits already carry their author's IDs. Only local splits and
        // pasted blocks should mint new identities.
        filterTransaction: transaction => !isChangeOrigin(transaction),
      }),
      Placeholder.configure({ placeholder: 'Write something…' }),
    ],
    editorProps: {
      handleClick(view, pos) {
        const target = view.state.doc.resolve(pos);
        if (target.parent.type.name !== 'paragraph' || target.parent.content.size !== 0
          || target.depth < 2 || target.node(-1).type.name !== 'taskItem') return false;
        // Native selection can land on a list wrapper when an empty task has
        // just been repaired. Honor the text position from the click hit-test.
        view.dispatch(view.state.tr.setSelection(TextSelection.near(target)));
        view.focus();
        return true;
      },
      handleDOMEvents: {
        focus(view, event) {
          // Native Tab focus does not restore a DOM caret after collaborative
          // hydration. Use the valid ProseMirror selection when entering body.
          const selection = view.dom.ownerDocument.getSelection();
          if (event.target === view.dom && (!selection?.rangeCount
            || !view.dom.contains(selection.anchorNode) || !view.dom.contains(selection.focusNode))) view.focus();
          return false;
        },
      },
      attributes: {
        class: 'body-editor',
        role: 'textbox',
        'aria-label': 'Page body',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
    },
  };
}

export function titleEditorOptions(doc: Doc, awareness: Awareness, body: Editor | null, editable: boolean): UseEditorOptions {
  return {
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
  };
}
