import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ShareConfirmation } from './ShareConfirmation';
import { useSharingDialog } from './useSharingDialog';

export function ShareControls({ pageId, accountId, disabled }: {
  pageId: string;
  accountId: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Share</button>
      {open && createPortal(
        <ShareDialog pageId={pageId} accountId={accountId} onClose={() => setOpen(false)} />,
        document.body,
      )}
    </>
  );
}

function ShareDialog({ pageId, accountId, onClose }: {
  pageId: string;
  accountId: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  const {
    sharing, link, qr, qrError, busy, error, copied, online, locked,
    confirmation, setConfirmation, mutate, copyLink, reloadControls,
  } = useSharingDialog(pageId, accountId);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    event.preventDefault();
    if (confirmation) {
      setConfirmation(null);
    } else {
      onClose();
    }
  }

  function keepFocusInsideDialog(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== 'Tab') {
      return;
    }
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter(control => control.getClientRects().length > 0);
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

  return (
    <dialog
      ref={dialog}
      className="share-dialog"
      aria-labelledby="share-title"
      onCancel={handleCancel}
      onKeyDown={keepFocusInsideDialog}
    >
      <div className="share-heading">
        <h2 id="share-title">Share note</h2>
        <button type="button" onClick={onClose} aria-label="Close sharing controls">Close</button>
      </div>
      {!online && <p role="status">Offline. Connect to change invitations or members.</p>}
      {error && (
        <>
          <p role="alert" className="account-error">{error}</p>
          <button type="button" disabled={busy || !online} onClick={() => { void reloadControls(); }}>
            Reload controls
          </button>
        </>
      )}
      {confirmation ? (
        <ShareConfirmation
          confirmation={confirmation}
          busy={busy}
          locked={locked}
          onCancel={() => setConfirmation(null)}
          onConfirm={action => { void mutate(action); }}
        />
      ) : (
        <>
          <section className="share-section" aria-labelledby="invitation-title">
            <h3 id="invitation-title">Invitation</h3>
            <p>Anyone with this link can sign in and join as an editor.</p>
            {!sharing ? (
              <p role="status">Loading sharing controls…</p>
            ) : sharing.invitationActive ? (
              <>
                {!link && <p>An invitation is active. Its link is available only when created. Replace it to get a new link.</p>}
                <div className="notice-actions">
                  <button type="button" disabled={locked} onClick={() => setConfirmation({ kind: 'replace' })}>
                    Replace invitation
                  </button>
                  <button type="button" disabled={locked} onClick={() => setConfirmation({ kind: 'disable' })}>
                    Disable invitation
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="primary-button" disabled={locked} onClick={() => { void mutate({ kind: 'create' }); }}>
                Create invitation
              </button>
            )}
            {link && (
              <div className="invitation-link">
                <label htmlFor="invitation-link">Invitation link</label>
                <input id="invitation-link" value={link} readOnly onFocus={event => event.currentTarget.select()} />
                <button type="button" disabled={busy} onClick={() => { void copyLink(); }}>Copy link</button>
                {copied && <p role="status">Link copied.</p>}
                {qr && <img className="invitation-qr" src={qr} alt="Invitation QR code" width="220" height="220" />}
                {qrError && <p role="status">QR code unavailable. Use the invitation link.</p>}
                <p>Copy this link before closing. It will not be shown again.</p>
              </div>
            )}
          </section>
          <section className="share-section" aria-labelledby="members-title">
            <h3 id="members-title">Members</h3>
            <ul className="share-members">
              {sharing?.members.map(member => (
                <li key={member.accountId}>
                  <div>
                    <strong>{member.name || member.email}</strong>
                    {member.name && member.name !== member.email && <span>{member.email}</span>}
                    <span>{member.role === 'owner' ? 'Owner' : 'Editor'}</span>
                  </div>
                  {member.role === 'editor' && (
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={`Remove ${member.email}`}
                      onClick={() => setConfirmation({ kind: 'remove', member })}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </dialog>
  );
}
