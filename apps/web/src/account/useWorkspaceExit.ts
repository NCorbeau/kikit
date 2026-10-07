import { useCallback, useEffect, useState } from 'react';
import { authClient, deleteNote, type Workspace } from './client';
import type { AppRoute } from '../sharing/routes';
import type { DocumentSession, SessionSnapshot } from '../session';
import { downloadRecovery } from '../session/useRecoveryDownload';

export type WorkspaceExitIntent =
  | { kind: 'notes' }
  | { kind: 'signout' }
  | { kind: 'delete' }
  | { kind: 'navigate'; route: AppRoute };

export type WorkspaceRecoveryReason = 'access-lost' | 'session-ended';

interface WorkspaceExitOptions {
  session: DocumentSession;
  snapshot: SessionSnapshot;
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

/** Keep the document alive until departure is safe or its draft has been exported. */
export function useWorkspaceExit({
  session, snapshot, workspace, pageId, replacement, accessLost, navigationRequest,
  onNavigate, onCancelNavigation, onGuardNavigation, onNotes, onSignedOut, onReplace,
}: WorkspaceExitOptions) {
  const [intent, setIntent] = useState<WorkspaceExitIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const recoveryRequired = replacement !== null || revoked;
  const recoveryReason: WorkspaceRecoveryReason | null = recoveryRequired
    ? (accessLost || revoked ? 'access-lost' : 'session-ended')
    : null;
  const localSaved = snapshot.local === 'saved';
  const canContinue = !busy && (localSaved || exported);
  const returningToNotes = intent?.kind === 'notes'
    || (intent?.kind === 'navigate' && intent.route.kind === 'notes');
  const confirmationRequired = intent !== null
    && (!returningToNotes || !localSaved || snapshot.pending > 0);

  const requestLeave = useCallback(async (next: WorkspaceExitIntent) => {
    setBusy(true);
    await session.pause();
    setIntent(next);
    setBusy(false);
  }, [session]);

  useEffect(() => {
    // Decide only after pause has settled local writes. Pausing disconnects the
    // transport, so serverSaved no longer describes the note's durability here.
    if (busy || recoveryRequired || !intent || confirmationRequired) return;
    if (intent.kind === 'notes') onNotes();
    else if (intent.kind === 'navigate') onNavigate(intent.route);
  }, [busy, recoveryRequired, intent, confirmationRequired, onNotes, onNavigate]);

  useEffect(() => {
    onGuardNavigation(true);
    return () => onGuardNavigation(false);
  }, [onGuardNavigation]);

  useEffect(() => {
    const lost = (event: Event) => {
      const revokedPage = (event as CustomEvent<{ pageId: string }>).detail?.pageId;
      if (revokedPage === pageId) setRevoked(true);
    };
    window.addEventListener('kikit-access-lost', lost);
    return () => window.removeEventListener('kikit-access-lost', lost);
  }, [pageId]);

  useEffect(() => {
    if (recoveryRequired) void session.pause();
  }, [recoveryRequired, session]);

  useEffect(() => {
    if (navigationRequest && !recoveryRequired) {
      void requestLeave({ kind: 'navigate', route: navigationRequest });
    }
  }, [navigationRequest, recoveryRequired, requestLeave]);

  async function finish() {
    if (!canContinue || (!recoveryRequired && !intent)) return;
    setBusy(true);
    setError(null);

    try {
      if (replacement) {
        onReplace(replacement);
      } else if (revoked) {
        onReplace({ ...workspace, pages: workspace.pages.filter(page => page.id !== pageId) });
      } else if (intent?.kind === 'navigate') {
        onNavigate(intent.route);
      } else if (intent?.kind === 'notes') {
        onNotes();
      } else if (intent?.kind === 'delete') {
        await deleteNote(pageId, workspace.account!.accountId);
        onReplace({ ...workspace, pages: workspace.pages.filter(page => page.id !== pageId) });
      } else if (intent?.kind === 'signout') {
        const result = await authClient.signOut();
        if (result.error) throw new Error('Connect and try again to sign out.');
        onSignedOut();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not leave this page.');
      setBusy(false);
    }
  }

  function exportDraft() {
    try {
      downloadRecovery(session.exportRecovery());
      setExported(true);
      setError(null);
    } catch {
      setError('Recovery download failed. Keep this tab open and try again.');
    }
  }

  function keepEditing() {
    if (busy) return;
    setIntent(null);
    setExported(false);
    setError(null);
    onCancelNavigation();
    session.retry();
  }

  function continueFromHome() {
    if (localSaved || exported) {
      void finish();
    } else {
      setError('Download recovery before continuing: some changes are not saved on this device.');
    }
  }

  return {
    intent, busy, error, recoveryReason, localSaved, canContinue, confirmationRequired,
    requestLeave, finish, exportDraft, keepEditing, continueFromHome,
  };
}
