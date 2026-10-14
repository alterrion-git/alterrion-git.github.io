// Service Worker with Cache Versioning
const CACHE_VERSION = 'v3.18.0'; // UPDATE THIS WITH EACH NEW VERSION!
const CACHE_NAME = `workout-tracker-${CACHE_VERSION}`;

// Same-origin app shell: must all cache, or the install fails (and the old SW keeps serving).
const APP_SHELL = [
  './',
  './index.html',
  './js/nutrition.js?v=3.18.0', // same URL as the <script> in index.html
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './fonts/material-symbols.woff2',
  './fonts/barlow-condensed-latin-700.woff2',
  './fonts/barlow-condensed-latin-800.woff2',
  './fonts/barlow-condensed-latin-ext-700.woff2',
  './fonts/barlow-condensed-latin-ext-800.woff2',
  './fonts/barlow-latin-400.woff2',
  './fonts/barlow-latin-500.woff2',
  './fonts/barlow-latin-600.woff2',
  './fonts/barlow-latin-700.woff2',
  './fonts/barlow-latin-ext-400.woff2',
  './fonts/barlow-latin-ext-500.woff2',
  './fonts/barlow-latin-ext-600.woff2',
  './fonts/barlow-latin-ext-700.woff2'
];
// Third-party libraries: cached best-effort, so one slow/failed CDN can't break the install.
const CDN_LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js'
];

// How long a page load waits for the network before showing the cached copy. Without
// this, a weak signal (request neither succeeds nor fails) left the app on a blank screen.
const PAGE_NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' skips the browser's HTTP cache (GitHub Pages sends max-age=600), so a
      // new version never precaches a stale copy of its own files.
      .then((cache) => cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' }))).then(() =>
        Promise.all(CDN_LIBS.map((u) => cache.add(u).catch(() => {})))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames.map((cacheName) => {
        if (cacheName.startsWith('workout-tracker-') && cacheName !== CACHE_NAME) {
          return caches.delete(cacheName);
        }
      })
    )).then(() => self.clients.claim())
  );
});

// Cached app shell for a navigation. index.html first: it's the entry refreshed on every
// successful page load (the './' entry is only written at install).
async function cachedPage(req) {
  return (await caches.match('./index.html'))
    || (await caches.match(req, { ignoreSearch: true }))
    || (await caches.match('./'));
}

// Fetch strategy:
//  - Network-only (never cache): Firebase, Google APIs, the AI worker.
//  - Pages: network-first so an installed PWA picks up the latest index.html, but give up
//    after PAGE_NETWORK_TIMEOUT_MS and show the cached copy (the fresh copy still lands in
//    the cache for next launch).
//  - Everything else (libraries, fonts, icons): cache-first.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;
  if (req.method !== 'GET') return;

  if (url.includes('firebaseio.com') || url.includes('googleapis.com') || url.includes('firebasedatabase.app') || url.includes('config.js') || url.includes('.workers.dev')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  const accept = req.headers.get('accept') || '';
  const isPage = req.mode === 'navigate' || accept.includes('text/html');

  if (isPage) {
    const network = fetch(req).then((response) => {
      if (response && response.status === 200) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
      }
      return response;
    });
    event.waitUntil(network.catch(() => {}));
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const useCache = async () => {
        if (done) return;
        const cached = await cachedPage(req);
        if (cached && !done) { done = true; resolve(cached); }
      };
      const timer = setTimeout(useCache, PAGE_NETWORK_TIMEOUT_MS);
      network.then((response) => {
        clearTimeout(timer);
        if (!done) { done = true; resolve(response); }
      }).catch(async () => {
        clearTimeout(timer);
        await useCache();
        if (!done) { done = true; resolve(Response.error()); }
      });
    }));
    return;
  }

  event.respondWith(
    caches.match(req).then((response) => {
      if (response) return response;
      return fetch(req).then((res) => {
        // Cache successful same-origin/CORS responses and opaque CDN script responses.
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
