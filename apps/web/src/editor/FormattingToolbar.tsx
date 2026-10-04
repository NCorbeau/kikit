import type { Editor } from '@tiptap/react';
import { UndoIcon } from '../components/Icons';
import { liftSelectedTasks } from './task-list-commands';

export interface FormattingSelection {
  paragraph: boolean;
  taskList: boolean;
  heading: number;
  undo: boolean;
  redo: boolean;
}

export function FormattingToolbar({ editor, editable, selection }: {
  editor: Editor | null;
  editable: boolean;
  selection: FormattingSelection | null;
}) {
  const setTextBlock = (level?: 1 | 2 | 3) => {
    if (!editor) return;
    const chain = editor.chain().focus();
    // A task's paragraph cannot become a heading inside its item. Lift the
    // selected items first; their text and paragraph identities survive.
    chain.command(liftSelectedTasks);
    chain.command(({ tr, state }) => {
      const type = level ? state.schema.nodes.heading : state.schema.nodes.paragraph;
      tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
        if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
        tr.setNodeMarkup(pos, type, { ...node.attrs, ...(level ? { level } : {}) });
      });
      return true;
    });
    chain.run();
  };

  return (
    <div className="format-bar" role="group" aria-label="Text formatting">
      <div className="format-group">
        <button
          type="button" className="format-button paragraph-button" aria-label="Paragraph"
          disabled={!editable} aria-pressed={selection?.paragraph}
          onClick={() => setTextBlock()}
        >
          <span className="paragraph-symbol" aria-hidden="true">¶</span> Text
        </button>
        {([1, 2, 3] as const).map(level => (
          <button
            key={level} type="button" className="format-button" aria-label={`Heading ${level}`}
            disabled={!editable} aria-pressed={selection?.heading === level} title={`Heading ${level}`}
            onClick={() => setTextBlock(level)}
          >
            H<span className="heading-number">{level}</span>
          </button>
        ))}
        <button
          type="button" className="format-button task-list-button" aria-label="To-do list"
          disabled={!editable} aria-pressed={selection?.taskList} title="To-do list (⌘/Ctrl Shift 9)"
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        >
          <span aria-hidden="true">☑</span> To-do
        </button>
      </div>
      <span className="toolbar-divider" aria-hidden="true" />
      <div className="format-group">
        <button
          type="button" className="format-button icon-button" aria-label="Undo" title="Undo (⌘/Ctrl Z)"
          disabled={!editable || !selection?.undo} onClick={() => editor?.chain().focus().undo().run()}
        >
          <UndoIcon />
        </button>
        <button
          type="button" className="format-button icon-button" aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)"
          disabled={!editable || !selection?.redo} onClick={() => editor?.chain().focus().redo().run()}
        >
          <UndoIcon redo />
        </button>
      </div>
    </div>
  );
}
