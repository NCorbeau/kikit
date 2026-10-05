import { useState } from 'react';

const STORAGE_KEY = 'kikit-sync-details';

export function useSyncDetails() {
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; }
    catch { return false; }
  });

  function changeVisible(next: boolean) {
    setVisible(next);
    // Diagnostics are a noncritical preference, separate from the note journal.
    try { localStorage.setItem(STORAGE_KEY, String(next)); }
    catch { /* Keep the preference for this mounted document. */ }
  }

  return { visible, changeVisible };
}
