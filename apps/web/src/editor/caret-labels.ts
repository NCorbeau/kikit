import { Plugin } from '@tiptap/pm/state';
import type { Awareness } from 'y-protocols/awareness';

/** Keep a peer's label readable near either edge without clipping document content. */
export function caretLabels(awareness: Awareness): Plugin {
  return new Plugin({
    view(view) {
      let frame: number | undefined;
      let destroyed = false;
      const position = () => {
        frame = undefined;
        if (destroyed) return;
        const editor = view.dom.getBoundingClientRect();
        const viewport = document.documentElement.clientWidth;
        const left = Math.max(8, editor.left);
        const right = Math.min(viewport - 8, editor.right);
        const width = Math.max(0, Math.min(180, right - left));
        for (const caret of view.dom.querySelectorAll<HTMLElement>('.collaboration-caret')) {
          const label = caret.querySelector<HTMLElement>('.collaboration-caret-label');
          if (!label) continue;
          label.style.maxWidth = `${width}px`;
          label.style.left = '0px';
          label.style.right = 'auto';
          const origin = label.getBoundingClientRect().left;
          const labelWidth = label.getBoundingClientRect().width;
          const desired = Math.max(left, Math.min(origin, right - labelWidth));
          label.style.left = `${desired - origin}px`;
        }
      };
      const schedule = () => {
        if (!destroyed && frame === undefined) frame = requestAnimationFrame(position);
      };
      const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
      resize?.observe(view.dom);
      awareness.on('change', schedule);
      window.addEventListener('resize', schedule);
      window.addEventListener('scroll', schedule, true);
      schedule();
      return {
        update: schedule,
        destroy() {
          destroyed = true;
          if (frame !== undefined) cancelAnimationFrame(frame);
          resize?.disconnect();
          awareness.off('change', schedule);
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
        },
      };
    },
  });
}
