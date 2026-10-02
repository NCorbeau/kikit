import { useEffect, useRef, useState } from 'react';
import { DocumentPage } from './components/DocumentPage';
import { AppHeader } from './components/AppHeader';
import { useDocumentSession } from './session/useDocumentSession';
import { useWorkspace } from './account/useWorkspace';
import { SignIn } from './account/SignIn';
import { Notes } from './account/Notes';
import { WorkspaceEditor } from './account/WorkspaceEditor';

function LocalFixture() {
  const { session, snapshot } = useDocumentSession();
  return <DocumentPage session={session} snapshot={snapshot} />;
}

export default function App() {
  const { workspace, replacement, loading, error, refresh, accept } = useWorkspace();
  const [pageId, setPageId] = useState(() => location.hash.match(/^#\/page\/([a-f0-9-]+)$/)?.[1] ?? null);
  const mountedPage = useRef<{ accountId: string; pageId: string } | null>(null);
  const open = (id: string | null) => { setPageId(id); history.replaceState(null, '', id ? `/#/page/${id}` : '/'); };
  useEffect(() => {
    if (replacement && !pageId) accept(replacement);
  }, [replacement, pageId, accept]);
  if (loading || (error && !workspace.account)) return <div className="app-shell"><AppHeader>{null}</AppHeader><main className="account-panel">
    <p role="status">{error ?? 'Opening Kikit…'}</p>{error && <button type="button" onClick={() => { void refresh(); }}>Try again</button>}
  </main></div>;
  if (!workspace.account) return <SignIn />;
  if (workspace.account.fixture && import.meta.env.DEV) return <LocalFixture />;
  const selected = workspace.pages.some(page => page.id === pageId);
  if (selected && pageId) mountedPage.current = { accountId: workspace.account.accountId, pageId };
  const retained = mountedPage.current?.accountId === workspace.account.accountId && mountedPage.current?.pageId === pageId;
  const signedOut = () => { open(null); accept({ account: null, pages: [] }); };
  if ((selected || retained) && pageId) return <WorkspaceEditor key={`${workspace.account.accountId}:${pageId}`} workspace={workspace} pageId={pageId}
    replacement={replacement ?? (!selected ? workspace : null)} accessLost={!selected} onReplace={next => { open(null); accept(next); }} onNotes={() => { open(null); void refresh(); }} onSignedOut={signedOut} />;
  return <Notes workspace={workspace} onOpen={open} onChanged={accept} onSignedOut={signedOut} />;
}
