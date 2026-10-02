import type { ReactNode } from 'react';
import type { DocumentSession, SessionSnapshot } from '../session';
import { useRecoveryDownload } from '../session/useRecoveryDownload';
import { PageEditor } from '../editor/PageEditor';
import { AppHeader } from './AppHeader';
import { DownloadIcon } from './Icons';
import { SaveStatus, hasSaveFailure } from './SaveStatus';
import { Participants } from './Participants';

export function DocumentPage({ session, snapshot, accountActions, onHome }: {
  session: DocumentSession;
  snapshot: SessionSnapshot;
  accountActions?: ReactNode;
  onHome?(): void;
}) {
  const recovery = useRecoveryDownload(session);
  const failed = hasSaveFailure(snapshot);
  const retry = () => session.retry();

  return (
    <div className="app-shell">
      <a href="#writing" className="skip-link" onClick={event => {
        event.preventDefault(); document.getElementById('writing')?.focus();
      }}>Skip to writing</a>
      <AppHeader onHome={onHome}>
        {accountActions}
        <SaveStatus snapshot={snapshot} onRetry={retry} />
        <button
          type="button" className="export-button" onClick={recovery.download}
          disabled={!snapshot.ready} aria-label="Download recovery file" title="Download recovery file"
        >
          <DownloadIcon />
        </button>
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
