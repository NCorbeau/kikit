import { useLayoutEffect } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Doc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { FormattingToolbar } from './FormattingToolbar';
import { bodyEditorOptions, titleEditorOptions } from './page-editor-setup';
import { useFormattingFocus } from './useFormattingFocus';

export function PageEditor({ doc, awareness, editable }: { doc: Doc; awareness: Awareness; editable: boolean }) {
  const body = useEditor(bodyEditorOptions(doc, awareness, editable), [doc]);
  const title = useEditor(titleEditorOptions(doc, awareness, body, editable), [doc, body]);
  const formattingFocus = useFormattingFocus(body);

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
      paragraph: (editor?.isActive('paragraph') && !editor.isActive('taskList')) ?? false,
      taskList: editor?.isActive('taskList') ?? false,
      heading: [1, 2, 3].find(level => editor?.isActive('heading', { level })) ?? 0,
      undo: editor?.can().undo() ?? false,
      redo: editor?.can().redo() ?? false,
    }),
  });

  return (
    <>
      <div className="page-title"><EditorContent editor={title} /></div>
      <FormattingToolbar editor={body} editable={editable} selection={selection} focus={formattingFocus} />
      <EditorContent editor={body} className="page-body"
        onFocusCapture={formattingFocus.focus} onBlurCapture={formattingFocus.blur} />
    </>
  );
}
