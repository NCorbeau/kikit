import { invitationSchema, pageSummarySchema, sharingStateSchema } from '@kikit/contracts';

export class SharingError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function sharingErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return 'Sign in again to continue.';
    case 403:
      return 'You no longer have permission to do this.';
    case 410:
      return 'This invitation is invalid or has been disabled.';
    default:
      return 'Could not complete this request. Try again.';
  }
}

async function sharingRequest(url: string, accountId: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('X-Kikit-Account', accountId);
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options, headers });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      window.dispatchEvent(new Event('kikit-session-ended'));
    }
    throw new SharingError(response.status, sharingErrorMessage(response.status));
  }

  if (response.headers.get('X-Kikit-Account') !== accountId) {
    window.dispatchEvent(new Event('kikit-session-ended'));
    throw new SharingError(401, 'Your account changed. Reopen your notes.');
  }
  return response;
}

export async function loadSharing(pageId: string, accountId: string, signal?: AbortSignal) {
  const response = await sharingRequest(`/api/pages/${pageId}/sharing`, accountId, { signal });
  const body = await response.json();
  return sharingStateSchema.parse(body);
}

export async function createInvitation(pageId: string, accountId: string) {
  const response = await sharingRequest(`/api/pages/${pageId}/invitation`, accountId, { method: 'POST' });
  const body = await response.json();
  return invitationSchema.parse(body);
}

export async function disableInvitation(pageId: string, accountId: string): Promise<void> {
  await sharingRequest(`/api/pages/${pageId}/invitation`, accountId, { method: 'DELETE' });
}

export async function removeMember(pageId: string, accountId: string, memberId: string): Promise<void> {
  await sharingRequest(`/api/pages/${pageId}/members/${encodeURIComponent(memberId)}`, accountId, { method: 'DELETE' });
}

export async function joinInvitation(token: string, accountId: string) {
  const response = await sharingRequest('/api/invitations/join', accountId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await response.json();
  return pageSummarySchema.parse(body);
}
