import { AppHeader } from '../components/AppHeader';
import type { WorkspaceRecoveryReason } from './useWorkspaceExit';

interface WorkspaceRecoveryProps {
  reason: WorkspaceRecoveryReason;
  localSaved: boolean;
  canContinue: boolean;
  error: string | null;
  onDownload(): void;
  onContinue(): void;
  onHome(): void;
}

export function WorkspaceRecovery({
  reason, localSaved, canContinue, error, onDownload, onContinue, onHome,
}: WorkspaceRecoveryProps) {
  const accessLost = reason === 'access-lost';
  const title = accessLost ? 'This note is no longer available' : 'Your session has ended';
  const description = accessLost
    ? 'Your local draft is retained. Download recovery before continuing.'
    : 'Your local notes are retained. Sign in again to resume synchronization.';

  return (
    <div className="app-shell">
      <AppHeader onHome={onHome}>{null}</AppHeader>
      <main className="account-panel">
        <h1>{title}</h1>
        <p>{description}</p>
        {!localSaved && (
          <p role="alert">Some changes could not be saved on this device. Download recovery before continuing.</p>
        )}
        <button type="button" onClick={onDownload}>Download recovery</button>{' '}
        <button type="button" disabled={!canContinue} onClick={onContinue}>Continue</button>
        {error && <p role="alert">{error}</p>}
      </main>
    </div>
  );
}
