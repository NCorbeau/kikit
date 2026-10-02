import { useEffect, useRef, useState } from 'react';
import type { PageSummary } from '@kikit/contracts';
import type { Workspace } from '../account/client';
import { AppHeader } from '../components/AppHeader';
import { joinInvitation } from './client';

export function JoinPage({ token, workspace, onJoined, onNotes }: {
  token: string; workspace: Workspace; onJoined(page: PageSummary): void; onNotes(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  async function join() {
    if (busy || !online) return;
    setBusy(true); setError(null);
    try {
      const page = await joinInvitation(token, workspace.account!.accountId);
      if (mounted.current) onJoined(page);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not join this note. Try again.');
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div className="app-shell"><AppHeader>{null}</AppHeader><main className="account-panel">
    <h1>Join shared note</h1>
    <p>Join as <strong>{workspace.account?.email}</strong> to read and edit this note. It will appear in your notes on every device.</p>
    <p>Opening this invitation has not joined the note.</p>
    {!online && <p role="status">Connect to join this note.</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
    <div className="notice-actions">
      <button type="button" className="primary-button" disabled={busy || !online} onClick={() => { void join(); }}>{busy ? 'Joining…' : 'Join note'}</button>
      <button type="button" disabled={busy} onClick={onNotes}>Open your notes</button>
    </div>
  </main></div>;
}

export function InvalidInvitation({ onNotes }: { onNotes(): void }) {
  return <div className="app-shell"><AppHeader>{null}</AppHeader><main className="account-panel">
    <h1>Invalid invitation</h1><p>This invitation is incomplete or invalid. Ask the owner for a new link.</p>
    <button type="button" onClick={onNotes}>Open your notes</button>
  </main></div>;
}

export function MissingInvitation({ onNotes }: { onNotes(): void }) {
  return <div className="app-shell"><AppHeader>{null}</AppHeader><main className="account-panel">
    <h1>Open your invitation again</h1><p>Open your invitation again to join this note. Invitations are kept only in the tab where you opened them.</p>
    <button type="button" onClick={onNotes}>Open your notes</button>
  </main></div>;
}
