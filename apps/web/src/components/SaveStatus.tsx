import type { SessionSnapshot } from '../session';

const CONNECTION_LABELS = {
  online: 'Connected',
  offline: 'Offline',
  connecting: 'Connecting…',
  error: 'Connection error',
};

export function deviceSaveLabel(local: SessionSnapshot['local']): string {
  switch (local) {
    case 'error': return 'Device save failed';
    case 'saving': return 'Saving locally…';
    case 'saved': return 'Saved on this device';
  }
}

export function hasSaveFailure(snapshot: SessionSnapshot): boolean {
  return snapshot.local === 'error' || snapshot.connection === 'error' || Boolean(snapshot.error);
}

function serverSaveLabel(snapshot: SessionSnapshot): string {
  if (hasSaveFailure(snapshot)) return 'Server save not confirmed';
  if (snapshot.connection === 'offline') return 'Offline';
  if (snapshot.connection === 'connecting') return 'Connecting…';
  return snapshot.serverSaved && snapshot.local === 'saved' ? 'Saved to server' : 'Syncing to server…';
}

function confirmationLabel(snapshot: SessionSnapshot): string {
  if (snapshot.pending > 0) {
    const changes = snapshot.pending === 1 ? 'change is' : 'changes are';
    return `${snapshot.pending} ${changes} waiting for server confirmation.`;
  }
  return snapshot.serverSaved
    ? 'All changes have been committed to the server.'
    : 'Waiting for a confirmed server save.';
}

export function SaveStatus({ snapshot, onRetry }: {
  snapshot: SessionSnapshot;
  onRetry: () => void;
}) {
  const failed = hasSaveFailure(snapshot);
  const localLabel = deviceSaveLabel(snapshot.local);
  const summaryLabel = snapshot.local === 'saved' && snapshot.serverSaved
    ? 'Saved to server'
    : localLabel;
  const dotClass = snapshot.connection === 'offline' ? 'is-offline'
    : failed ? 'is-error'
    : snapshot.serverSaved ? 'is-saved' : 'is-saving';

  return (
    <details className="save-details">
      <summary className={`save-summary ${failed ? 'has-error' : ''}`}>
        <span className={`status-dot ${dotClass}`} />
        <span data-testid="save-status" role="status" aria-live="polite">
          {snapshot.ready ? summaryLabel : 'Opening your page…'}
        </span>
        <span data-testid="connection-status" className="connection-label">
          {CONNECTION_LABELS[snapshot.connection]}
        </span>
        <span className="disclosure-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="save-popover">
        <p className="popover-title">Your words, accounted for.</p>
        <div className="save-line">
          <span>Device</span>
          <strong>{snapshot.ready ? localLabel : 'Loading…'}</strong>
        </div>
        <div className="save-line">
          <span>Server</span>
          <strong>{serverSaveLabel(snapshot)}</strong>
        </div>
        <p>{confirmationLabel(snapshot)}</p>
        <button type="button" className="text-button" onClick={onRetry}>
          Reconnect & retry
        </button>
      </div>
    </details>
  );
}
