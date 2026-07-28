const CACHE_NAME = 'bblog-v143';
const DB_NAME = 'bblog-v1';
const DB_STORE = 'kv';
const MEDICATION_BACKGROUND_PUSH_KEY = 'bblog-background-medication-push-at';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=20260728-221831',
  '/vendor/chart.umd.min.js?v=4.5.1',
  '/app.js?v=20260728-221831',
  '/manifest.webmanifest?v=20260728-221831',
  '/icon.svg?v=20260728-221831',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

function writeKv(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  event.waitUntil(
    Promise.all([
      writeKv(MEDICATION_BACKGROUND_PUSH_KEY, Date.now()).catch(() => {}),
      self.registration.showNotification(
        payload.title || 'Medication reminder',
        {
          body: payload.body || 'Open bblog to check due medications.',
          icon: '/icon.svg',
          tag: payload.tag || 'medication-due',
          renotify: true,
          data: { url: payload.url || '/' },
        },
      ),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        const current = windows.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        return current ? current.focus() : self.clients.openWindow('/');
      }),
  );
});
