import type { Editor } from '@tiptap/core';
import { liftSelectedTasks } from './task-list-commands';

/** Convert selected blocks after lifting any task items around their text. */
export function setTextBlock(editor: Editor, level?: 1 | 2 | 3): void {
  const chain = editor.chain().focus();
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
}
