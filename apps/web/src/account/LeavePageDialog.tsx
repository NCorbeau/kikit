import { useLayoutEffect, useRef } from 'react';
import { containDialogFocus } from '../components/dialog-focus';
import type { WorkspaceExitIntent } from './useWorkspaceExit';

interface LeavePageDialogProps {
  intent: WorkspaceExitIntent;
  pending: number;
  localSaved: boolean;
  busy: boolean;
  canContinue: boolean;
  error: string | null;
  onCancel(): void;
  onDownload(): void;
  onContinue(): void;
}

export function LeavePageDialog({
  intent, pending, localSaved, busy, canContinue, error, onCancel, onDownload, onContinue,
}: LeavePageDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { title, action } = exitCopy(intent);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [intent]);

  return (
    <dialog
      ref={dialogRef}
      className="leave-dialog"
      aria-labelledby="leave-title"
      onCancel={event => { event.preventDefault(); onCancel(); }}
      onKeyDown={containDialogFocus}
    >
      <h2 id="leave-title">{title}</h2>
      <p>
        {pending > 0
          ? 'Pending changes will stay on this device for this account. Sign in again to synchronize them, or download a recovery file.'
          : 'Your saved notes will stay on this device for this account.'}
      </p>
      {!localSaved && (
        <p role="alert">Download recovery before leaving: some changes are not saved on this device.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="notice-actions">
        <button type="button" disabled={busy} onClick={onCancel}>Continue editing</button>
        <button type="button" onClick={onDownload}>Download recovery</button>
        <button type="button" className="primary-button" disabled={!canContinue} onClick={onContinue}>
          {action}
        </button>
      </div>
    </dialog>
  );
}

function exitCopy(intent: WorkspaceExitIntent) {
  if (intent.kind === 'signout') return { title: 'Sign out?', action: 'Sign out' };
  if (intent.kind === 'navigate') {
    if (intent.route.kind === 'join') return { title: 'Open invitation?', action: 'Open invitation' };
    if (intent.route.kind === 'page') return { title: 'Open another note?', action: 'Open note' };
  }
  return { title: 'Return to your notes?', action: 'Open notes' };
}
