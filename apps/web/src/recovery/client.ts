import { pageSummarySchema, pageSessionSchema, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION, decodeUpdate, validateRecoveryState } from '@kikit/contracts';

export async function checkRecoveryAccess(pageId: string, accountId: string): Promise<Uint8Array> {
  const response = await fetch(`/api/pages/${pageId}/recovery-state`, { headers: { 'X-Kikit-Account': accountId }, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401 || (response.ok && response.headers.get('X-Kikit-Account') !== accountId)) {
    window.dispatchEvent(new Event('kikit-session-ended'));
    throw new Error('Your account changed. Keep the file and reopen your notes.');
  }
  if (!response.ok) throw new Error('Connect with access to the original note, or recover a new private copy.');
  const body = await response.json() as { update?: unknown };
  const session = pageSessionSchema.parse(body);
  if (session.pageId !== pageId || session.protocolVersion !== PROTOCOL_VERSION || session.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new Error('This note needs a different version of Kikit. Keep the recovery file.');
  }
  if (session.accountId !== accountId) {
    window.dispatchEvent(new Event('kikit-session-ended'));
    throw new Error('Your account changed. Reopen your notes.');
  }
  if (typeof body.update !== 'string' || body.update.length > Math.ceil(2 * 1024 * 1024 / 3) * 4) {
    throw new Error('Committed recovery state is invalid. Keep the file and try again.');
  }
  const update = decodeUpdate(body.update);
  validateRecoveryState(update);
  return update;
}

export async function recoverCopy(id: string, file: string, accountId: string) {
  const response = await fetch('/api/recovery/copies', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Kikit-Account': accountId }, body: JSON.stringify({ id, recovery: file }) });
  if (response.status === 401 || (response.ok && response.headers.get('X-Kikit-Account') !== accountId)) {
    window.dispatchEvent(new Event('kikit-session-ended'));
    throw new Error('Your account changed. Keep the file and reopen your notes.');
  }
  if (!response.ok) throw new Error('Could not recover a private copy. Keep the file, connect and try again.');
  return pageSummarySchema.parse(await response.json());
}
