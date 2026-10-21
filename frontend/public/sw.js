const CACHE_NAME = 'goldenxperience-v5';
const STATIC_ASSETS = [
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Offline during install is fine, cache what we can
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName.startsWith('goldenxperience-') && cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(async () => {
      // Let navigation start while the service worker is waking up.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    return;
  } else if (url.pathname.startsWith('/_next/static/')) {
    // Next content-hashes these URLs. Reuse them immediately on repeat launches;
    // a deployment changes the URL, so new code still comes from the network.
    event.respondWith(cacheFirst(request, event));
  } else if (
    url.pathname.match(/\.(js|css|woff2?|png|jpg|jpeg|svg|ico)$/i) ||
    url.pathname === '/' ||
    url.pathname.match(/^\/(signals|risk|journal|settings)$/)
  ) {
    event.respondWith(networkFirst(request, event));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'GoldenXperience', {
    body: data.body || 'You have a new notification.',
    tag: data.tag || 'goldenxperience-notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin) || !('focus' in client)) continue;
      await client.focus();
      if ('navigate' in client) await client.navigate(targetUrl);
      return;
    }
    await clients.openWindow(targetUrl);
  })());
});

async function cacheFirst(request, event) {
  const cached = await caches.open(CACHE_NAME).then((cache) => cache.match(request)).catch(() => undefined);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
  }
  return response;
}

async function networkFirst(request, event) {
  try {
    const response = (request.mode === 'navigate' && await event.preloadResponse) || await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
    }
    return response;
  } catch {
    const cachedResponse = await caches.open(CACHE_NAME).then((cache) => cache.match(request)).catch(() => undefined);
    if (cachedResponse) {
      return cachedResponse;
    }
    return new Response(
      JSON.stringify({ error: 'Network request failed and no cache available' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
