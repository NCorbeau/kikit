import { wrappingInputRule } from '@tiptap/core';
import TaskItem from '@tiptap/extension-task-item';
import { bindTaskItemCheckbox } from './task-item-node-view';

/** A flat checklist item, with the library's list commands. */
export const FlatTaskItem = TaskItem.extend({
  // Concurrent deletion may temporarily remove the paragraph. Retain the Yjs
  // item until the server's committed repair restores its required paragraph;
  // a stricter client schema makes the binding delete that item's identity.
  content: 'paragraph?',

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: () => this.editor.commands.first(({ commands }) => [
        () => commands.splitListItem(this.name),
        () => commands.liftListItem(this.name),
      ]),
    };
  },

  addInputRules() {
    return [wrappingInputRule({
      find: /^\s*\[([ xX])\]\s$/,
      type: this.type,
      getAttributes: match => ({ checked: match[1]?.toLowerCase() === 'x' }),
    })];
  },

  addNodeView() {
    const render = this.parent?.();
    if (!render) return null;
    return props => bindTaskItemCheckbox(render(props), props.editor);
  },
}).configure({
  nested: false,
  HTMLAttributes: { 'data-type': 'taskItem' },
  a11y: { checkboxLabel: node => `Complete task: ${node.textContent || 'Empty task'}` },
});
