import { useRef, useState, type FocusEvent } from 'react';
import type { Editor } from '@tiptap/react';

/** Keep formatting visible across native body -> toolbar focus transfer. */
export function useFormattingFocus(body: Editor | null) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [writingFocused, setWritingFocused] = useState(false);

  function focus() { setWritingFocused(true); }
  function blur(event: FocusEvent<HTMLElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && (toolbar.current?.contains(next)
      || (body && !body.isDestroyed && body.view.dom.contains(next)))) return;
    setWritingFocused(false);
  }
  return { toolbar, writingFocused, focus, blur };
}
