import { useEffect, useRef, useState } from 'react';
import type { Workspace } from './client';
import { authClient } from './client';
import { useDocumentSession } from '../session/useDocumentSession';
import { downloadRecovery } from '../session/useRecoveryDownload';
import { DocumentPage } from '../components/DocumentPage';
import { AppHeader } from '../components/AppHeader';
import { ShareControls } from '../sharing/ShareControls';
import type { AppRoute } from '../sharing/routes';

export function WorkspaceEditor({ workspace, pageId, replacement, accessLost, navigationRequest, onNavigate, onCancelNavigation, onGuardNavigation, onNotes, onSignedOut, onReplace }: {
  workspace: Workspace; pageId: string; replacement: Workspace | null; accessLost: boolean;
  navigationRequest: AppRoute | null; onNavigate(route: AppRoute): void; onCancelNavigation(): void; onGuardNavigation(active: boolean): void;
  onNotes(): void; onSignedOut(): void; onReplace(workspace: Workspace): void;
}) {
  const account = workspace.account!;
  const { session, snapshot } = useDocumentSession({ accountId: account.accountId, pageId, fixture: account.fixture });
  const [leave, setLeave] = useState<'notes' | 'signout' | 'navigate' | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const recoveryRequired = !!replacement || revoked;
  useEffect(() => {
    onGuardNavigation(true);
    return () => onGuardNavigation(false);
  }, [onGuardNavigation]);
  useEffect(() => {
    const lost = (event: Event) => {
      if ((event as CustomEvent<{ pageId: string }>).detail?.pageId === pageId) setRevoked(true);
    };
    window.addEventListener('kikit-access-lost', lost);
    return () => window.removeEventListener('kikit-access-lost', lost);
  }, [pageId]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (leave && !recoveryRequired) dialog?.showModal();
    return () => { dialog?.close(); };
  }, [leave, recoveryRequired]);
  useEffect(() => { if (recoveryRequired) void session.pause(); }, [recoveryRequired, session]);
  useEffect(() => {
    if (navigationRequest && !recoveryRequired) void requestLeave('navigate');
  }, [navigationRequest, recoveryRequired]);
  async function requestLeave(action: 'notes' | 'signout' | 'navigate') {
    setLeave(action); setBusy(true);
    await session.pause();
    setBusy(false);
  }
  async function finish() {
    if (busy || (snapshot.local !== 'saved' && !exported)) return;
    setBusy(true); setError(null);
    try {
      if (replacement) onReplace(replacement);
      else if (revoked) onReplace({ ...workspace, pages: workspace.pages.filter(page => page.id !== pageId) });
      else if (leave === 'navigate' && navigationRequest) onNavigate(navigationRequest);
      else if (leave === 'notes') onNotes();
      else {
        const result = await authClient.signOut();
        if (result.error) throw new Error('Connect and try again to sign out.');
        onSignedOut();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not leave this page.'); setBusy(false); }
  }
  function exportDraft() {
    try { downloadRecovery(session.exportRecovery()); setExported(true); setError(null); }
    catch { setError('Recovery download failed. Keep this tab open and try again.'); }
  }
  function keepEditing() {
    if (busy) return;
    dialogRef.current?.close();
    setLeave(null); setExported(false); setError(null); onCancelNavigation(); session.retry();
  }
  const dialog = leave || replacement;
  if (recoveryRequired) return <div className="app-shell"><AppHeader onHome={() => {
    if (snapshot.local === 'saved' || exported) void finish();
    else setError('Download recovery before continuing: some changes are not saved on this device.');
  }}>{null}</AppHeader>
    <main className="account-panel"><h1>{accessLost || revoked ? 'This note is no longer available' : 'Your session has ended'}</h1><p>{accessLost || revoked ? 'Your local draft is retained. Download recovery before continuing.' : 'Your local notes are retained. Sign in again to resume synchronization.'}</p>
      {snapshot.local !== 'saved' && <p role="alert">Some changes could not be saved on this device. Download recovery before continuing.</p>}
      <button type="button" onClick={exportDraft}>Download recovery</button>{' '}
      <button type="button" disabled={busy || (snapshot.local !== 'saved' && !exported)} onClick={() => { void finish(); }}>Continue</button>
      {error && <p role="alert">{error}</p>}
    </main></div>;
  return <>
    <DocumentPage session={session} snapshot={snapshot} onHome={() => { void requestLeave('notes'); }} accountActions={<>
      <button type="button" disabled={busy} onClick={() => { void requestLeave('notes'); }}>Notes</button>
      {workspace.pages.find(page => page.id === pageId)?.role === 'owner' && <ShareControls pageId={pageId} accountId={account.accountId} disabled={busy || !!leave || snapshot.connection !== 'online'} />}
      <button type="button" disabled={busy} onClick={() => { void requestLeave('signout'); }}>Sign out</button>
    </>} />
    {dialog && <dialog ref={dialogRef} className="leave-dialog" aria-labelledby="leave-title" onCancel={event => { event.preventDefault(); keepEditing(); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <h2 id="leave-title">{leave === 'signout' ? 'Sign out?' : leave === 'navigate' && navigationRequest?.kind === 'join' ? 'Open invitation?' : leave === 'navigate' && navigationRequest?.kind === 'page' ? 'Open another note?' : 'Return to your notes?'}</h2>
      <p>{snapshot.pending > 0 ? 'Pending changes will stay on this device for this account. Sign in again to synchronize them, or download a recovery file.' : 'Your saved notes will stay on this device for this account.'}</p>
      {snapshot.local !== 'saved' && <p role="alert">Download recovery before leaving: some changes are not saved on this device.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="notice-actions">
        <button type="button" autoFocus disabled={busy} onClick={keepEditing}>Continue editing</button>
        <button type="button" onClick={exportDraft}>Download recovery</button>
        <button type="button" className="primary-button" disabled={busy || (snapshot.local !== 'saved' && !exported)} onClick={() => { void finish(); }}>{leave === 'signout' ? 'Sign out' : leave === 'navigate' && navigationRequest?.kind === 'join' ? 'Open invitation' : leave === 'navigate' && navigationRequest?.kind === 'page' ? 'Open note' : 'Open notes'}</button>
      </div>
    </dialog>}
  </>;
}
