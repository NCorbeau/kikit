import { useEffect, useState, useSyncExternalStore } from 'react';
import { createDocumentSession } from './session';
import { PageEditor } from './editor/PageEditor';
import { AppHeader } from './components/AppHeader';
import { DownloadIcon, PageIcon } from './components/Icons';
import { SaveStatus, deviceSaveLabel, hasSaveFailure } from './components/SaveStatus';

export default function App() {
  const [session] = useState(createDocumentSession);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [exportError, setExportError] = useState<string | null>(null);
  const failed = hasSaveFailure(snapshot);
  const retry = () => session.retry();

  useEffect(() => {
    void session.start();
    return () => session.destroy();
  }, [session]);

  function exportRecovery() {
    try {
      const data = session.exportRecovery();
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `kikit-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError(null);
    } catch {
      setExportError('The recovery file could not be created. Keep this tab open and try again.');
    }
  }

  return (
    <div className="app-shell">
      <a href="#writing" className="skip-link">Skip to writing</a>
      <AppHeader />
      <div className="document-chrome">
        <div className="document-location"><PageIcon /><span>Your first page</span></div>
        <div className="document-actions">
          <SaveStatus snapshot={snapshot} onRetry={retry} />
          <button
            type="button" className="export-button" onClick={exportRecovery}
            disabled={!snapshot.ready} aria-label="Download recovery file" title="Download recovery file"
          >
            <DownloadIcon /><span>Export recovery</span>
          </button>
        </div>
      </div>

      <main id="writing" className="writing-area" tabIndex={-1}>
        <div className="page-eyebrow">
          <span className="page-emblem" aria-hidden="true">✳</span>
          <span>A LITTLE ROOM FOR YOUR IDEAS</span>
        </div>
        {(failed || exportError) && (
          <div className="notice error-notice" role="alert">
            <strong>Let’s keep your words safe.</strong>
            <p>{exportError ?? snapshot.error ?? 'Your changes have not been confirmed as saved. Keep this tab open while you retry or download a recovery file.'}</p>
            <div className="notice-actions">
              <button type="button" onClick={retry}>Try again</button>
              <button type="button" onClick={exportRecovery}>Download recovery</button>
            </div>
          </div>
        )}
        {snapshot.ready && snapshot.connection === 'offline' && !failed && (
          <div className="notice offline-notice" role="status">
            <span className="status-dot is-offline" />
            <p>
              You’re offline. {snapshot.local === 'saved'
                ? 'Your changes are saved on this device.'
                : 'Your changes are saving on this device.'} We’ll sync when you reconnect.
            </p>
          </div>
        )}
        {snapshot.ready
          ? <PageEditor doc={session.doc} editable={snapshot.editable} />
          : <LoadingPage failed={failed} />}
      </main>
      <footer className="app-footer">
        <span data-testid="local-status">
          <span className="status-dot is-local" />
          {snapshot.ready ? deviceSaveLabel(snapshot.local) : 'Loading this device’s copy'}
        </span>
        <span>Development fixture · No real account or private storage</span>
      </footer>
    </div>
  );
}

function LoadingPage({ failed }: { failed: boolean }) {
  return (
    <div className="loading-page" aria-busy="true">
      <div className="skeleton skeleton-title" />
      <div className="skeleton" />
      <div className="skeleton skeleton-short" />
      <p>{failed ? 'Your page will open when it can be safely recovered.' : 'Making space for your words…'}</p>
    </div>
  );
}
