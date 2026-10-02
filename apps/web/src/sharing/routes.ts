import { invitationTokenSchema } from '@kikit/contracts';

export type AppRoute = { kind: 'notes' } | { kind: 'page'; pageId: string } | { kind: 'join'; token: string } | { kind: 'resume-join' } | { kind: 'invalid-invitation' };
const PENDING_INVITATION_KEY = 'kikit-pending-invitation-v1';

export function readAppRoute(hash: string): AppRoute {
  const page = hash.match(/^#\/page\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if (page) return { kind: 'page', pageId: page[1]!.toLowerCase() };
  if (hash === '#/join') return { kind: 'resume-join' };
  if (hash.startsWith('#/join')) {
    const token = hash.slice('#/join/'.length);
    return hash.startsWith('#/join/') && invitationTokenSchema.safeParse(token).success
      ? { kind: 'join', token } : { kind: 'invalid-invitation' };
  }
  return { kind: 'notes' };
}

export function routeHref(route: AppRoute): string {
  if (route.kind === 'page') return `/#/page/${route.pageId}`;
  if (route.kind === 'join') return `/#/join/${route.token}`;
  if (route.kind === 'resume-join') return '/#/join';
  if (route.kind === 'invalid-invitation') return '/#/join/invalid';
  return '/';
}

/** The invitation secret never enters the auth callback query or sign-in email. */
export function signInContinuation(route: AppRoute): '/' | '/#/join' {
  return (route.kind === 'join' && invitationTokenSchema.safeParse(route.token).success) || route.kind === 'resume-join' ? '/#/join' : '/';
}

export function rememberInvitation(route: AppRoute): void {
  try {
    if (route.kind === 'join') sessionStorage.setItem(PENDING_INVITATION_KEY, invitationTokenSchema.parse(route.token));
    else if (route.kind !== 'resume-join') sessionStorage.removeItem(PENDING_INVITATION_KEY);
  } catch { /* Returning to the original invitation remains available without browser storage. */ }
}

export function readBrowserRoute(): AppRoute {
  const route = readAppRoute(location.hash);
  if (route.kind !== 'resume-join') return route;
  try {
    const token = invitationTokenSchema.safeParse(sessionStorage.getItem(PENDING_INVITATION_KEY));
    if (token.success) return { kind: 'join', token: token.data };
  } catch { /* A different tab or unavailable storage requires reopening the invitation. */ }
  return route;
}

export function invitationUrl(token: string): string {
  return new URL(routeHref({ kind: 'join', token: invitationTokenSchema.parse(token) }), location.origin).href;
}
