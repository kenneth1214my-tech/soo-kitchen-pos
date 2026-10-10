// Service worker: lets the POS reopen with no internet, while never hiding a newer deployed version.
//
// Strategy is NETWORK-FIRST, deliberately — an earlier version of this project hit the "can't see
// updates" bug twice from caching, so a cache-first design is off the table. Every request tries the
// network first (bypassing the browser's HTTP cache with cache:"no-cache", since GitHub Pages sends
// max-age=600 and would otherwise serve a 10-minute-old index.html even when online). The cache is
// only used when the network fails or is slower than NETWORK_TIMEOUT_MS (e.g. a captive/"connected
// but no internet" wifi), and every successful network response refreshes the cache.
//
// Only same-origin GETs and the Firebase SDK scripts are handled. Firestore's own API traffic
// (firestore.googleapis.com) is left completely alone — it has its own offline queue.

const CACHE_NAME = "sk-pos-shell";
const NETWORK_TIMEOUT_MS = 4000;
const FIREBASE_SCRIPT_PREFIX = "https://www.gstatic.com/firebasejs/";

function isHandled(request){
  if(request.method !== "GET") return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin || request.url.startsWith(FIREBASE_SCRIPT_PREFIX);
}

async function putInCache(request, response){
  // Opaque (cross-origin no-cors) script responses have ok=false but are still valid to replay.
  if(!(response.ok || response.type === "opaque")) return;
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  if(url.origin === self.location.origin && url.search){
    // Versioned asset (?v=...): drop older versions of the same file so the cache doesn't grow
    // by one stale copy of app.js/style.css on every deploy.
    const keys = await cache.keys();
    await Promise.all(keys.filter(k=>{
      const ku = new URL(k.url);
      return ku.origin === url.origin && ku.pathname === url.pathname && ku.search !== url.search;
    }).map(k=>cache.delete(k)));
  }
  await cache.put(request, response);
}

async function cacheLookup(request){
  const cache = await caches.open(CACHE_NAME);
  let hit = await cache.match(request);
  if(hit) return hit;
  // Offline navigation to "/" or a different spelling of the app URL: fall back to the cached shell.
  if(request.mode === "navigate"){
    const keys = await cache.keys();
    const pageKey = keys.find(k=>new URL(k.url).pathname.endsWith("/index.html")) ||
                    keys.find(k=>new URL(k.url).pathname.endsWith("/"));
    if(pageKey) return cache.match(pageKey);
  }
  return null;
}

async function networkFirst(request){
  // The cache is a bonus, never a dependency: if it can't even be opened (storage full, restricted
  // WebView, private mode) we must behave exactly like a plain pass-through instead of failing the load.
  let cached = null;
  try{ cached = await cacheLookup(request); }catch(e){ cached = null; }
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  // no-cache = always revalidate with the server instead of trusting the HTTP cache's max-age.
  const fresh = fetch(request, sameOrigin ? { cache:"no-cache" } : undefined).then(res=>{
    putInCache(request, res.clone()).catch(()=>{});
    return res;
  });
  if(!cached) return fresh;           // nothing to fall back on — just wait for the network
  fresh.catch(()=>{});                // avoid an unhandled rejection if the timeout wins the race
  try{
    return await Promise.race([
      fresh,
      new Promise((_, reject)=> setTimeout(reject, NETWORK_TIMEOUT_MS))
    ]);
  }catch(e){
    return cached;
  }
}

// On install, fetch the app shell and everything index.html references, so the very first visit
// is already offline-ready (the page's own initial requests happen before this worker controls it,
// so runtime caching alone would leave the cache empty until the second load).
self.addEventListener("install", (event)=>{
  event.waitUntil((async ()=>{
    try{
      const pageUrl = new URL("index.html", self.registration.scope).href;
      const pageRes = await fetch(pageUrl, { cache:"no-cache" });
      const html = await pageRes.clone().text();
      await putInCache(new Request(pageUrl), pageRes);
      const refs = new Set();
      const re = /(?:href|src)="([^"#]+)"/g;
      let m;
      while((m = re.exec(html))){
        let abs;
        try{ abs = new URL(m[1], pageUrl); }catch(e){ continue; }
        if(abs.origin === self.location.origin || abs.href.startsWith(FIREBASE_SCRIPT_PREFIX)) refs.add(abs.href);
      }
      await Promise.all([...refs].map(async href=>{
        try{
          const req = new Request(href);
          const res = await fetch(req, href.startsWith(self.location.origin) ? { cache:"no-cache" } : undefined);
          await putInCache(req, res);
        }catch(e){ /* a single asset failing must not block install */ }
      }));
    }catch(e){ /* offline at install time — runtime caching will fill in later */ }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event)=>{
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event)=>{
  if(!isHandled(event.request)) return;
  event.respondWith(networkFirst(event.request).catch(()=> fetch(event.request)));
});
