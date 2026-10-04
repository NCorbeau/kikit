import { wrappingInputRule } from '@tiptap/core';
import TaskItem from '@tiptap/extension-task-item';
import { yUndoPluginKey } from '@tiptap/y-tiptap';

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

    return props => {
      const nodeView = render(props);
      const checkbox = (nodeView.dom as HTMLElement).querySelector('input');
      if (!checkbox) return nodeView;
      const { editor } = props;
      let restoreKeyboardFocus = false;
      let focusFrame: number | undefined;
      const updateEditable = () => {
        if (checkbox.disabled !== !editor.isEditable) checkbox.disabled = !editor.isEditable;
      };
      const stopCapturing = () => {
        yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
      };
      // Keep a checkbox action separate from the preceding/following typing and
      // other toggles, even within Yjs's normal typing capture window.
      const beforeChange = () => {
        restoreKeyboardFocus = document.activeElement === checkbox;
        stopCapturing();
      };
      const afterChange = () => {
        stopCapturing();
        if (restoreKeyboardFocus) {
          checkbox.focus({ preventScroll: true });
          // The library schedules editor focus on the next animation frame.
          // Keyboard toggles keep focus on the native checkbox for the next Tab.
          focusFrame = requestAnimationFrame(() => {
            focusFrame = undefined;
            if (!editor.isDestroyed) checkbox.focus({ preventScroll: true });
          });
        }
      };
      const undoFromCheckbox = (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey || !editor.isEditable) return;
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        if (key === 'y' || event.shiftKey) editor.commands.redo();
        else editor.commands.undo();
      };
      checkbox.addEventListener('change', beforeChange, true);
      checkbox.addEventListener('change', afterChange);
      checkbox.addEventListener('keydown', undoFromCheckbox);
      editor.on('transaction', updateEditable);
      editor.on('update', updateEditable);
      updateEditable();

      return {
        ...nodeView,
        // Space/Tab belong to the native checkbox when it has keyboard focus.
        stopEvent: event => checkbox.contains(event.target as globalThis.Node)
          || (nodeView.stopEvent?.(event) ?? false),
        ignoreMutation: mutation => (mutation.type !== 'selection'
          && (checkbox.parentElement?.contains(mutation.target) ?? false))
          || (nodeView.ignoreMutation?.(mutation) ?? false),
        destroy() {
          checkbox.removeEventListener('change', beforeChange, true);
          checkbox.removeEventListener('change', afterChange);
          checkbox.removeEventListener('keydown', undoFromCheckbox);
          if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
          editor.off('transaction', updateEditable);
          editor.off('update', updateEditable);
          nodeView.destroy?.();
        },
      };
    };
  },
}).configure({
  nested: false,
  HTMLAttributes: { 'data-type': 'taskItem' },
  a11y: { checkboxLabel: node => `Complete task: ${node.textContent || 'Empty task'}` },
});
