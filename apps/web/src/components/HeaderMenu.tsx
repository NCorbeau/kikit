import { useId, useRef, useState, type ReactNode } from 'react';

/** Native popovers own light dismissal and keyboard focus; actions remain ordinary buttons. */
export function HeaderMenu({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={trigger} type="button" className="icon-button menu-trigger"
        popoverTarget={id} aria-label={label} title={label} aria-expanded={open} aria-controls={id}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" />
        </svg>
      </button>
      <div
        id={id} popover="auto" className="header-menu" role="region" aria-label={label}
        onToggle={event => setOpen(event.newState === 'open')}
        onClickCapture={event => {
          if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)
            || !event.target.closest('button')) return;
          event.currentTarget.hidePopover();
          // Restore before a sharing/leave dialog mounts, so closing that dialog
          // returns to a visible control rather than an item in the closed menu.
          trigger.current?.focus();
        }}
      >
        {children}
      </div>
    </>
  );
}
