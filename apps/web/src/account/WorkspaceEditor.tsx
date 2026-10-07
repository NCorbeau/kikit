import type { Workspace } from './client';
import type { AppRoute } from '../sharing/routes';
import { useDocumentSession } from '../session/useDocumentSession';
import { DocumentPage } from '../components/DocumentPage';
import { ShareControls } from '../sharing/ShareControls';
import { LeavePageDialog } from './LeavePageDialog';
import { WorkspaceRecovery } from './WorkspaceRecovery';
import { useWorkspaceExit } from './useWorkspaceExit';

interface WorkspaceEditorProps {
  workspace: Workspace;
  pageId: string;
  replacement: Workspace | null;
  accessLost: boolean;
  navigationRequest: AppRoute | null;
  onNavigate(route: AppRoute): void;
  onCancelNavigation(): void;
  onGuardNavigation(active: boolean): void;
  onNotes(): void;
  onSignedOut(): void;
  onReplace(workspace: Workspace): void;
}

export function WorkspaceEditor(props: WorkspaceEditorProps) {
  const { workspace, pageId } = props;
  const account = workspace.account!;
  const { session, snapshot } = useDocumentSession({
    accountId: account.accountId,
    pageId,
    fixture: account.fixture,
  });
  const exit = useWorkspaceExit({ ...props, session, snapshot });
  const isOwner = workspace.pages.find(page => page.id === pageId)?.role === 'owner';
  const sharingDisabled = exit.busy || exit.intent !== null || snapshot.connection !== 'online';

  function openNotes() {
    void exit.requestLeave({ kind: 'notes' });
  }

  function signOut() {
    void exit.requestLeave({ kind: 'signout' });
  }

  if (exit.recoveryReason) {
    return (
      <WorkspaceRecovery
        reason={exit.recoveryReason}
        localSaved={exit.localSaved}
        canContinue={exit.canContinue}
        error={exit.error}
        onDownload={exit.exportDraft}
        onContinue={() => { void exit.finish(); }}
        onHome={exit.continueFromHome}
      />
    );
  }

  return (
    <>
      <DocumentPage
        session={session}
        snapshot={snapshot}
        onHome={openNotes}
        actionsDisabled={exit.busy}
        onSignOut={signOut}
        shareAction={isOwner && <ShareControls pageId={pageId} accountId={account.accountId} disabled={sharingDisabled} />}
        deleteAction={isOwner && (
          <button type="button" disabled={exit.busy || exit.intent !== null || snapshot.connection === 'offline' || !snapshot.ready}
            onClick={() => { void exit.requestLeave({ kind: 'delete' }); }}>
            Delete note
          </button>
        )}
      />
      {exit.intent && exit.confirmationRequired && (
        <LeavePageDialog
          intent={exit.intent}
          pending={snapshot.pending}
          localSaved={exit.localSaved}
          busy={exit.busy}
          canContinue={exit.canContinue}
          error={exit.error}
          onCancel={exit.keepEditing}
          onDownload={exit.exportDraft}
          onContinue={() => { void exit.finish(); }}
        />
      )}
    </>
  );
}
