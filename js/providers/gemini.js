/* =========================================================
   PROVIDER: GEMINI — извадено от app.js (архитектурен рефакторинг,
   точка 3: providers/). Съдържа всичко, специфично за Google Gemini API:
   динамичен списък с модели (с кеш + резервен статичен списък),
   fallback между модели с retry/backoff при 429, обикновен текстов
   извикване и multimodal (текст + аудио).

   Зависи от: js/network.js (fetchTimeout, proxied) — зареден преди
   този файл в index.html. Зависи и от Storage/ModelPref/Keys/toast/
   AICallLog/QuotaTracker — дефинирани в app.js (виж бележката в
   js/providers/claude.js — редът в HTML не чупи нищо).

   Публичен интерфейс, ползван от останалата част на приложението:
     - getGeminiModelList(apiKey, forceRefresh)
     - callGemini(prompt, useSearch)
     - callGeminiMultimodal(prompt, base64Audio, mimeType, useSearch)
   ========================================================= */

/* ---------- ДИНАМИЧЕН СПИСЪК С GEMINI МОДЕЛИ ----------
   Вместо да разчитаме на твърдо закодирани имена на модели (Google ги
   преименува/премахва от време на време и това чупи приложението), питаме
   директно Gemini API ("/v1beta/models") какви модели РЕАЛНО са достъпни
   за твоя конкретен ключ, и подреждаме безплатните текстови модели по
   приоритет (lite → flash → останалите; изключваме pro/embedding/image/
   tts модели). Резултатът се кешира в localStorage за GEMINI_MODELS_CACHE_HOURS
   часа, за да не удряме /models endpoint-а при всяка генерация.
   Ако заявката гръмне (няма интернет, невалиден ключ...), падаме обратно
   на GEMINI_FALLBACK_MODELS — статичен списък "за всеки случай". */
const GEMINI_MODELS_CACHE_KEY = "cdb_gemini_models_cache_v1";
const GEMINI_MODELS_CACHE_HOURS = 12;

// Статичен резервен списък — ползва се САМО ако не успеем да изтеглим
// реалния списък с модели от Google. Не е гарантирано да е винаги валиден
// (затова динамичното изтегляне по-долу е предпочитаният път).
const GEMINI_FALLBACK_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash"
];
// Използва се само за бързите health-check тестове (Keys.testKeys / silentHealthCheck)
// като "разумно предположение", преди да е изтеглен реалният списък.
const GEMINI_MODEL = GEMINI_FALLBACK_MODELS[0];

// Подрежда суров списък с имена на модели по приоритет: lite модели първо
// (най-висока безплатна дневна квота), после обикновени flash модели,
// после останалото. Изключва pro (изисква billing), embedding/vision/
// image/tts/imagen/veo модели, които не стават за обикновени текстови
// извиквания на приложението.
function _sortGeminiModelNames(names) {
  const exclude = /pro|embedding|aqa|vision|image|tts|imagen|veo/i;
  const score = (n) => {
    if (/flash-lite/i.test(n)) return 0;
    if (/flash/i.test(n)) return 1;
    return 2;
  };
  return names
    .filter(n => !exclude.test(n))
    .sort((a, b) => score(a) - score(b));
}

// Връща подредения списък с достъпни Gemini модели за дадения ключ.
// Първо проверява кеша (localStorage), после реалния /models endpoint,
// и накрая — при грешка — статичния резервен списък.
async function getGeminiModelList(apiKey, forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const cached = Storage.get(GEMINI_MODELS_CACHE_KEY);
      if (cached && Array.isArray(cached.models) && cached.models.length &&
          (Date.now() - cached.ts) < GEMINI_MODELS_CACHE_HOURS * 3600 * 1000) {
        return ModelPref.applyTo("gemini", cached.models);
      }
    } catch (e) { /* счупен кеш — просто продължи към реалната заявка */ }
  }

  try {
    const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {}, 15000);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || ("HTTP " + r.status));
    const names = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace("models/", ""));
    const sorted = _sortGeminiModelNames(names);
    if (!sorted.length) throw new Error("Няма достъпни generateContent модели за този ключ");
    Storage.set(GEMINI_MODELS_CACHE_KEY, { ts: Date.now(), models: sorted });
    return ModelPref.applyTo("gemini", sorted);
  } catch (e) {
    console.warn("Неуспешно изтегляне на реалния списък Gemini модели, ползвам резервен списък:", e.message);
    return ModelPref.applyTo("gemini", GEMINI_FALLBACK_MODELS);
  }
}

/* ---------- ЕДИНИЧНО ИЗВИКВАНЕ ----------
   Един fetch към КОНКРЕТЕН Gemini модел. Хвърля Error с .status = HTTP кода
   при неуспешен отговор от сървъра; при мрежова/timeout грешка (fetchTimeout
   гърми директно, преди да имаме res) хвърля грешка БЕЗ .status — това е
   нарочно, _classifyGeminiError по-долу разчита на тази разлика. */
