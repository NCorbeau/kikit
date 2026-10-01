import { useEffect, useState, useSyncExternalStore } from 'react';
import { createDocumentSession } from './session';
import { PageEditor } from './editor/PageEditor';

export default function App() {
  const [session] = useState(createDocumentSession);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [exportError, setExportError] = useState<string | null>(null);
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

  const failed = snapshot.local === 'error' || snapshot.connection === 'error' || Boolean(snapshot.error);
  const localLabel = snapshot.local === 'error' ? 'Device save failed' : snapshot.local === 'saving' ? 'Saving locally…' : 'Saved on this device';
  const saveLabel = snapshot.local === 'error' ? 'Device save failed' : snapshot.local === 'saving' ? 'Saving locally…' : snapshot.serverSaved ? 'Saved to server' : 'Saved on this device';
  const connectionLabel = snapshot.connection === 'online' ? 'Connected' : snapshot.connection === 'offline' ? 'Offline' : snapshot.connection === 'connecting' ? 'Connecting…' : 'Connection error';
  const serverLabel = failed ? 'Server save not confirmed' : snapshot.connection === 'offline' ? 'Offline' : snapshot.connection === 'connecting' ? 'Connecting…' : snapshot.serverSaved && snapshot.local === 'saved' ? 'Saved to server' : 'Syncing to server…';

  return <div className="app-shell">
    <a href="#writing" className="skip-link">Skip to writing</a>
    <header className="app-header">
      <a className="brand" href="/" aria-label="Kikit home"><span className="brand-mark" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M6 4v16M18 4 8 12l10 8M12 9l6 3-6 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>kikit<span className="brand-dot">.</span></a>
      <span className="header-divider" aria-hidden="true" />
      <span className="notebook-label">Development notebook</span>
      <span className="dev-badge">Local preview</span>
    </header>

    <div className="document-chrome">
      <div className="document-location"><PageIcon /><span>Your first page</span></div>
      <div className="document-actions">
        <details className="save-details">
          <summary className={`save-summary ${failed ? 'has-error' : ''}`}><span className={`status-dot ${snapshot.connection === 'offline' ? 'is-offline' : failed ? 'is-error' : snapshot.serverSaved ? 'is-saved' : 'is-saving'}`} /><span data-testid="save-status" role="status" aria-live="polite">{snapshot.ready ? saveLabel : 'Opening your page…'}</span><span data-testid="connection-status" className="connection-label">{connectionLabel}</span><span className="disclosure-chevron" aria-hidden="true">⌄</span></summary>
          <div className="save-popover">
            <p className="popover-title">Your words, accounted for.</p>
            <div className="save-line"><span>Device</span><strong>{snapshot.ready ? localLabel : 'Loading…'}</strong></div>
            <div className="save-line"><span>Server</span><strong>{serverLabel}</strong></div>
            <p>{snapshot.pending > 0 ? `${snapshot.pending} ${snapshot.pending === 1 ? 'change is' : 'changes are'} waiting for server confirmation.` : snapshot.serverSaved ? 'All changes have been committed to the server.' : 'Waiting for a confirmed server save.'}</p>
            <button type="button" className="text-button" onClick={() => session.retry()}>Reconnect & retry</button>
          </div>
        </details>
        <button type="button" className="export-button" onClick={exportRecovery} disabled={!snapshot.ready} aria-label="Download recovery file" title="Download recovery file"><DownloadIcon /><span>Export recovery</span></button>
      </div>
    </div>

    <main id="writing" className="writing-area" tabIndex={-1}>
      <div className="page-eyebrow"><span className="page-emblem" aria-hidden="true">✳</span><span>A LITTLE ROOM FOR YOUR IDEAS</span></div>
      {(failed || exportError) && <div className="notice error-notice" role="alert"><strong>Let’s keep your words safe.</strong><p>{exportError ?? snapshot.error ?? 'Your changes have not been confirmed as saved. Keep this tab open while you retry or download a recovery file.'}</p><div className="notice-actions"><button type="button" onClick={() => session.retry()}>Try again</button><button type="button" onClick={exportRecovery}>Download recovery</button></div></div>}
      {snapshot.ready && snapshot.connection === 'offline' && !failed && <div className="notice offline-notice" role="status"><span className="status-dot is-offline" /><p>You’re offline. {snapshot.local === 'saved' ? 'Your changes are saved on this device.' : 'Your changes are saving on this device.'} We’ll sync when you reconnect.</p></div>}
      {snapshot.ready ? <PageEditor doc={session.doc} editable={snapshot.editable} /> : <div className="loading-page" aria-busy="true"><div className="skeleton skeleton-title" /><div className="skeleton" /><div className="skeleton skeleton-short" /><p>{failed ? 'Your page will open when it can be safely recovered.' : 'Making space for your words…'}</p></div>}
    </main>
    <footer className="app-footer"><span data-testid="local-status"><span className="status-dot is-local" />{snapshot.ready ? localLabel : 'Loading this device’s copy'}</span><span>Development fixture · No real account or private storage</span></footer>
  </div>;
}

function PageIcon() {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M11.5 2.5H5A1.5 1.5 0 0 0 3.5 4v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5l-5-5Z" stroke="currentColor" strokeWidth="1.3" /><path d="M11 3v5h5M7 11h6M7 14h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}
function DownloadIcon() {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5v9m-3-3 3 3 3-3M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
