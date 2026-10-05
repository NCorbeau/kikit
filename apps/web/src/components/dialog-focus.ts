import type { KeyboardEvent } from 'react';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Wrap Tab at the visible controls at either edge of a modal dialog. */
export function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(control => control.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
