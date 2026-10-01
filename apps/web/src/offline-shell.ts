/** Development-only shell cache. Document content belongs exclusively in IndexedDB. */
export async function registerOfflineShell(): Promise<void> {
  if (!import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/offline-shell.js');
    await navigator.serviceWorker.ready;
    // Initial module requests happened before the worker controlled this page.
    // Warm those exact Vite module URLs so a cached note can reopen offline.
    const resources = performance.getEntriesByType('resource')
      .map(entry => entry.name)
      .filter(url => {
        const parsed = new URL(url);
        return parsed.origin === location.origin && !parsed.pathname.startsWith('/api/');
      });
    const worker = registration.active;
    if (!worker) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      document.documentElement.dataset.offlineReady = String(event.data.ready === true);
      channel.port1.close();
    };
    worker.postMessage({ type: 'warm-shell', urls: ['/', ...resources] }, [channel.port2]);
  } catch {
    // Local note persistence still works; offline navigation requires a cached shell.
    document.documentElement.dataset.offlineReady = 'false';
  }
}
