import { useEffect, useState, useSyncExternalStore } from 'react';
import { createDocumentSession } from './index';

export function useDocumentSession() {
  const [session] = useState(createDocumentSession);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    void session.start();
    return () => session.destroy();
  }, [session]);

  return { session, snapshot };
}
