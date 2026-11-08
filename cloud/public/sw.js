const SHELL = new Set(["", "index.html", "app.css", "app.js", "format.js", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("tonic-blue-shell-v1").then((cache) => cache.addAll(["./", "./app.css", "./app.js", "./format.js", "./manifest.json", "./icon.svg"])));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;
  if (url.pathname.includes("/api/")) return;
  if (url.search) return;
  const file = url.pathname.split("/").pop() ?? "";
  if (!SHELL.has(file) && file !== "") return;
  event.respondWith(shell(event.request));
});

async function shell(request) {
  const cache = await caches.open("tonic-blue-shell-v1");
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
