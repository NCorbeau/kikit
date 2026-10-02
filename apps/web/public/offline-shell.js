/* Only public app assets are cached. Authentication and notes are never cached here. */
const SHELL_CACHE_NAME = 'kikit-shell-v2';

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function isShellResource(url) {
  const parsed = new URL(url, self.location.origin);
  return parsed.origin === self.location.origin && !parsed.pathname.startsWith('/api/');
}

async function warmShell(urls) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  await Promise.all(urls.filter(isShellResource).map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Shell cache unavailable');
    await cache.put(url, response);
  }));
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'warm-shell') return;
  event.waitUntil(warmShell(event.data.urls)
    .then(() => event.ports[0]?.postMessage({ ready: true }))
    .catch(() => event.ports[0]?.postMessage({ ready: false })));
});

async function fetchShellResource(request) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    // Vite varies on Origin; warm-up fetches and module loads use different fetch
    // modes, but these public same-origin assets are identical.
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !isShellResource(event.request.url)) return;
  event.respondWith(fetchShellResource(event.request));
});
