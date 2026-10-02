import { useCallback, useEffect, useRef, useState } from 'react';
import { readBrowserRoute, rememberInvitation, routeHref, type AppRoute } from './routes';

/** Browser navigation is held until the mounted document settles or exports its draft. */
export function useAppRoute() {
  const [route, setRoute] = useState(readBrowserRoute);
  const current = useRef(route);
  const guarded = useRef(false);
  const [requested, setRequested] = useState<AppRoute | null>(null);
  const commit = useCallback((next: AppRoute) => {
    current.current = next;
    rememberInvitation(next);
    history.replaceState(null, '', routeHref(next));
    setRequested(null);
    setRoute(next);
  }, []);
  const request = useCallback((next: AppRoute) => {
    if (routeHref(next) === routeHref(current.current)) return;
    if (guarded.current) {
      history.replaceState(null, '', routeHref(current.current));
      setRequested(next);
    } else commit(next);
  }, [commit]);
  const guard = useCallback((active: boolean) => { guarded.current = active; }, []);
  const cancel = useCallback(() => { setRequested(null); }, []);
  useEffect(() => {
    rememberInvitation(route);
  }, [route]);
  useEffect(() => {
    const changed = () => request(readBrowserRoute());
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
    };
  }, [request]);
  return { route, requested, commit, request, guard, cancel };
}
