import type { Editor } from '@tiptap/react';
import { UndoIcon } from '../components/Icons';
import { setTextBlock } from './formatting-commands';
import type { useFormattingFocus } from './useFormattingFocus';

export interface FormattingSelection {
  paragraph: boolean;
  taskList: boolean;
  heading: number;
  undo: boolean;
  redo: boolean;
}

export function FormattingToolbar({ editor, editable, selection, focus }: {
  editor: Editor | null;
  editable: boolean;
  selection: FormattingSelection | null;
  focus: ReturnType<typeof useFormattingFocus>;
}) {
  return (
    <div ref={focus.toolbar} className="format-bar" role="group" aria-label="Text formatting"
      data-writing-focus={focus.writingFocused || undefined} onFocusCapture={focus.focus} onBlurCapture={focus.blur}>
      <div className="format-group">
        <button
          type="button" className="format-button paragraph-button" aria-label="Paragraph"
          disabled={!editable} aria-pressed={selection?.paragraph}
          onClick={() => { if (editor) setTextBlock(editor); }}
        >
          <span className="paragraph-symbol" aria-hidden="true">¶</span> Text
        </button>
        {([1, 2, 3] as const).map(level => (
          <button
            key={level} type="button" className="format-button" aria-label={`Heading ${level}`}
            disabled={!editable} aria-pressed={selection?.heading === level} title={`Heading ${level}`}
            onClick={() => { if (editor) setTextBlock(editor, level); }}
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
