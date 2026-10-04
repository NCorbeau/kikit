import type { Command } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';

/** Unwrap selected tasks even when the selection also spans ordinary text. */
export const liftSelectedTasks: Command = ({ tr, state, commands, dispatch }) => {
  if (!dispatch) return true;
  const bookmark = tr.selection.getBookmark();
  const mappingStart = tr.mapping.maps.length;
  const positions: number[] = [];
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
    if (node.type.name === 'taskItem') positions.push(pos);
  });
  for (const originalPos of positions.reverse()) {
    const pos = tr.mapping.slice(mappingStart).map(originalPos);
    const item = tr.doc.nodeAt(pos)!;
    tr.setSelection(TextSelection.create(tr.doc, pos + 2, pos + item.nodeSize - 2));
    // Tiptap refreshes its chainable state's cached selection/doc on this read.
    void state.tr;
    if (!commands.liftListItem('taskItem')) return false;
  }
  tr.setSelection(bookmark.map(tr.mapping.slice(mappingStart)).resolve(tr.doc));
  return true;
};

/** Wrap each selected text block without creating a multi-paragraph task item. */
export function toggleSelectedTaskList(listName: string, itemName: string): Command {
  return ({ tr, state, commands, dispatch }) => {
    const range = tr.selection.$from.blockRange(tr.selection.$to);
    if (!range) return false;
    // The library handles lifting selected existing tasks, including a
    // whole-document selection containing only a list.
    if (range.depth > 0 || (range.startIndex + 1 === range.endIndex
      && range.parent.child(range.startIndex).type.name === listName)) {
      return commands.toggleList(listName, itemName);
    }

    if (!dispatch) return true;
    const bookmark = tr.selection.getBookmark();
    const mappingStart = tr.mapping.maps.length;
    const selected: { pos: number; heading: boolean }[] = [];
    state.doc.forEach((node, pos, index) => {
      if (index >= range.startIndex && index < range.endIndex && node.isTextblock) {
        selected.push({ pos, heading: node.type.name === 'heading' });
      }
    });
    // wrapInList needs a temporary multi-paragraph item when wrapping a
    // range at once. Our item schema deliberately forbids that shape, so
    // wrap each text block separately, preserving ProseMirror mappings.
    for (const { pos, heading } of selected.reverse()) {
      if (heading) tr.setNodeMarkup(pos, state.schema.nodes.paragraph, tr.doc.nodeAt(pos)?.attrs);
      const node = tr.doc.nodeAt(pos)!;
      tr.setSelection(TextSelection.create(tr.doc, pos + 1, pos + node.nodeSize - 1));
      void state.tr;
      if (!commands.wrapInList(listName)) return false;
    }

    const from = tr.mapping.slice(mappingStart).map(range.start, -1);
    const to = tr.mapping.slice(mappingStart).map(range.end, 1);
    const joins: number[] = [];
    tr.doc.forEach((node, pos) => {
      if (pos >= from && pos <= to && node.type.name === listName
        && tr.doc.resolve(pos).nodeBefore?.type === node.type && canJoin(tr.doc, pos)) joins.push(pos);
    });
    for (const pos of joins.reverse()) tr.join(pos);
    tr.setSelection(bookmark.map(tr.mapping.slice(mappingStart)).resolve(tr.doc));
    return true;
  };
}
