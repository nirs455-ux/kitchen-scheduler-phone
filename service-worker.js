const CACHE_NAME = "kitchen-scheduler-v10";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./js/store.js",
    "./js/holidays.js",
    "./js/solver.js",
    "./js/api.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    // קודם רשת (כדי שעדכונים יגיעו מיד), ואם אין אינטרנט - מהמטמון. גם הגופנים של Google נשמרים.
    event.respondWith(
        fetch(event.request, url.origin === location.origin ? { cache: "no-cache" } : undefined).then((response) => {
            if (response.ok || response.type === "opaque") {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
        }).catch(() => caches.match(event.request))
    );
});
