const CACHE = 'chromebook-dashboard-static-30298c6304b3';
const PREFIX = 'chromebook-dashboard-static-';
const ASSETS = [
  './', './index.html', './browser.html', './service-worker.js',
  './src/styles.css', './src/browser-create.css', './src/browser-create.mjs',
  './src/import-reconcile.mjs', './src/import-client.mjs', './src/import-worker.js',
  './src/source-import.mjs', './src/friendly-products.mjs', './src/person-names.mjs',
  './src/dashboard-core.mjs', './src/room-map.mjs', './src/roster-core.mjs',
  './src/working-store.mjs', './src/working-edits.mjs', './src/room-names.mjs',
  './src/working-workbook.mjs', './src/workbook-codec.mjs',
  './src/vendor/fflate-0.8.2.mjs', './src/vendor/xlsx-mini-0.20.3.js',
  './src/vendor/fflate-LICENSE.txt', './src/vendor/SheetJS-LICENSE.txt', './src/vendor/README.md',
  './src/willard-map.svg', './src/ADL_floor_1.svg', './src/ADL_floor_2.svg', './src/ADL_floor_3.svg',
];
const URLS = ASSETS.map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS)));
});
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !URLS.includes(request.url)) return;
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(cached => cached || fetch(request)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_OFFLINE') {
    event.waitUntil(Promise.all(URLS.map(url => caches.match(url))).then(results => {
      event.source?.postMessage({ type: 'OFFLINE_STATUS', ready: results.every(Boolean), count: results.filter(Boolean).length, expected: URLS.length });
    }));
  }
  if (event.data?.type === 'CLEAN_OLD_CACHES' && event.data.safeToUpdate === true) {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)))));
  }
});
