import type { ReactNode } from 'react';
import type { DocumentSession, SessionSnapshot } from '../session';
import { useRecoveryDownload } from '../session/useRecoveryDownload';
import { PageEditor } from '../editor/PageEditor';
import { AppHeader } from './AppHeader';
import { SaveStatus, hasSaveFailure } from './SaveStatus';
import { Participants } from './Participants';
import { useSyncDetails } from './useSyncDetails';

export function DocumentPage({ session, snapshot, shareAction, deleteAction, onSignOut, actionsDisabled, onHome }: {
  session: DocumentSession;
  snapshot: SessionSnapshot;
  shareAction?: ReactNode;
  deleteAction?: ReactNode;
  onSignOut?(): void;
  actionsDisabled?: boolean;
  onHome?(): void;
}) {
  const recovery = useRecoveryDownload(session);
  const failed = hasSaveFailure(snapshot);
  const retry = () => session.retry();
  const syncDetails = useSyncDetails();

  return (
    <div className="app-shell">
      <a href="#writing" className="skip-link" onClick={event => {
        event.preventDefault(); document.getElementById('writing')?.focus();
      }}>Skip to writing</a>
      <AppHeader
        onHome={onHome} menuLabel="Note menu"
        navigation={onHome && (
          <button type="button" className="notes-navigation" disabled={actionsDisabled} onClick={onHome}>
            <span aria-hidden="true">←</span> All notes
          </button>
        )}
        status={syncDetails.visible && <SaveStatus snapshot={snapshot} onRetry={retry} />}
        menuExtras={
          <label className="menu-checkbox">
            <input type="checkbox" checked={syncDetails.visible} onChange={event => syncDetails.changeVisible(event.target.checked)} />
            Show sync details
          </label>
        }
        menuFooter={onSignOut && <button type="button" disabled={actionsDisabled} onClick={onSignOut}>Sign out</button>}
      >
        {shareAction}
        <button
          type="button" onClick={recovery.download} disabled={!snapshot.ready}
        >
          Download recovery file
        </button>
        {deleteAction}
      </AppHeader>

      <main id="writing" className="writing-area" tabIndex={-1}>
        {(failed || recovery.error) && (
          <div className="notice error-notice" role="alert">
            <strong>{recovery.error ? 'Recovery download failed' : 'Unable to save changes'}</strong>
            <p>{recovery.error ?? snapshot.error ?? 'Your changes have not been confirmed as saved. Keep this tab open while you retry or download a recovery file.'}</p>
            <div className="notice-actions">
              <button type="button" onClick={retry}>Try again</button>
              <button type="button" onClick={recovery.download}>Download recovery</button>
            </div>
          </div>
        )}
        {snapshot.ready && snapshot.connection === 'offline' && !failed && (
          <div className="notice offline-notice" role="status">
            <span className="status-dot is-offline" />
            <p>Offline. {snapshot.local === 'saved'
              ? 'Changes are saved on this device.'
              : 'Changes are saving on this device.'}</p>
          </div>
        )}
        <Participants presence={session.presence} />
        {snapshot.ready
          ? <PageEditor doc={session.doc} awareness={session.presence.awareness} editable={snapshot.editable} />
          : <LoadingPage failed={failed} />}
      </main>
    </div>
  );
}

function LoadingPage({ failed }: { failed: boolean }) {
  return (
    <div className="loading-page" aria-busy="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton" />
      <div className="skeleton skeleton-short" />
      <p>{failed ? 'Your page will open when it can be safely recovered.' : 'Opening page…'}</p>
    </div>
  );
}
