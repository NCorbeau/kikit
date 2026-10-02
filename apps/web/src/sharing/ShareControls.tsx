import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import type { SharingState } from '@kikit/contracts';
import { createInvitation, disableInvitation, loadSharing, removeMember, SharingError } from './client';
import { invitationUrl } from './routes';

type Member = SharingState['members'][number];
type Confirmation = { kind: 'replace' } | { kind: 'disable' } | { kind: 'remove'; member: Member };

export function ShareControls({ pageId, accountId, disabled }: { pageId: string; accountId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Share</button>
    {open && createPortal(<ShareDialog pageId={pageId} accountId={accountId} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function ShareDialog({ pageId, accountId, onClose }: { pageId: string; accountId: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  useEffect(() => {
    const node = dialog.current; node?.showModal();
    return () => { node?.close(); };
  }, []);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadSharing(pageId, accountId, controller.signal).then(setSharing).catch(() => {
      if (!controller.signal.aborted) setError('Could not load sharing controls. Close this dialog and try again.');
    });
    return () => controller.abort();
  }, [pageId, accountId]);
  useEffect(() => {
    let active = true;
    setQr(null); setQrError(false);
    if (link) void QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 4, width: 220 }).then(value => {
      if (active) setQr(value);
    }).catch(() => { if (active) setQrError(true); });
    return () => { active = false; };
  }, [link]);

  async function mutate(action: 'create' | Confirmation) {
    if (busy || !online) return;
    setBusy(true); setError(null); setCopied(false);
    if (action === 'create' || action.kind !== 'remove') setLink(null);
    try {
      if (action === 'create' || action.kind === 'replace') {
        const invitation = await createInvitation(pageId, accountId);
        // Keep the returned secret only in this mounted dialog, never in account hints or the journal.
        setLink(invitationUrl(invitation.token));
        setSharing(previous => previous ? { ...previous, invitationActive: true } : previous);
      } else if (action.kind === 'disable') {
        await disableInvitation(pageId, accountId); setLink(null);
        setSharing(previous => previous ? { ...previous, invitationActive: false } : previous);
      } else await removeMember(pageId, accountId, action.member.accountId);
      setConfirmation(null);
      setSharing(await loadSharing(pageId, accountId));
    } catch (cause) {
      setError(cause instanceof SharingError ? cause.message : 'Could not confirm the sharing change. Reload controls before trying again.');
      setConfirmation(null);
      try { setSharing(await loadSharing(pageId, accountId)); }
      catch { setSharing(null); }
    }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setError(null); }
    catch { setError('Could not copy the link. Select and copy it from the field below.'); }
  }
  async function refresh() {
    if (busy || !online) return;
    setBusy(true); setError(null);
    try {
      const next = await loadSharing(pageId, accountId);
      setSharing(next);
      if (!next.invitationActive) setLink(null);
    } catch { setSharing(null); setError('Could not load sharing controls. Try again.'); }
    finally { setBusy(false); }
  }
  const locked = busy || !online || !sharing;
  return <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onCancel={event => {
    event.preventDefault(); if (confirmation) setConfirmation(null); else onClose();
  }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter(control => control.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="share-heading"><h2 id="share-title">Share note</h2><button type="button" onClick={onClose} aria-label="Close sharing controls">Close</button></div>
    {!online && <p role="status">Offline. Connect to change invitations or members.</p>}
    {error && <><p role="alert" className="account-error">{error}</p><button type="button" disabled={busy || !online} onClick={() => { void refresh(); }}>Reload controls</button></>}
    {confirmation ? <section className="share-confirmation" aria-labelledby="share-confirmation-title">
      <h3 id="share-confirmation-title">{confirmation.kind === 'remove' ? 'Remove member?' : confirmation.kind === 'replace' ? 'Replace invitation?' : 'Disable invitation?'}</h3>
      <p>{confirmation.kind === 'remove'
        ? `${confirmation.member.email} will lose access. Downloaded copies cannot be recalled. They can join again using a valid invitation. To prevent re-entry, disable the invitation before removing this member.`
        : confirmation.kind === 'replace' ? 'The previous link and QR code will stop accepting new joins. Existing members will keep access.'
          : 'The link and QR code will stop accepting new joins. Existing members will keep access.'}</p>
      <div className="notice-actions">
        <button type="button" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
        <button type="button" className="primary-button" disabled={locked} onClick={() => { void mutate(confirmation); }}>{confirmation.kind === 'remove' ? 'Remove member' : confirmation.kind === 'replace' ? 'Replace invitation' : 'Disable invitation'}</button>
      </div>
    </section> : <>
      <section className="share-section" aria-labelledby="invitation-title">
        <h3 id="invitation-title">Invitation</h3>
        <p>Anyone with this link can sign in and join as an editor.</p>
        {!sharing ? <p role="status">Loading sharing controls…</p> : sharing.invitationActive ? <>
          {!link && <p>An invitation is active. Its link is available only when created. Replace it to get a new link.</p>}
          <div className="notice-actions">
            <button type="button" disabled={locked} onClick={() => setConfirmation({ kind: 'replace' })}>Replace invitation</button>
            <button type="button" disabled={locked} onClick={() => setConfirmation({ kind: 'disable' })}>Disable invitation</button>
          </div>
        </> : <button type="button" className="primary-button" disabled={locked} onClick={() => { void mutate('create'); }}>Create invitation</button>}
        {link && <div className="invitation-link">
          <label htmlFor="invitation-link">Invitation link</label>
          <input id="invitation-link" value={link} readOnly onFocus={event => event.currentTarget.select()} />
          <button type="button" disabled={busy} onClick={() => { void copy(); }}>Copy link</button>
          {copied && <p role="status">Link copied.</p>}
          {qr && <img className="invitation-qr" src={qr} alt="Invitation QR code" width="220" height="220" />}
          {qrError && <p role="status">QR code unavailable. Use the invitation link.</p>}
          <p>Copy this link before closing. It will not be shown again.</p>
        </div>}
      </section>
      <section className="share-section" aria-labelledby="members-title"><h3 id="members-title">Members</h3>
        <ul className="share-members">{sharing?.members.map(member => <li key={member.accountId}>
          <div><strong>{member.name || member.email}</strong>{member.name && member.name !== member.email && <span>{member.email}</span>}<span>{member.role === 'owner' ? 'Owner' : 'Editor'}</span></div>
          {member.role === 'editor' && <button type="button" disabled={locked} aria-label={`Remove ${member.email}`} onClick={() => setConfirmation({ kind: 'remove', member })}>Remove</button>}
        </li>)}</ul>
      </section>
    </>}
  </dialog>;
}
