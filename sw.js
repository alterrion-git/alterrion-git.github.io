// Service Worker with Cache Versioning
const CACHE_VERSION = 'v3.13.0'; // UPDATE THIS WITH EACH NEW VERSION!
const CACHE_NAME = `workout-tracker-${CACHE_VERSION}`;

const urlsToCache = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  console.log('Service Worker installing with version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting()) // Force activation immediately
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating version:', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Delete old caches that don't match current version
          if (cacheName.startsWith('workout-tracker-') && cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // Take control of all pages immediately
  );
});

// Fetch strategy:
//  - Network-only (never cache): Firebase, Google APIs, the AI worker.
//  - Network-FIRST for the page/HTML (navigations): so an installed PWA always
//    picks up the latest index.html when online, and only falls back to cache
//    offline. This is what stops the "phone stuck on old version" problem.
//  - Cache-first for other static assets (React/Tailwind/Firebase SDK/icons).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  if (url.includes('firebaseio.com') || url.includes('googleapis.com') || url.includes('firebasedatabase.app') || url.includes('config.js') || url.includes('.workers.dev')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  const accept = req.headers.get('accept') || '';
  const isPage = req.mode === 'navigate' || (req.method === 'GET' && accept.includes('text/html'));

  if (isPage) {
    // Network-first for the app shell.
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return response;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html') || caches.match('./')))
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(req).then((response) => {
      if (response) return response;
      return fetch(req).then((res) => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      });
    })
  );
});
