/* =========================================================
   PROVIDER: OPENROUTER — трети AI "агент", специално заради РЕАЛНО
   безплатния tier (OpenRouter предлага няколко модела с ":free" суфикс,
   0 цена). За разлика от Claude/Gemini, OpenRouter е изрично проектиран
   да се вика директно от браузър/клиентски приложения — няма нужда от
   Proxy URL (но пак минаваме през proxied(), в случай че някой ден се
   наложи — same as другите провайдъри, консистентно).

   Зависи от: js/network.js (fetchTimeout, proxied) — зареден преди този
   файл в index.html. Зависи и от Storage/Keys/toast/AICallLog/
   QuotaTracker — дефинирани в app.js, но реално се ползват само ВЪТРЕ
   във функциите по-долу (виж бележката в js/providers/claude.js).

   Публичен интерфейс:
     - getOpenRouterFreeModels(forceRefresh)
     - callOpenRouter(prompt, maxTokens)
   ========================================================= */

const OPENROUTER_MODELS_CACHE_KEY = "cdb_openrouter_models_cache_v1";
const OPENROUTER_MODELS_CACHE_HOURS = 24;

// Статичен резервен списък — модели, за които OpenRouter исторически
// предлага безплатен (":free") вариант. Имената могат да се сменят с
// времето от тяхна страна, затова динамичното изтегляне по-долу е
// предпочитаният път; това е само "за всеки случай".
const OPENROUTER_FALLBACK_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "mistralai/mistral-7b-instruct:free"
];

// Изтегля РЕАЛНИЯ списък модели от OpenRouter (публичен endpoint, не
// изисква ключ) и филтрира само тези с нулева цена (истински free tier,
// не "евтин"). Кешира се за 24ч.
async function getOpenRouterFreeModels(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = Storage.get(OPENROUTER_MODELS_CACHE_KEY);
    if (cached && Array.isArray(cached.models) && cached.models.length &&
        (Date.now() - cached.ts) < OPENROUTER_MODELS_CACHE_HOURS * 3600 * 1000) {
      return cached.models;
    }
  }
  try {
    const r = await fetchTimeout("https://openrouter.ai/api/v1/models", {}, 15000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const free = (data.data || [])
      .filter(m => parseFloat(m.pricing?.prompt || "1") === 0 && parseFloat(m.pricing?.completion || "1") === 0)
      .map(m => m.id);
    if (!free.length) throw new Error("Няма изброени безплатни модели точно сега");
    Storage.set(OPENROUTER_MODELS_CACHE_KEY, { ts: Date.now(), models: free });
    return free;
  } catch (e) {
    console.warn("Неуспешно изтегляне на OpenRouter безплатните модели, ползвам резервен списък:", e.message);
    return OPENROUTER_FALLBACK_MODELS;
  }
}

// Единично извикване + fallback между безплатните модели (ако единият е
// временно претоварен/недостъпен — при безплатните модели това се случва
// по-често, тъй като споделят обща опашка между всички потребители).
async function callOpenRouter(prompt, maxTokens = 900) {
  const k = Keys.load();
  if (!k.openrouterKey) { toast("⚠️ Липсва OpenRouter API ключ (виж Настройки)"); throw new Error("no key"); }
  const models = await getOpenRouterFreeModels();

  let lastError;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    try {
      const res = await fetchTimeout(proxied("https://openrouter.ai/api/v1/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${k.openrouterKey}`,
          // Препоръчани от OpenRouter (не задължителни) — за статистика в техния dashboard.
          "HTTP-Referer": window.location.origin,
          "X-Title": "AI Music Suite - CD-B Records Dashboard"
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
      }, 60000);

      if (!res.ok) {
        const t = await res.text();
        const err = new Error("OpenRouter API грешка: " + t);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenRouter не върна съдържание в отговора");

      AICallLog.record({ provider: "openrouter", model, ok: true });
      QuotaTracker.record("openrouter", model);
      return text.trim();
    } catch (e) {
      lastError = e;
      AICallLog.record({ provider: "openrouter", model, ok: false, note: (e.message || "").slice(0, 140) });
      // 429/503 = претоварен безплатен модел точно сега — пробвай следващия.
      if ((e.status === 429 || e.status === 503) && m < models.length - 1) {
        toast(`⚠️ OpenRouter "${model}" претоварен — превключвам на "${models[m + 1]}"...`, 4000);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("OpenRouter API грешка: неуспешно след всички безплатни модели");
}
