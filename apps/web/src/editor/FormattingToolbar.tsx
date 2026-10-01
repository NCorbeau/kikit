import type { Editor } from '@tiptap/react';
import { UndoIcon } from '../components/Icons';

export interface FormattingSelection {
  paragraph: boolean;
  heading: number;
  undo: boolean;
  redo: boolean;
  words: number;
}

export function FormattingToolbar({ editor, editable, selection }: {
  editor: Editor | null;
  editable: boolean;
  selection: FormattingSelection | null;
}) {
  return (
    <div className="format-bar" role="group" aria-label="Text formatting">
      <div className="format-group">
        <button
          type="button" className="format-button paragraph-button" aria-label="Paragraph"
          disabled={!editable} aria-pressed={selection?.paragraph}
          onClick={() => editor?.chain().focus().setParagraph().run()}
        >
          <span className="paragraph-symbol" aria-hidden="true">¶</span> Text
        </button>
        {([1, 2, 3] as const).map(level => (
          <button
            key={level} type="button" className="format-button" aria-label={`Heading ${level}`}
            disabled={!editable} aria-pressed={selection?.heading === level} title={`Heading ${level}`}
            onClick={() => editor?.chain().focus().setHeading({ level }).run()}
          >
            H<span className="heading-number">{level}</span>
          </button>
        ))}
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
