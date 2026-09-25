// Service Worker: アプリ本体をキャッシュしてオフラインでも起動できるようにする
// アプリを更新したら VERSION を上げること（新バージョン検出→「更新があります」表示）
const VERSION = 'v1.0.0';
const CACHE = `novelmemo-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/util.js',
  './js/db.js',
  './js/store.js',
  './js/merge.js',
  './js/tags.js',
  './js/search.js',
  './js/markdown.js',
  './js/drive.js',
  './js/sync.js',
  './js/ui/ctx.js',
  './js/ui/dom.js',
  './js/ui/tree.js',
  './js/ui/editor.js',
  './js/ui/templates.js',
  './js/ui/searchpanel.js',
  './js/ui/io.js',
  './js/ui/panels.js',
  './js/ui/viewer.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
  // skipWaiting はしない（編集中に勝手に切り替えない）。ページ側の「再読み込み」で切り替える
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('novelmemo-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google API などは素通し
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await cache.match('./index.html');
      try { return await fetch(req); } catch { if (index) return index; throw new Error('offline'); }
    }
    return fetch(req);
  })());
});
