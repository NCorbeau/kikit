import TaskList from '@tiptap/extension-task-list';
import type { Command } from '@tiptap/core';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { Plugin, TextSelection } from '@tiptap/pm/state';
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

export const FlatTaskList = TaskList.extend({
  // Empty concurrent merges are transient. The server requires an item and
  // repairs it before acknowledging; the client must retain the list's Yjs
  // identity while that committed repair is in flight.
  content: 'taskItem*',

  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(transaction) {
        // Tiptap's local select-all deletion normalizer also runs on remote
        // updates. An empty committed task repair must retain its wrappers
        // and IDs instead of being cleared to a new paragraph.
        if (isChangeOrigin(transaction)) transaction.setMeta('preventClearDocument', true);
        return true;
      },
      appendTransaction(_transactions, _oldState, newState) {
        const selection = newState.selection;
        if (!(selection instanceof TextSelection)
          || (selection.$anchor.parent.inlineContent && selection.$head.parent.inlineContent)) return;
        // The collaboration binding reuses the initial paragraph's numeric
        // caret position during hydration. A checklist at that position has
        // wrappers instead of inline content. Resolve to the nearest text,
        // also after remote updates; this transaction changes selection only.
        const corrected = TextSelection.between(selection.$anchor, selection.$head);
        if (!corrected.eq(selection)) return newState.tr.setSelection(corrected);
      },
    }), new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        if (!transactions.some(transaction => transaction.docChanged)
          || transactions.some(isChangeOrigin)) return;
        const seen = new Set<string>();
        const tr = newState.tr;
        // Lifting a middle item splits its list into two wrappers. UniqueID's
        // changed-range scan can miss the first wrapper outside that range.
        // Keep its identity and mint one for the new local wrapper only.
        newState.doc.forEach((node, pos) => {
          if (node.type.name !== 'taskList' || !node.attrs.id) return;
          if (seen.has(node.attrs.id)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: crypto.randomUUID() });
          else seen.add(node.attrs.id);
        });
        if (tr.docChanged) return tr;
      },
    })];
  },

  addCommands() {
    return {
      ...this.parent?.(),
      toggleTaskList: () => ({ tr, state, commands, dispatch }) => {
        const range = tr.selection.$from.blockRange(tr.selection.$to);
        if (!range) return false;
        // The library handles lifting selected existing tasks, including a
        // whole-document selection containing only a list.
        if (range.depth > 0 || (range.startIndex + 1 === range.endIndex
          && range.parent.child(range.startIndex).type.name === this.name)) {
          return commands.toggleList(this.name, this.options.itemTypeName);
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
          if (!commands.wrapInList(this.name)) return false;
        }

        const from = tr.mapping.slice(mappingStart).map(range.start, -1);
        const to = tr.mapping.slice(mappingStart).map(range.end, 1);
        const joins: number[] = [];
        tr.doc.forEach((node, pos) => {
          if (pos >= from && pos <= to && node.type.name === this.name
            && tr.doc.resolve(pos).nodeBefore?.type === node.type && canJoin(tr.doc, pos)) joins.push(pos);
        });
        for (const pos of joins.reverse()) tr.join(pos);
        tr.setSelection(bookmark.map(tr.mapping.slice(mappingStart)).resolve(tr.doc));
        return true;
      },
    };
  },
});
