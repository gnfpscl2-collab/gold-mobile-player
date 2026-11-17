const CACHE = 'gold-player-v1.2.1-assets';
const SHELL = ['./', './index.html', './style.css?v=1.2.1', './app.js?v=1.2.1', './drive-config.js', './files.js', './storage.js', './audio.js',
  './vendor/GameBoyCore.js', './manifest.webmanifest', './Silkscreen-Bold.ttf', './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('gold-player-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && SHELL.some(file => new URL(file, self.registration.scope).href === event.request.url)) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(response => response || (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
