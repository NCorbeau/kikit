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
import type { Doc } from 'yjs';

const TitleDocument = Document.extend({ content: 'paragraph' });

export function PageEditor({ doc, editable }: { doc: Doc; editable: boolean }) {
  const body = useEditor({
    editable,
    extensions: [
      Document, Paragraph, Heading.configure({ levels: [1, 2, 3] }), Text,
      Collaboration.configure({ document: doc, field: BODY_FRAGMENT }),
      UniqueID.configure({
        types: ['paragraph', 'heading'],
        generateID: () => crypto.randomUUID(),
        // Remote edits already carry their author's IDs. Only local splits and
        // pasted blocks should mint new identities.
        filterTransaction: transaction => !isChangeOrigin(transaction),
      }),
      Placeholder.configure({ placeholder: 'Make a little room for your thoughts…' }),
    ],
    editorProps: { attributes: { class: 'body-editor', role: 'textbox', 'aria-label': 'Page body', 'aria-multiline': 'true', spellcheck: 'true' } },
  }, [doc]);

  const title = useEditor({
    editable,
    extensions: [
      TitleDocument, Paragraph, Text,
      Collaboration.configure({ document: doc, field: TITLE_FRAGMENT }),
      Placeholder.configure({ placeholder: 'Untitled' }),
      Extension.create({
        name: 'titleNavigation',
        addKeyboardShortcuts() {
          return {
            Enter: () => { body?.commands.focus('start'); return true; },
            'Shift-Enter': () => { body?.commands.focus('start'); return true; },
          };
        },
      }),
    ],
    editorProps: {
      attributes: { class: 'title-editor', role: 'textbox', 'aria-label': 'Page title', 'aria-multiline': 'false', spellcheck: 'true' },
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
  useLayoutEffect(() => () => { title?.destroy(); body?.destroy(); }, [title, body]);

  const selection = useEditorState({
    editor: body,
    selector: ({ editor }) => ({
      paragraph: editor?.isActive('paragraph') ?? false,
      heading: [1, 2, 3].find(level => editor?.isActive('heading', { level })) ?? 0,
      undo: editor?.can().undo() ?? false,
      redo: editor?.can().redo() ?? false,
      words: editor?.state.doc.textContent.trim().split(/\s+/).filter(Boolean).length ?? 0,
    }),
  });

  return <>
    <div className="page-title"><EditorContent editor={title} /></div>
    <div className="format-bar" role="group" aria-label="Text formatting">
      <div className="format-group">
        <button type="button" className="format-button paragraph-button" aria-label="Paragraph" disabled={!editable} aria-pressed={selection?.paragraph} onClick={() => body?.chain().focus().setParagraph().run()}><span className="paragraph-symbol" aria-hidden="true">¶</span> Text</button>
        {([1, 2, 3] as const).map(level => <button key={level} type="button" className="format-button" aria-label={`Heading ${level}`} disabled={!editable} aria-pressed={selection?.heading === level} title={`Heading ${level}`} onClick={() => body?.chain().focus().setHeading({ level }).run()}>H<span className="heading-number">{level}</span></button>)}
      </div>
      <span className="toolbar-divider" aria-hidden="true" />
      <div className="format-group">
        <button type="button" className="format-button icon-button" aria-label="Undo" title="Undo (⌘/Ctrl Z)" disabled={!editable || !selection?.undo} onClick={() => body?.chain().focus().undo().run()}><UndoIcon /></button>
        <button type="button" className="format-button icon-button" aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" disabled={!editable || !selection?.redo} onClick={() => body?.chain().focus().redo().run()}><UndoIcon redo /></button>
      </div>
    </div>
    <EditorContent editor={body} />
    <footer className="page-footer"><span>{selection?.words ?? 0} {(selection?.words ?? 0) === 1 ? 'word' : 'words'}</span><span>Room to think. Space to write.</span></footer>
  </>;
}

function UndoIcon({ redo = false }: { redo?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={redo ? { transform: 'scaleX(-1)' } : undefined}><path d="M6 4 2.5 7.5 6 11M3 7.5h9a4.5 4.5 0 0 1 0 9h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
