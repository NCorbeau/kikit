import type { Editor } from '@tiptap/core';
import type { NodeView } from '@tiptap/pm/view';
import { yUndoPluginKey } from '@tiptap/y-tiptap';

/** Add native checkbox behavior to Tiptap's task-item node view. */
export function bindTaskItemCheckbox(nodeView: NodeView, editor: Editor): NodeView {
  const checkbox = (nodeView.dom as HTMLElement).querySelector('input');
  if (!checkbox) return nodeView;

  let restoreKeyboardFocus = false;
  let focusFrame: number | undefined;
  const updateEditable = () => {
    if (checkbox.disabled !== !editor.isEditable) checkbox.disabled = !editor.isEditable;
  };
  const stopCapturing = () => {
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
  };

  // A checkbox change is one undoable action, separate from nearby typing.
  const beforeChange = () => {
    restoreKeyboardFocus = document.activeElement === checkbox;
    stopCapturing();
  };
  const afterChange = () => {
    stopCapturing();
    if (restoreKeyboardFocus) {
      checkbox.focus({ preventScroll: true });
      // The library focuses the editor on the next frame. Keyboard toggles
      // need to leave focus on the checkbox for the next Tab.
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
}
