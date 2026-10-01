/* This worker is registered only by the local development application. */
const CACHE = 'kikit-dev-shell-v1';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
function eligible(url) {
  const parsed = new URL(url, self.location.origin);
  return parsed.origin === self.location.origin && !parsed.pathname.startsWith('/api/');
}
self.addEventListener('message', event => {
  if (event.data?.type !== 'warm-shell') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(event.data.urls.filter(eligible).map(async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Shell cache unavailable');
      await cache.put(url, response);
    }));
    event.ports[0]?.postMessage({ ready: true });
  })().catch(() => event.ports[0]?.postMessage({ ready: false })));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !eligible(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      // Vite varies module responses on Origin. Warm-up fetches and module loads
      // use different fetch modes; these public same-origin assets are identical.
      const cached = await cache.match(event.request, { ignoreVary: true });
      if (cached) return cached;
      throw error;
    }
  })());
});
