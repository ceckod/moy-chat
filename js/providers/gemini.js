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

/* ---------- FALLBACK МЕЖДУ МОДЕЛИ + RETRY/BACKOFF ----------
   Общ helper за всички Gemini заявки (текст и multimodal).
   Пробва моделите, върнати от getGeminiModelList(), по ред. За текущия модел прави
   кратък retry с exponential backoff при 429 (временен rate-limit).
   Ако след тези опити моделът ВСЕ ОЩЕ е на 429 (обикновено = изчерпана
   дневна квота, не временен rate-limit), автоматично минава на СЛЕДВАЩИЯ
   модел от списъка — с ясен toast, за да се разбира какво реално е
   генерирало отговора. Само ако всички модели са изчерпани, гърми грешка.
   Грешки, различни от 429 (невалиден ключ/prompt и т.н.), спират веднага
   без да пробват други модели, защото смяна на модела няма да ги реши. */
async function callGeminiWithFallback(body, apiKey, timeoutMs = 45000) {
  const models = await getGeminiModelList(apiKey);
  let lastError;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Само 1 кратък retry (не 2 с растящо изчакване до 4с) — на практика
    // 429 на безплатните tier-ове почти винаги значи "изчерпана дневна
    // квота", не временен rate-limit, така че бързото превключване към
    // следващия модел е по-полезно от дълго чакане на текущия.
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetchTimeout(proxied(url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }, timeoutMs);
      } catch (e) {
        lastError = e;
        break; // мрежова/timeout грешка — retry тук няма да помогне, пробвай следващ модел
      }

      if (res.ok) {
        const data = await res.json();
        AICallLog.record({ provider: "gemini", model, ok: true });
        QuotaTracker.record("gemini", model);
        return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "(няма отговор)";
      }

      const t = await res.text();
      if (res.status === 429) {
        if (attempt < maxRetries) {
          const waitMs = 1500;
          toast(`⏳ Gemini (${model}) квота — изчаквам ${waitMs / 1000}с и опитвам пак...`, waitMs + 500);
          await new Promise(r => setTimeout(r, waitMs));
          lastError = new Error("Gemini API грешка: " + t);
          continue;
        }
        lastError = new Error(`Gemini API грешка (${model}): ` + t);
        AICallLog.record({ provider: "gemini", model, ok: false, note: "429 — изчерпана квота" });
        if (m < models.length - 1) {
          toast(`⚠️ Gemini "${model}" изчерпа дневната квота — превключвам на "${models[m + 1]}"...`, 4500);
        }
        break; // към следващия модел
      }

      // 404 = моделът вече не съществува/преименуван от Google (случва се с
      // кешираните/резервните имена с времето) — безсмислено да спираме
      // цялото извикване заради това, пробваме следващия модел в списъка.
      if (res.status === 404) {
        lastError = new Error(`Gemini API грешка (${model}): ` + t);
        AICallLog.record({ provider: "gemini", model, ok: false, note: "404 — моделът вече не съществува" });
        try { Storage.remove(GEMINI_MODELS_CACHE_KEY); } catch (e) { /* noop */ }
        if (m < models.length - 1) {
          toast(`⚠️ Gemini "${model}" вече не съществува — превключвам на "${models[m + 1]}"...`, 4500);
        }
        break; // към следващия модел
      }

      // грешка, различна от квота/несъществуващ модел — няма смисъл да
      // пробваме друг модел
      AICallLog.record({ provider: "gemini", model, ok: false, note: t.slice(0, 140) });
      throw new Error("Gemini API грешка: " + t);
    }
  }
  throw lastError || new Error("Gemini API грешка: неуспешно след всички модели");
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
