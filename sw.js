/* QUANT Terminal service worker (v5.1)
 * 只缓存 App 外壳,让它能装到桌面、断网时也能打开界面。
 * 行情(CoinGecko)和云端快照(data/)永远走网络,绝不缓存 —— 过期行情比没有行情更危险。 */
const CACHE = 'quant-shell-v5.1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;   // 跨域(行情API)不拦
  if (url.pathname.includes('/data/')) return;                                      // 云端快照不缓存
  // 外壳:网络优先(保证新版本能及时生效),断网时回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
