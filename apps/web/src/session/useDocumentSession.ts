import { useEffect, useState, useSyncExternalStore } from 'react';
import { createDocumentSession, type SessionDependencies } from './index';

export function useDocumentSession(identity?: SessionDependencies['identity']) {
  const [session] = useState(() => createDocumentSession({ identity }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    void session.start();
    return () => session.destroy();
  }, [session]);

  return { session, snapshot };
}
