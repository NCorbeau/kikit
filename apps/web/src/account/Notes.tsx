import { useEffect, useRef, useState } from 'react';
import type { Workspace } from './client';
import { authClient, newPage } from './client';
import { AppHeader } from '../components/AppHeader';

export function Notes({ workspace, onOpen, onChanged, onSignedOut }: {
  workspace: Workspace; onOpen(id: string): void; onChanged(workspace: Workspace): void; onSignedOut(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createId = useRef<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  async function create() {
    setBusy(true); setError(null);
    createId.current ??= crypto.randomUUID();
    try {
      const note = await newPage(createId.current, workspace.account!.accountId);
      createId.current = null;
      onChanged({ ...workspace, pages: [...workspace.pages.filter(page => page.id !== note.id), note] });
      onOpen(note.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a note.'); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error('Connect and try again to sign out.');
      onSignedOut();
    } catch { setError('Connect and try again to sign out.'); setBusy(false); }
  }
  return <div className="app-shell"><AppHeader>
    <button type="button" disabled={busy || !online} onClick={() => { void signOut(); }}>Sign out</button>
  </AppHeader>
    <main className="account-panel notes-panel">
      <div className="notes-heading"><h1>Your notes</h1><button type="button" className="primary-button" disabled={busy || !online} onClick={() => { void create(); }}>{busy ? 'Please wait…' : 'New note'}</button></div>
      <p className="account-email">{workspace.account?.email}</p>
      {!online && <p role="status">Offline. Previously opened notes are available on this device.</p>}
      {workspace.pages.length === 0 ? <p>Create your first note to start writing.</p> : <ul className="note-list">
        {workspace.pages.map(page => <li key={page.id}><button type="button" onClick={() => onOpen(page.id)}>{page.title || 'Untitled note'}</button></li>)}
      </ul>}
      {error && <p role="alert" className="account-error">{error}</p>}
    </main>
  </div>;
}
