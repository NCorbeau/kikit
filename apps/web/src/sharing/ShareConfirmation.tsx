import type { SharingConfirmation } from './useSharingDialog';

function confirmationContent(confirmation: SharingConfirmation) {
  switch (confirmation.kind) {
    case 'remove':
      return {
        title: 'Remove member?',
        description: `${confirmation.member.email} will lose access. Downloaded copies cannot be recalled. They can join again using a valid invitation. To prevent re-entry, disable the invitation before removing this member.`,
        actionLabel: 'Remove member',
      };
    case 'replace':
      return {
        title: 'Replace invitation?',
        description: 'The previous link and QR code will stop accepting new joins. Existing members will keep access.',
        actionLabel: 'Replace invitation',
      };
    case 'disable':
      return {
        title: 'Disable invitation?',
        description: 'The link and QR code will stop accepting new joins. Existing members will keep access.',
        actionLabel: 'Disable invitation',
      };
  }
}

export function ShareConfirmation({ confirmation, busy, locked, onCancel, onConfirm }: {
  confirmation: SharingConfirmation;
  busy: boolean;
  locked: boolean;
  onCancel(): void;
  onConfirm(confirmation: SharingConfirmation): void;
}) {
  const content = confirmationContent(confirmation);

  return (
    <section className="share-confirmation" aria-labelledby="share-confirmation-title">
      <h3 id="share-confirmation-title">{content.title}</h3>
      <p>{content.description}</p>
      <div className="notice-actions">
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="primary-button"
          disabled={locked}
          onClick={() => onConfirm(confirmation)}
        >
          {content.actionLabel}
        </button>
      </div>
    </section>
  );
}
