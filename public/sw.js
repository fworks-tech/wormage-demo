'use strict';

// The registration URL carries a build id, so each deploy gets a fresh cache.
const BUILD = new URL(self.location.href).searchParams.get('build') || 'dev';
const CACHE = `wormage-shell-${BUILD}`;
const ASSETS = []; // replaced at build time with the hashed asset paths
const SHELL = [
  '/',
  '/demo',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  ...ASSETS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('wormage-shell-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API and mock traffic must always reach the network; neither belongs in the shell cache.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/mockServiceWorker.js' || url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('/index.html', response.clone());
          }
          return response;
        } catch {
          const cached = (await caches.match('/index.html')) ?? (await caches.match('/demo'));
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
