const CACHE_PREFIX =
  "stataverse:" + new URL(self.registration.scope).pathname + ":";
const LEGACY_SCOPE =
  new URL(self.registration.scope).pathname === "/STATAverse/";
const CACHE_NAME = CACHE_PREFIX + "v22";
const CORE_ASSETS = [
  "index.html",
  "Learn/",
  "Labs/",
  "Labs/Inference/",
  "Labs/Data/",
  "Labs/IV/",
  "assets/css/iv.css",
  "assets/js/iv-lab.js",
  "assets/css/data-lab.css",
  "assets/js/data-lab.js",
  "assets/css/inference.css",
  "assets/js/inference-lab.js",
  "assets/js/inference-worker.js",
  "assets/css/labs.css",
  "assets/js/regression-lab.js",
  "assets/css/learn.css",
  "assets/css/home.css",
  "assets/css/site.css",
  "assets/js/learn.js",
  "assets/js/home.js",
  "assets/js/site.js",
  "assets/js/legacy-location.js",
  "assets/data/site-index.json",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    LEGACY_SCOPE
      ? Promise.resolve()
      : caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)),
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
            .filter(
              (key) =>
                (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) ||
                (LEGACY_SCOPE && /^stataverse-v\d+$/.test(key)),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
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
  if (LEGACY_SCOPE && request.mode === "navigate") {
    // The old worker served cache-first pages. Replace it without clearing
    // another app's caches or touching the browser's saved student work.
    const destination = new URL(
      "/learn/stata/" + url.pathname.slice("/STATAverse/".length),
      url.origin,
    );
    destination.search = url.search;
    event.respondWith(
      Promise.resolve(Response.redirect(destination.href, 302)),
    );
    return;
  }
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
