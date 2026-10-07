import { useEffect, useRef } from 'react';
import type { PageSummary } from '@kikit/contracts';
import { DocumentPage } from './components/DocumentPage';
import { AppHeader } from './components/AppHeader';
import { useDocumentSession } from './session/useDocumentSession';
import { useWorkspace } from './account/useWorkspace';
import type { Workspace } from './account/client';
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

function OpeningWorkspace({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <div className="app-shell">
      <AppHeader>{null}</AppHeader>
      <main className="account-panel">
        <p role="status">{error ?? 'Opening Kikit…'}</p>
        {error && <button type="button" onClick={onRetry}>Try again</button>}
      </main>
    </div>
  );
}

export default function App() {
  const { workspace, replacement, loading, error, refresh, accept } = useWorkspace();
  const navigation = useAppRoute();
  const account = workspace.account;
  const pageId = navigation.route.kind === 'page' ? navigation.route.pageId : null;
  const mountedPage = useRef<{ accountId: string; pageId: string } | null>(null);

  useEffect(() => {
    if (replacement && !pageId) accept(replacement);
  }, [replacement, pageId, accept]);

  function openPage(id: string | null) {
    navigation.commit(id ? { kind: 'page', pageId: id } : { kind: 'notes' });
  }

  function showNotes() {
    openPage(null);
  }

  function refreshNotes() {
    showNotes();
    void refresh();
  }

  function signedOut() {
    showNotes();
    accept({ account: null, pages: [] });
  }

  function replaceWorkspace(next: Workspace) {
    showNotes();
    accept(next);
    void refresh();
  }

  function joinedPage(page: PageSummary) {
    const otherPages = workspace.pages.filter(existing => existing.id !== page.id);
    accept({ ...workspace, pages: [...otherPages, page] });
    openPage(page.id);
    void refresh();
  }

  if (loading || (error && !account)) {
    return <OpeningWorkspace error={error} onRetry={() => { void refresh(); }} />;
  }
  if (navigation.route.kind === 'invalid-invitation') {
    return <InvalidInvitation onNotes={showNotes} />;
  }
  if (!account) {
    return <SignIn continuation={signInContinuation(navigation.route)} />;
  }
  if (account.fixture && import.meta.env.DEV) {
    return <LocalFixture />;
  }
  if (navigation.route.kind === 'join') {
    return (
      <JoinPage
        key={`${account.accountId}:${navigation.route.token}`}
        workspace={workspace}
        token={navigation.route.token}
        onNotes={showNotes}
        onJoined={joinedPage}
      />
    );
  }
  if (navigation.route.kind === 'resume-join') {
    return <MissingInvitation onNotes={showNotes} />;
  }

  const pageIsListed = workspace.pages.some(page => page.id === pageId);
  if (pageIsListed && pageId) {
    mountedPage.current = { accountId: account.accountId, pageId };
  }
  // Revocation can remove a page from the listing while its session still owns
  // a recoverable draft. Keep that same account/page mounted until departure.
  const pageWasMounted = mountedPage.current?.accountId === account.accountId
    && mountedPage.current?.pageId === pageId;

  if (pageId && (pageIsListed || pageWasMounted)) {
    const nextWorkspace = replacement ?? (pageIsListed ? null : workspace);
    return (
      <WorkspaceEditor
        key={`${account.accountId}:${pageId}`}
        workspace={workspace}
        pageId={pageId}
        replacement={nextWorkspace}
        accessLost={!pageIsListed}
        navigationRequest={navigation.requested}
        onNavigate={navigation.commit}
        onCancelNavigation={navigation.cancel}
        onGuardNavigation={navigation.guard}
        onReplace={replaceWorkspace}
        onRecovered={page => accept({ ...workspace, pages: [...workspace.pages.filter(existing => existing.id !== page.id), page] })}
        onNotes={refreshNotes}
        onSignedOut={signedOut}
      />
    );
  }

  return (
    <Notes
      workspace={workspace}
      onOpen={openPage}
      onChanged={accept}
      onSignedOut={signedOut}
    />
  );
}
