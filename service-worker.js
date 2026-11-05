const CACHE_PREFIX =
  "stataverse:" + new URL(self.registration.scope).pathname + ":";
const CACHE_NAME = CACHE_PREFIX + "v9";
const CORE_ASSETS = [
  "index.html",
  "Learn/",
  "assets/css/learn.css",
  "assets/css/home.css",
  "assets/css/site.css",
  "assets/js/learn.js",
  "assets/js/home.js",
  "assets/js/site.js",
  "assets/data/site-index.json",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)),
  );
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !url.href.startsWith(self.registration.scope)
  )
    return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)),
          );
        }
        return response;
      })
      .catch(async () => {
        const cached = await (await caches.open(CACHE_NAME)).match(request);
        return (
          cached ||
          new Response(
            "This page is not available offline. Reconnect and reload.",
            {
              status: 503,
              headers: { "Content-Type": "text/plain;charset=utf-8" },
            },
          )
        );
      }),
  );
});
