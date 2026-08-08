/* =========================================================
   SERVICE WORKER — само за offline достъп до "черупката" на дашборда
   (HTML/JS/CSS/шрифтове), НЕ за AI/YouTube/GitHub API отговори.

   Стратегия:
   - Собствени статични файлове (index.html, app.js, manifest.json,
     scripts/clock-and-keys.js) → "stale-while-revalidate": веднага
     връща кеширана версия (бързо зареждане/работи offline), но в
     фонов режим тегли нова и я презаписва за следващия път.
   - ВСИЧКО останало (api.anthropic.com, generativelanguage.googleapis.com,
     www.googleapis.com, api.github.com, raw.githubusercontent.com, и т.н.)
     НИКОГА не се кешира — минава направо през мрежата, за да не видиш
     остарели/грешни AI отговори или overview на статистиката offline.

   Версия на кеша: качи CACHE_VERSION при промяна на списъка файлове,
   за да се изчисти старият кеш на потребителите автоматично.
   ========================================================= */
const CACHE_VERSION = "cdb-shell-v23";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./js/auth-gate.js",
  "./js/ui/toast.js",
  "./js/system-test.js",
  "./js/ui/guard-click.js",
  "./js/network.js",
  "./js/agent-roster.js",
  "./js/providers/fallback-loop.js",
  "./js/providers/claude.js",
  "./js/providers/gemini.js",
  "./js/providers/openrouter.js",
  "./js/providers/model-finder.js",
  "./js/youtube.js",
  "./js/niche-toolkit.js",
  "./js/release-roadmap.js",
  "./manifest.json",
  "./scripts/clock-and-keys.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Явен "черен списък" — домейни, чиито отговори НИКОГА не пипаме/кешираме.
// (AI API-та, Google APIs, GitHub API, YouTube — всичко, което трябва да е
// винаги "на живо", не остаряло copy от кеша).
function isApiRequest(url) {
  return /(^https:\/\/api\.anthropic\.com)|(^https:\/\/generativelanguage\.googleapis\.com)|(^https:\/\/www\.googleapis\.com)|(^https:\/\/api\.github\.com)|(^https:\/\/raw\.githubusercontent\.com)|(^https:\/\/accounts\.google\.com)|(^https:\/\/oauth2\.googleapis\.com)/.test(url);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // не пипаме POST към AI/GitHub и т.н.
  const url = req.url;

  if (isApiRequest(url)) return; // мрежа директно, без Service Worker намеса

  // Само собствения ни произход (GitHub Pages/локален сървър) минава през
  // "stale-while-revalidate" — external CDN шрифтове/Chart.js оставяме на
  // browser HTTP кеша по подразбиране, за да не сложняваме излишно.
  if (new URL(url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached); // offline → каквото имаме кеширано (или нищо)
      return cached || networkFetch;
    })
  );
});
