import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { Plugin, TextSelection } from '@tiptap/pm/state';

function preserveRemoteListRepair(): Plugin {
  return new Plugin({
    filterTransaction(transaction) {
      // Tiptap's local select-all normalizer also runs on remote updates.
      // Do not let it replace a committed empty-list repair with a paragraph.
      if (isChangeOrigin(transaction)) transaction.setMeta('preventClearDocument', true);
      return true;
    },
  });
}

function correctTaskFirstCaret(): Plugin {
  return new Plugin({
    appendTransaction(_transactions, _oldState, newState) {
      const selection = newState.selection;
      if (!(selection instanceof TextSelection)
        || (selection.$anchor.parent.inlineContent && selection.$head.parent.inlineContent)) return;
      // Hydration can reuse the first paragraph's numeric caret position in a
      // list wrapper. Move the selection to editable text without changing it.
      const corrected = TextSelection.between(selection.$anchor, selection.$head);
      if (!corrected.eq(selection)) return newState.tr.setSelection(corrected);
    },
  });
}

function keepLocalListIdsUnique(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some(transaction => transaction.docChanged)
        || transactions.some(isChangeOrigin)) return;
      const seen = new Set<string>();
      const tr = newState.tr;
      // Lifting a middle item splits its list into two wrappers. UniqueID's
      // changed-range scan can miss the first wrapper outside that range.
      newState.doc.forEach((node, pos) => {
        if (node.type.name !== 'taskList' || !node.attrs.id) return;
        if (seen.has(node.attrs.id)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: crypto.randomUUID() });
        else seen.add(node.attrs.id);
      });
      if (tr.docChanged) return tr;
    },
  });
}

export function taskListPlugins(): Plugin[] {
  return [preserveRemoteListRepair(), correctTaskFirstCaret(), keepLocalListIdsUnique()];
}
