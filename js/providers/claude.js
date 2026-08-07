/* =========================================================
   PROVIDER: CLAUDE — извадено от app.js (архитектурен рефакторинг,
   точка 3: providers/). Съдържа всичко, специфично за Anthropic API:
   динамичен списък с модели (с кеш + резервен статичен списък),
   единично извикване към конкретен модел, и fallback между модели
   при 429/529.

   Зависи от: js/network.js (fetchTimeout, proxied) — зареден преди
   този файл в index.html. Зависи и от Storage/ModelPref/Keys/toast/
   AICallLog/QuotaTracker — дефинирани в app.js, но реално се ползват
   само ВЪТРЕ във функциите по-долу (при действително извикване по-
   късно, след като всички <script> тагове вече са заредени), затова
   редът в HTML не чупи нищо дори app.js да се зареди след този файл.

   Публичен интерфейс, ползван от останалата част на приложението:
     - getClaudeModelList(apiKey, forceRefresh)
     - callClaude(prompt, maxTokens)
   ========================================================= */

/* ---------- ДИНАМИЧЕН СПИСЪК С CLAUDE МОДЕЛИ ----------
   Питаме директно Anthropic API ("/v1/models") кои модели РЕАЛНО са
   достъпни за твоя ключ, вместо да разчитаме на едно твърдо закодирано
   име. Подреждаме sonnet → haiku → opus (opus е по-скъп, ползва се само
   като последна мярка), изключваме специализирани модели с ограничен
   достъп (Mythos/Fable — виж system бележките на Anthropic за Project
   Glasswing). Резултатът се кешира в localStorage за CLAUDE_MODELS_CACHE_HOURS
   часа, за да не удряме /models endpoint-а при всяка генерация. */
const CLAUDE_MODELS_CACHE_KEY = "cdb_claude_models_cache_v1";
const CLAUDE_MODELS_CACHE_HOURS = 12;

// Статичен резервен списък — ползва се САМО ако /v1/models заявката гръмне.
const CLAUDE_FALLBACK_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8"
];

function _sortClaudeModelNames(ids) {
  // Mythos/Fable са със специален, ограничен достъп (виж Project Glasswing) —
  // не стават за автоматичен fallback на обикновени заявки.
  const exclude = /mythos|fable/i;
  const score = (n) => {
    if (/sonnet/i.test(n)) return 0;
    if (/haiku/i.test(n)) return 1;
    if (/opus/i.test(n)) return 2;
    return 3;
  };
  return ids
    .filter(n => !exclude.test(n))
    .sort((a, b) => score(a) - score(b));
}

async function getClaudeModelList(apiKey, forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const cached = Storage.get(CLAUDE_MODELS_CACHE_KEY);
      if (cached && Array.isArray(cached.models) && cached.models.length &&
          (Date.now() - cached.ts) < CLAUDE_MODELS_CACHE_HOURS * 3600 * 1000) {
        return ModelPref.applyTo("claude", cached.models);
      }
    } catch (e) { /* счупен кеш — просто продължи към реалната заявка */ }
  }

  try {
    const r = await fetchTimeout("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      }
    }, 15000);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || ("HTTP " + r.status));
    const ids = (data.data || []).map(m => m.id);
    const sorted = _sortClaudeModelNames(ids);
    if (!sorted.length) throw new Error("Няма достъпни Claude модели за този ключ");
    Storage.set(CLAUDE_MODELS_CACHE_KEY, { ts: Date.now(), models: sorted });
    return ModelPref.applyTo("claude", sorted);
  } catch (e) {
    console.warn("Неуспешно изтегляне на реалния списък Claude модели, ползвам резервен списък:", e.message);
    return ModelPref.applyTo("claude", CLAUDE_FALLBACK_MODELS);
  }
}

/* ---------- ЕДИНИЧНО ИЗВИКВАНЕ + FALLBACK МЕЖДУ МОДЕЛИ ---------- */

// Единично извикване към КОНКРЕТЕН Claude модел (с вградения max_tokens
// retry за отрязани отговори). Не пипа списъка с модели — това е грижа на
// callClaude() по-долу, който обвива това с fallback между модели.
async function _callClaudeSingle(model, prompt, maxTokens, apiKey, _isRetry = false) {
  const res = await fetchTimeout(proxied("https://api.anthropic.com/v1/messages"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Позволява директно извикване от браузъра (без бекенд прокси)
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  }, 60000); // по-дълъг timeout — генериране на текст отнема повече от кратка проверка
  if (!res.ok) {
    const t = await res.text();
    const err = new Error("Claude API грешка: " + t);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();

  // Ако отговорът е бил отрязан заради max_tokens (чест проблем при по-дълги
  // структурирани JSON отговори — Viral Lab, Ghost Audience и т.н.), опитваме
  // автоматично ОЩЕ ВЕДНЪЖ с двойно по-голям бюджет, вместо да върнем счупен
  // JSON и объркваща грешка. Само 1 повторен опит, за да не увисне безкрайно.
  if (data.stop_reason === "max_tokens" && !_isRetry) {
    return _callClaudeSingle(model, prompt, Math.min(maxTokens * 2, 8000), apiKey, true);
  }
  if (data.stop_reason === "max_tokens" && _isRetry) {
    throw new Error("Отговорът на модела е твърде дълъг дори след удвоен лимит — опитай със по-къса заявка (по-кратък текст/по-малко елементи).");
  }
  return data.content.map(b => b.text || "").join("\n").trim();
}

// Пробва Claude моделите, върнати от getClaudeModelList(), по ред. При 429
// (изчерпана квота) или 529 (претоварен сървър) на текущия модел, автоматично
// минава на следващия — с ясен toast, за да се разбира какво реално е
// генерирало отговора. Други грешки (невалиден ключ/prompt) спират веднага,
// защото смяна на модела няма да ги реши.
async function callClaude(prompt, maxTokens = 1200) {
  const k = Keys.load();
  if (!k.claude) { toast("⚠️ Липсва Claude API ключ (виж Настройки)"); throw new Error("no key"); }
  const models = await getClaudeModelList(k.claude);

  let lastError;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    try {
      const result = await _callClaudeSingle(model, prompt, maxTokens, k.claude);
      AICallLog.record({ provider: "claude", model, ok: true });
      QuotaTracker.record("claude", model);
      return result;
    } catch (e) {
      lastError = e;
      AICallLog.record({ provider: "claude", model, ok: false, note: (e.message || "").slice(0, 140) });
      const isQuotaOrOverload = e.status === 429 || e.status === 529;
      if (isQuotaOrOverload && m < models.length - 1) {
        toast(`⚠️ Claude "${model}" изчерпа квотата/претоварен — превключвам на "${models[m + 1]}"...`, 4500);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("Claude API грешка: неуспешно след всички модели");
}
