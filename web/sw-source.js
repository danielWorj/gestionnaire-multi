/* Service Worker — ouverture de l'application sans connexion.
 *
 * Généré au build par le plugin « serviceWorker » de vite.config.js, qui
 * injecte la version et la liste des fichiers à garder (index.html + tout
 * le bundle Vite). Les appels /api ne passent PAS par ici : les données hors
 * connexion sont gérées par l'application (src/lib/stockageLocal.js), qui
 * sait à quel utilisateur elles appartiennent.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE_APP = `app-${VERSION}`;
const CACHE_POLICES = 'polices-v1';
const DELAI_NAVIGATION_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_APP).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(noms.filter((n) => n.startsWith('app-') && n !== CACHE_APP).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// Page (toutes les routes de la SPA) : réseau d'abord pour recevoir les
// mises à jour, sinon — ou si le réseau traîne — l'index.html en cache.
async function navigation(request) {
  const cache = await caches.open(CACHE_APP);
  const reseau = fetch(request).then((reponse) => {
    if (reponse.ok) cache.put('/index.html', reponse.clone());
    return reponse;
  });
  const enCache = await cache.match('/index.html');
  if (!enCache) return reseau;
  const delai = new Promise((resolve) => { setTimeout(() => resolve(enCache), DELAI_NAVIGATION_MS); });
  return Promise.race([reseau.catch(() => enCache), delai]);
}

// Fichiers hashés de Vite (immuables) et icônes : cache d'abord.
async function ressource(request) {
  const enCache = await caches.match(request);
  if (enCache) return enCache;
  const reponse = await fetch(request);
  if (reponse.ok) (await caches.open(CACHE_APP)).put(request, reponse.clone());
  return reponse;
}

// Google Fonts : copie locale servie tout de suite, rafraîchie en fond.
async function police(request) {
  const cache = await caches.open(CACHE_POLICES);
  const enCache = await cache.match(request);
  const reseau = fetch(request).then((reponse) => {
    if (reponse.ok || reponse.type === 'opaque') cache.put(request, reponse.clone());
    return reponse;
  }).catch(() => enCache);
  return enCache || reseau;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
    if (request.mode === 'navigate') {
      event.respondWith(navigation(request));
      return;
    }
    event.respondWith(ressource(request));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(police(request));
  }
});
