import { useEffect, useRef } from 'react';
import { DocumentPage } from './components/DocumentPage';
import { AppHeader } from './components/AppHeader';
import { useDocumentSession } from './session/useDocumentSession';
import { useWorkspace } from './account/useWorkspace';
import { SignIn } from './account/SignIn';
import { Notes } from './account/Notes';
import { WorkspaceEditor } from './account/WorkspaceEditor';
import { JoinPage, InvalidInvitation, MissingInvitation } from './sharing/JoinPage';
import { useAppRoute } from './sharing/useAppRoute';
import { signInContinuation } from './sharing/routes';

function LocalFixture() {
  const { session, snapshot } = useDocumentSession();
  return <DocumentPage session={session} snapshot={snapshot} />;
}

export default function App() {
  const { workspace, replacement, loading, error, refresh, accept } = useWorkspace();
  const navigation = useAppRoute();
  const pageId = navigation.route.kind === 'page' ? navigation.route.pageId : null;
  const mountedPage = useRef<{ accountId: string; pageId: string } | null>(null);
  const open = (id: string | null) => navigation.commit(id ? { kind: 'page', pageId: id } : { kind: 'notes' });
  useEffect(() => {
    if (replacement && !pageId) accept(replacement);
  }, [replacement, pageId, accept]);
  if (loading || (error && !workspace.account)) return <div className="app-shell"><AppHeader>{null}</AppHeader><main className="account-panel">
    <p role="status">{error ?? 'Opening Kikit…'}</p>{error && <button type="button" onClick={() => { void refresh(); }}>Try again</button>}
  </main></div>;
  if (navigation.route.kind === 'invalid-invitation') return <InvalidInvitation onNotes={() => open(null)} />;
  if (!workspace.account) return <SignIn continuation={signInContinuation(navigation.route)} />;
  if (workspace.account.fixture && import.meta.env.DEV) return <LocalFixture />;
  if (navigation.route.kind === 'join') return <JoinPage key={`${workspace.account.accountId}:${navigation.route.token}`} workspace={workspace} token={navigation.route.token}
    onNotes={() => open(null)} onJoined={page => {
      accept({ ...workspace, pages: [...workspace.pages.filter(existing => existing.id !== page.id), page] });
      open(page.id); void refresh();
    }} />;
  if (navigation.route.kind === 'resume-join') return <MissingInvitation onNotes={() => open(null)} />;
  const selected = workspace.pages.some(page => page.id === pageId);
  if (selected && pageId) mountedPage.current = { accountId: workspace.account.accountId, pageId };
  const retained = mountedPage.current?.accountId === workspace.account.accountId && mountedPage.current?.pageId === pageId;
  const signedOut = () => { open(null); accept({ account: null, pages: [] }); };
  if ((selected || retained) && pageId) return <WorkspaceEditor key={`${workspace.account.accountId}:${pageId}`} workspace={workspace} pageId={pageId}
    replacement={replacement ?? (!selected ? workspace : null)} accessLost={!selected}
    navigationRequest={navigation.requested} onNavigate={navigation.commit} onCancelNavigation={navigation.cancel} onGuardNavigation={navigation.guard}
    onReplace={next => { open(null); accept(next); void refresh(); }} onNotes={() => { open(null); void refresh(); }} onSignedOut={signedOut} />;
  return <Notes workspace={workspace} onOpen={open} onChanged={accept} onSignedOut={signedOut} />;
}
