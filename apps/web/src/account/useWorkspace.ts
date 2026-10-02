import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWorkspace, offlineWorkspace, rememberWorkspace, WORKSPACE_KEY, type Workspace } from './client';

const EMPTY: Workspace = { account: null, pages: [] };

/** Auth/session lifetime and offline hints; note bytes remain in account-scoped IndexedDB. */
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY);
  const current = useRef(workspace);
  const [replacement, setReplacement] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const accept = useCallback((next: Workspace) => {
    current.current = next;
    setWorkspace(next);
    setReplacement(null);
    setError(null);
    rememberWorkspace(next);
  }, []);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const next = !navigator.onLine ? offlineWorkspace() : await fetchWorkspace();
      if (!next) throw new Error('Connect to sign in and open your notes for the first time.');
      if (current.current.account && current.current.account.accountId !== next.account?.accountId) {
        // Keep the old session alive for recovery until the UI can safely leave it.
        setReplacement(next);
      } else accept(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open your notes.');
    } finally { running.current = false; setLoading(false); }
  }, [accept]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { if (navigator.onLine) void refresh(); }, 30_000);
    const storage = (event: StorageEvent) => {
      if (event.key === WORKSPACE_KEY) void refresh();
    };
    const check = () => { void refresh(); };
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    window.addEventListener('storage', storage);
    window.addEventListener('kikit-session-ended', check);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', storage);
      window.removeEventListener('kikit-session-ended', check);
    };
  }, [refresh]);
  return { workspace, replacement, loading, error, refresh, accept };
}
