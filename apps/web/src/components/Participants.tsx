import { useSyncExternalStore } from 'react';
import type { DocumentPresence } from '../session/presence';

export function Participants({ presence }: { presence: DocumentPresence }) {
  const snapshot = useSyncExternalStore(presence.subscribe, presence.getSnapshot);
  if (!snapshot.connected || snapshot.participants.length < 2) return null;
  return <div className="participant-row">
    <span className="participant-heading">On this page</span>
    <ul className="participants" aria-label="Participants" aria-live="polite">
      {snapshot.participants.map(participant => <li key={participant.clientId} data-testid="participant" data-account-id={participant.accountId} data-client-id={participant.clientId} title={participant.name}>
        <span className="participant-dot" aria-hidden="true" style={{ backgroundColor: participant.color }} />
        <span className="participant-name">{participant.local ? 'You' : participant.name}</span>
      </li>)}
    </ul>
  </div>;
}
