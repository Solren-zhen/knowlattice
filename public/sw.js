/**
 * 晶格 KnowLattice Service Worker：让应用可安装、离线可用（GitHub Pages 等纯静态托管）。
 * 策略：
 * - 页面导航：网络优先，失败（离线）回退缓存；
 * - 同源静态资源：缓存优先（Vite 产物带内容 hash，文件名不变内容就不变）。
 * 数据都在 IndexedDB / localStorage，不经过 SW。
 * 注意：每次发布新版本请递增 VERSION——激活时会清掉旧版本缓存，否则浏览器会一直读到旧版。
 */
const VERSION = 'medvault-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 页面导航：网络优先，离线回退缓存
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) ??
          (await cache.match('./')) ??
          (await cache.match('./index.html')) ??
          Response.error();
      }
    })());
    return;
  }

  // 静态资源：缓存优先
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return Response.error();
    }
  })());
});
