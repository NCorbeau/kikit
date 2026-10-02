import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { SharingState } from '@kikit/contracts';
import { createInvitation, disableInvitation, loadSharing, removeMember, SharingError } from './client';
import { invitationUrl } from './routes';

type Member = SharingState['members'][number];
export type SharingConfirmation =
  | { kind: 'replace' }
  | { kind: 'disable' }
  | { kind: 'remove'; member: Member };
type SharingAction = { kind: 'create' } | SharingConfirmation;

/** Sharing state and newly created secrets live only as long as the dialog does. */
export function useSharingDialog(pageId: string, accountId: string) {
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [confirmation, setConfirmation] = useState<SharingConfirmation | null>(null);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSharing(pageId, accountId, controller.signal)
      .then(setSharing)
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('Could not load sharing controls. Close this dialog and try again.');
        }
      });
    return () => controller.abort();
  }, [pageId, accountId]);

  useEffect(() => {
    let active = true;
    setQr(null);
    setQrError(false);
    if (link) {
      void QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 4, width: 220 })
        .then(value => {
          if (active) {
            setQr(value);
          }
        })
        .catch(() => {
          if (active) {
            setQrError(true);
          }
        });
    }
    return () => { active = false; };
  }, [link]);

  async function applySharingAction(action: SharingAction): Promise<void> {
    switch (action.kind) {
      case 'create':
      case 'replace': {
        const invitation = await createInvitation(pageId, accountId);
        // Never put the returned secret in account hints or the document journal.
        setLink(invitationUrl(invitation.token));
        setSharing(previous => previous ? { ...previous, invitationActive: true } : previous);
        return;
      }
      case 'disable':
        await disableInvitation(pageId, accountId);
        setLink(null);
        setSharing(previous => previous ? { ...previous, invitationActive: false } : previous);
        return;
      case 'remove':
        await removeMember(pageId, accountId, action.member.accountId);
        return;
    }
  }

  async function reloadAfterUncertainChange(): Promise<void> {
    try {
      setSharing(await loadSharing(pageId, accountId));
    } catch {
      // Without fresh server state, keep invitation/member controls disabled.
      setSharing(null);
    }
  }

  async function mutate(action: SharingAction): Promise<void> {
    if (busy || !online) {
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    if (action.kind !== 'remove') {
      // A mutation may commit even if its response is lost. Do not offer an old link.
      setLink(null);
    }

    try {
      await applySharingAction(action);
      setConfirmation(null);
      setSharing(await loadSharing(pageId, accountId));
    } catch (cause) {
      setError(cause instanceof SharingError
        ? cause.message
        : 'Could not confirm the sharing change. Reload controls before trying again.');
      setConfirmation(null);
      await reloadAfterUncertainChange();
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (!link) {
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setError(null);
    } catch {
      setError('Could not copy the link. Select and copy it from the field below.');
    }
  }

  async function reloadControls(): Promise<void> {
    if (busy || !online) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await loadSharing(pageId, accountId);
      setSharing(next);
      if (!next.invitationActive) {
        setLink(null);
      }
    } catch {
      setSharing(null);
      setError('Could not load sharing controls. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return {
    sharing, link, qr, qrError, busy, error, copied, online,
    confirmation, setConfirmation,
    locked: busy || !online || !sharing,
    mutate, copyLink, reloadControls,
  };
}
