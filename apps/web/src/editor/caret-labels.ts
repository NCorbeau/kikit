import { Plugin } from '@tiptap/pm/state';
import type { Awareness } from 'y-protocols/awareness';

const VIEWPORT_PADDING = 8;
const MAX_LABEL_WIDTH = 180;

type CaretLabelBounds = {
  left: number;
  right: number;
  maxWidth: number;
};

function caretLabelBounds(editor: HTMLElement): CaretLabelBounds {
  const editorBounds = editor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const left = Math.max(VIEWPORT_PADDING, editorBounds.left);
  const right = Math.min(viewportWidth - VIEWPORT_PADDING, editorBounds.right);

  return {
    left,
    right,
    maxWidth: Math.max(0, Math.min(MAX_LABEL_WIDTH, right - left)),
  };
}

function positionCaretLabel(label: HTMLElement, bounds: CaretLabelBounds): void {
  label.style.maxWidth = `${bounds.maxWidth}px`;
  label.style.left = '0px';
  label.style.right = 'auto';

  const labelBounds = label.getBoundingClientRect();
  const origin = labelBounds.left;
  const left = Math.max(bounds.left, Math.min(origin, bounds.right - labelBounds.width));
  label.style.left = `${left - origin}px`;
}

/** Keep a peer's label readable near either edge without clipping document content. */
export function caretLabels(awareness: Awareness): Plugin {
  return new Plugin({
    view(view) {
      let pendingFrame: number | undefined;
      let destroyed = false;

      function positionLabels(): void {
        pendingFrame = undefined;
        if (destroyed) {
          return;
        }

        const bounds = caretLabelBounds(view.dom);
        for (const caret of view.dom.querySelectorAll<HTMLElement>('.collaboration-caret')) {
          const label = caret.querySelector<HTMLElement>('.collaboration-caret-label');
          if (label) {
            positionCaretLabel(label, bounds);
          }
        }
      }

      function schedulePosition(): void {
        if (destroyed || pendingFrame !== undefined) {
          return;
        }
        pendingFrame = requestAnimationFrame(positionLabels);
      }

      const resizeObserver = typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(schedulePosition);

      function destroy(): void {
        destroyed = true;
        if (pendingFrame !== undefined) {
          cancelAnimationFrame(pendingFrame);
        }
        resizeObserver?.disconnect();
        awareness.off('change', schedulePosition);
        window.removeEventListener('resize', schedulePosition);
        window.removeEventListener('scroll', schedulePosition, true);
      }

      resizeObserver?.observe(view.dom);
      awareness.on('change', schedulePosition);
      window.addEventListener('resize', schedulePosition);
      window.addEventListener('scroll', schedulePosition, true);
      schedulePosition();

      return {
        update: schedulePosition,
        destroy,
      };
    },
  });
}