async function _callGeminiSingle(model, body, apiKey, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchTimeout(proxied(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);

  if (!res.ok) {
    const t = await res.text();
    const err = new Error("Gemini API грешка: " + t);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "(няма отговор)";
}

/* ---------- FALLBACK МЕЖДУ МОДЕЛИ + RETRY/BACKOFF ----------
   Решава какво да прави общия fallback цикъл (js/providers/fallback-loop.js)
   при грешка от _callGeminiSingle:
     - мрежова/timeout грешка (без .status) — retry тук няма да помогне,
       ТИХО (без лог/toast/премахване от ростъра — точно както преди)
       минаваме на следващия модел;
     - 429 — кратък retry с изчакване (само 1 път — на практика 429 на
       безплатните tier-ове почти винаги значи "изчерпана дневна квота",
       не временен rate-limit), после превключване на следващия модел;
     - 404 — моделът вече не съществува/преименуван от Google — чисти
       кеша на списъка с модели и превключва на следващия;
     - друга грешка (невалиден ключ/prompt и т.н.) — спира веднага. */
function _classifyGeminiError(e, model, retries) {
  if (!e.status) {
    return { action: "next", log: false, removeFromRoster: false };
  }
  if (e.status === 429) {
    if (retries < 1) {
      return { action: "retry", waitMs: 1500, waitMsg: `⏳ Gemini (${model}) квота — изчаквам 1.5с и опитвам пак...` };
    }
    return {
      action: "next",
      note: "429 — изчерпана квота",
      // Изчерпана дневна квота = "няма как да се подмине" за остатъка от
      // деня — маха модела от ростъра ВЕДНАГА (виж AgentRoster.removeModel).
      removeReason: "429 — изчерпана дневна квота",
      switchMsg: (next) => `⚠️ Gemini "${model}" изчерпа дневната квота — превключвам на "${next}"...`
    };
  }
  if (e.status === 404) {
    return {
      action: "next",
      note: "404 — моделът вече не съществува",
      removeReason: "404 — моделът вече не съществува",
      cacheClearKey: GEMINI_MODELS_CACHE_KEY,
      switchMsg: (next) => `⚠️ Gemini "${model}" вече не съществува — превключвам на "${next}"...`
    };
  }
  return { action: "abort" };
}

// Общ helper за всички Gemini заявки (текст и multimodal) — пробва
// моделите, върнати от getGeminiModelList(), по ред; виж
// _classifyGeminiError по-горе за реда, по който се превключва между тях.
async function callGeminiWithFallback(body, apiKey, timeoutMs = 45000) {
  // Виж бележката в providers/claude.js/callClaude — същият принцип: първо
  // само проверените "работещи" модели от днешния AgentRoster, пълният
  // списък е резерва накрая, само ако всичко от ростъра гръмне.
  const roster = (typeof AgentRoster !== "undefined") ? AgentRoster.getWorking("gemini") : null;
  const fullList = await getGeminiModelList(apiKey);
  const models = (roster && roster.length)
    ? [...ModelPref.applyTo("gemini", roster), ...fullList.filter(m => !roster.includes(m))]
    : fullList;

  return runModelFallbackLoop(
    models,
    (model) => _callGeminiSingle(model, body, apiKey, timeoutMs),
    {
      provider: "gemini",
      classify: _classifyGeminiError,
      maxRetriesPerModel: 1,
      exhaustedMsg: "Gemini API грешка: неуспешно след всички модели"
    }
  );
}

async function callGemini(prompt, useSearch = false) {
  const k = Keys.load();
  if (!k.gemini) { toast("⚠️ Липсва Gemini API ключ (виж Настройки)"); throw new Error("no key"); }

  const body = { contents: [{ parts: [{ text: prompt }] }] };
  // Google Search grounding — дава на Gemini достъп до РЕАЛНИ, актуални резултати
  // от търсачката (вместо само познания от тренировъчните данни).
  if (useSearch) body.tools = [{ google_search: {} }];

  return await callGeminiWithFallback(body, k.gemini, 45000);
}

// Като callGemini(), но подава и аудио файл (inline base64) като multimodal вход —
// ползва се от "Бърз ъплоуд за стари песни", за да може Gemini да "чуе" песента
// директно (жанр/настроение/енергия + разпознаване на текста, ако не е пейстнат ръчно).
// ЗАБЕЛЕЖКА: inline base64 работи добре за файлове до ~20MB (типично за mp3 на стара песен).
async function callGeminiMultimodal(prompt, base64Audio, mimeType, useSearch = false) {
  const k = Keys.load();
  if (!k.gemini) { toast("⚠️ Липсва Gemini API ключ (виж Настройки)"); throw new Error("no key"); }

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType || "audio/mpeg", data: base64Audio } }
      ]
    }]
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  return await callGeminiWithFallback(body, k.gemini, 90000); // аудио анализ е по-бавен от чист текст
}
