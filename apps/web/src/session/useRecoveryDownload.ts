import { useState } from 'react';
import type { DocumentSession } from './index';

export function useRecoveryDownload(session: DocumentSession) {
  const [error, setError] = useState<string | null>(null);

  function download() {
    try {
      downloadRecovery(session.exportRecovery());
      setError(null);
    } catch {
      setError('The recovery file could not be created. Keep this tab open and try again.');
    }
  }

  return { download, error };
}

function downloadRecovery(data: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `kikit-recovery-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
