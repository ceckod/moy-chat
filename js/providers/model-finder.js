/* =========================================================
   PROVIDER: AI MODEL FINDER — свързва вградения инструмент "AI Model
   Finder" (папка /ai-model-finder/, обединен в това repo на 2026-08-08)
   с основното табло като ЧЕТВЪРТИ, РЕАЛЕН AI provider — не само
   информационен панел. callAI() (app.js) вече го включва в края на
   fallback реда (Claude → Gemini → OpenRouter → Model Finder), така че
   ако трите "основни" провайдъра нямат ключ или гръмнат, таблото пак има
   работещ AI път — стига поне ЕДИН от 4-те безплатни ключа по-долу
   (Groq/Mistral/GitHub Models/Cloudflare) да е конфигуриран.

   Извиква директно 4 безплатни източника (OpenAI-съвместими,
   освен Cloudflare, който има собствен формат):
     - Groq            (нужен ключ: groqKey)
     - Mistral AI      (нужен ключ: mistralKey)
     - GitHub Models   (нужен ключ: githubModelsToken — PAT със scope "models: read")
     - Cloudflare Workers AI (нужни: cfApiToken + cfAccountId)

   Pollinations БЕШЕ тук като "без ключ, винаги достъпен" резерв, но е
   премахнат — споделена анонимна опашка с нестабилно качество/uptime.
   Всичките 4 източника по-горе имат безплатен tier, който изисква само
   регистрация (без плащане), затова таблото винаги моли за поне един
   от тези 4 ключа вместо да разчита на "без ключ въобще".

   Hugging Face НЕ участва в автоматичното текстово извикване тук (само в
   информационния списък по-долу и отделно в js/providers/musicgen.js за
   музика) — HF скрейпва хиляди произволни community модели с несигурен/
   непредвидим chat формат, рисковано е за автоматичен fallback.
   Groq/Mistral/GitHub Models/Cloudflare имат стабилни, документирани
   OpenAI-съвместими endpoint-и.

   Зависи от: js/network.js (fetchTimeout, proxied) и
   js/providers/fallback-loop.js (runModelFallbackLoop) — заредени преди
   този файл в index.html. Ползва Keys/Storage/toast/AICallLog/
   QuotaTracker — дефинирани в app.js, реално ползвани само ВЪТРЕ във
   функциите (същия принцип като бележката в js/providers/claude.js).

   Публичен интерфейс:
     - callModelFinder(prompt, maxTokens)  — извиква се от callAI() в app.js
     - ModelFinder.testKeys(formKeys)      — извиква се от Settings.testKeys()
     - ModelFinder.render() / .refresh()   — информационният панел (view "AI Model Finder")

   ЖИВО ОТКРИВАНЕ НА МОДЕЛИ (2026-08-23, важна промяна):
   Преди тук имаше само ръчно записан ("curated") списък модели — когато
   доставчик спре/преименува модел (напр. Groq спря llama-3.3-70b-versatile),
   целият provider чупеше с HTTP 404, докато НЯКОЙ ръчно не обновеше кода.
   Вместо това сега ВСЕКИ source (ако си сложил ключа) първо пита ДОСТАВЧИКА
   директно "какви модели имаш точно сега" (реален GET към техния
   /models или /catalog endpoint), кешира отговора 12ч (_liveModelsForSource),
   и чак ако това гръмне/върне празно, пада на ръчния curated списък по-долу
   (last-resort backup, не основен път). Така спиране/преименуване на модел
   от страна на доставчика вече НЕ изисква ъпдейт на кода тук.
   ========================================================= */

const MODEL_FINDER_CACHE_KEY = "cdb_model_finder_cache_v1";
const MODEL_FINDER_CACHE_HOURS = 6;
const MODEL_FINDER_JSON_PATH = "ai-model-finder/ai-models.json";
const MODEL_FINDER_LIVE_CACHE_HOURS = 12; // TTL за живо-открития списък модели на всеки source

// Общ филтър за OpenAI-съвместими /v1/models отговори (Groq, Mistral) —
// маха ясно НЕ-чат модели (аудио/TTS/embedding/guard/moderation), пази
// всичко останало КАКВОТО и да е — така нов чат модел на доставчика
// автоматично влиза в играта, без някой да пипа този файл.
function _filterChatModelIds(ids, excludeSubstrings) {
  return ids.filter(id => {
    const low = id.toLowerCase();
    return !excludeSubstrings.some(bad => low.includes(bad));
  });
}

function _parseOpenAICompatModelsList(data, excludeSubstrings) {
  const ids = (data?.data || []).map(m => m.id).filter(Boolean);
  return _filterChatModelIds(ids, excludeSubstrings);
}

// Ред + endpoint-и (chat + модели-откриване) + резервни (curated) модели
// за случая, в който ЖИВОТО откриване гръмне (мрежа, гост endpoint и
// т.н.) — same принцип като CLAUDE_FALLBACK_MODELS/OPENROUTER_FALLBACK_MODELS
// в другите provider файлове, но вече е ПОСЛЕДНА линия защита, не първа.
const MODEL_FINDER_SOURCES = {
  groq: {
    label: "Groq", keyField: "groqKey", special: null,
    chatUrl: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: () => "https://api.groq.com/openai/v1/models",
    modelsHeaders: keys => ({ "Authorization": `Bearer ${keys.groqKey}` }),
    parseModels: data => _parseOpenAICompatModelsList(data, ["whisper", "tts", "guard", "playai", "orpheus", "safeguard", "prompt-guard"]),
    // Резервен списък САМО ако живото откриване е недостъпно (проверен 2026-08-23,
    // но може пак да остарее — точно затова вече не е основният път).
    curated: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"]
  },
  mistral: {
    label: "Mistral", keyField: "mistralKey", special: null,
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
    modelsUrl: () => "https://api.mistral.ai/v1/models",
    modelsHeaders: keys => ({ "Authorization": `Bearer ${keys.mistralKey}` }),
    parseModels: data => _parseOpenAICompatModelsList(data, ["embed", "moderation", "ocr", "transcribe"]),
    curated: ["open-mistral-nemo", "open-mixtral-8x22b", "ministral-8b-2410"]
  },
  github: {
    label: "GitHub Models", keyField: "githubModelsToken", special: null,
    chatUrl: "https://models.github.ai/inference/chat/completions",
    modelsUrl: () => "https://models.github.ai/catalog/models",
    modelsHeaders: keys => ({
      "Authorization": `Bearer ${keys.githubModelsToken}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }),
    // GitHub Models catalog връща плосък масив от обекти с id/task/
    // supported_input_modalities/supported_output_modalities — пазим само
    // текст-към-текст модели, махаме embeddings/аудио/изображения по task или модалности.
    parseModels: data => {
      const arr = Array.isArray(data) ? data : (data?.models || []);
      return arr
        .filter(m => {
          const task = (m.task || m.task_name || "").toLowerCase();
          const outMods = (m.supported_output_modalities || m.output_modalities || []).map(x => String(x).toLowerCase());
          const inMods = (m.supported_input_modalities || m.input_modalities || []).map(x => String(x).toLowerCase());
          if (task) return task.includes("chat") || task.includes("completion");
          if (outMods.length) return outMods.includes("text") && inMods.includes("text");
          return true; // няма достатъчно инфо да филтрираме — по-добре да минем, отколкото да чупим
        })
        .map(m => m.id || m.name)
        .filter(Boolean);
    },
    curated: ["openai/gpt-4o-mini", "meta/meta-llama-3.1-8b-instruct", "microsoft/phi-4"]
  },
  cloudflare: {
    label: "Cloudflare Workers AI", keyField: "cfApiToken", extraKeyField: "cfAccountId", special: "cloudflare",
    modelsUrl: keys => `https://api.cloudflare.com/client/v4/accounts/${keys.cfAccountId}/ai/models/search?task=Text+Generation&per_page=20`,
    modelsHeaders: keys => ({ "Authorization": `Bearer ${keys.cfApiToken}` }),
    parseModels: data => {
      const arr = data?.result || [];
      return arr.map(m => m.name || m.id).filter(Boolean);
    },
    curated: ["@cf/meta/llama-3.1-8b-instruct", "@cf/qwen/qwen1.5-14b-chat-awq"]
  }
};
// Фиксиран приоритет — по-щедри/по-бързи безплатни tier-ове напред.
const MODEL_FINDER_SOURCE_ORDER = ["groq", "mistral", "github", "cloudflare"];

// Извиква доставчика директно за живия му моделен списък, кешира резултата
// (per-source, MODEL_FINDER_LIVE_CACHE_HOURS) — при грешка връща последния
// ВАЛИДЕН кеш, ако има такъв (по-добре остарял списък, отколкото нищо),
// иначе null (тогава modelsForSource() пада на curated).
async function _liveModelsForSource(source, keys) {
  const cfg = MODEL_FINDER_SOURCES[source];
  if (!cfg.modelsUrl) return null;
  const cacheKey = `cdb_model_finder_live_${source}`;
  const cached = Storage.get(cacheKey);
  if (cached && Array.isArray(cached.models) && cached.models.length &&
      (Date.now() - cached.ts) < MODEL_FINDER_LIVE_CACHE_HOURS * 3600 * 1000) {
    return cached.models;
  }
  try {
    const url = cfg.modelsUrl(keys);
    const res = await fetchTimeout(proxied(url), { headers: cfg.modelsHeaders(keys) }, 15000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const ids = cfg.parseModels(data) || [];
    if (!ids.length) throw new Error("празен списък");
    Storage.set(cacheKey, { ts: Date.now(), models: ids });
    return ids;
  } catch (e) {
    return (cached && cached.models) || null; // остарял кеш е по-добър от нищо
  }
}

function _modelFinderSourceAvailable(source, keys) {
  const cfg = MODEL_FINDER_SOURCES[source];
  if (!cfg.keyField) return true; // (нито един текущ source вече е без ключ)
  if (!keys[cfg.keyField]) return false;
  if (cfg.extraKeyField && !keys[cfg.extraKeyField]) return false;
  return true;
}

// "source/model" <-> {source, model} — форматът, в който минават през
// runModelFallbackLoop (очаква плосък списък от прости идентификатори;
// показва се директно в AICallLog, затова използваме "/" за четимост).
// Разделяме на ПЪРВОТО "/", защото Cloudflare model id-та сами по себе
// си съдържат "/" (напр. "@cf/meta/llama-3.3-70b-instruct-fp8-fast").
function _encodeCandidate(source, model) { return `${source}/${model}`; }
function _decodeCandidate(key) {
  const i = key.indexOf("/");
  return { source: key.slice(0, i), model: key.slice(i + 1) };
}

/* ---------- Информационен панел (view "AI Model Finder") ---------- */
const ModelFinder = {
  async _load(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = Storage.get(MODEL_FINDER_CACHE_KEY);
      if (cached && Array.isArray(cached.models) &&
          (Date.now() - cached.ts) < MODEL_FINDER_CACHE_HOURS * 3600 * 1000) {
        return cached;
      }
    }
    try {
      const r = await fetchTimeout(MODEL_FINDER_JSON_PATH + "?t=" + Date.now(), {}, 15000);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const models = Array.isArray(data) ? data : (data.models || []);
      const result = { ts: Date.now(), models, generatedAt: data.generated_at || data.generatedAt || null };
      Storage.set(MODEL_FINDER_CACHE_KEY, result);
      return result;
    } catch (e) {
      return { ts: Date.now(), models: [], error: e.message };
    }
  },

  // discovered chat-модели за даден source от ai-models.json (само type "chat")
  _discoveredChatModels(discovered, source) {
    return discovered.filter(m => m.source === source && m.type === "chat").map(m => m.id);
  },

  // Финалният списък модели, които РЕАЛНО ще се пробват за даден source,
  // подредени по приоритет:
  //   1) ЖИВО открити от самия доставчик точно сега (_liveModelsForSource —
  //      реален GET към техния /models endpoint, кеширан 12ч) — това е
  //      единственото ниво, което автоматично следва спиране/преименуване
  //      на модел от доставчика, БЕЗ ъпдейт на кода тук.
  //   2) discovered от ai-models.json (нощния скрейпър тук в repo-то)
  //   3) curated (ръчно записан резерв) — само ако 1 и 2 върнат празно.
  // keys е по избор — ако липсва (напр. testKeys() ги подава директно),
  // живото откриване просто се пропуска за source-и без ключ в тях.
  async modelsForSource(source, keys = null) {
    const cfg = MODEL_FINDER_SOURCES[source];
    const live = (keys && _modelFinderSourceAvailable(source, keys))
      ? await _liveModelsForSource(source, keys)
      : null;
    const { models } = await this._load();
    const discovered = this._discoveredChatModels(models || [], source);
    const merged = [
      ...(live || []),
      ...discovered.filter(m => !(live || []).includes(m)),
      ...cfg.curated.filter(m => !(live || []).includes(m) && !discovered.includes(m))
    ];
    return merged.slice(0, 6); // не пробвай безкраен списък при всяка заявка
  },

  async refresh() {
    await this._load(true);
    return this.render();
  },

  async render() {
    const out = document.getElementById("modelFinderOut");
    if (!out) return;
    out.textContent = "⏳ Зареждам ai-model-finder/ai-models.json...";
    const { models, error, generatedAt } = await this._load();
    if (error) {
      out.innerHTML = `<span style="color:var(--danger,#e5484d)">⚠️ Още няма генериран списък (${error}). Не е проблем — ` +
        `Groq/Mistral/GitHub Models/Cloudflare по-долу пак работят с вградените резервни модели (стига да имаш поне един ключ). ` +
        `Отвори <a href="ai-model-finder/index.html" target="_blank" rel="noopener">AI Model Finder</a> и натисни ` +
        `„Намери ми AI модели", или пусни GitHub Action-а „AI Model Finder — обновяване на модели" веднъж ръчно за пълния списък.</span>`;
      return;
    }
    if (!models.length) {
      out.textContent = "Няма намерени модели все още — отвори AI Model Finder и генерирай списъка (вградените резервни модели по-долу пак работят).";
      return;
    }
    const rows = models.slice(0, 50).map(m => {
      const id = m.id || m.model || m.name || "?";
      const provider = m.provider || m.source || "";
      const auth = m.auth?.type || m.auth || "";
      const keyEnv = m.key_env || m.auth?.key_env || "";
      // verified: потвърден, готов за директно извикване endpoint (виж
      // ai-model-finder/scraper.mjs) — за модели без явно поле (по-стар
      // ai-models.json, генериран преди тази промяна) третираме като
      // verified, за да не изчезнат внезапно от списъка.
      const verified = m.verified !== false;
      const badge = verified
        ? `<span class="optional-tag" style="color:var(--green,#3fb950);">✅ онлайн</span>`
        : `<span class="optional-tag" style="color:var(--amber,#d29922);">⚠️ провери endpoint</span>`;
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border,#2a2a3a);">` +
        `<strong>${id}</strong> ${badge}` +
        (provider ? ` <span class="muted">· ${provider}</span>` : "") +
        (auth ? ` <span class="optional-tag">${auth}${keyEnv ? " (" + keyEnv + ")" : ""}</span>` : "") +
        `</div>`;
    }).join("");
    out.innerHTML =
      (generatedAt ? `<p class="muted" style="margin-bottom:8px;">Последно обновено: ${generatedAt}</p>` : "") +
      `<p class="muted" style="margin-bottom:8px;">${models.length} открити модела (показани първите ${Math.min(50, models.length)}):</p>` +
      rows;
  },

  // ---------- Тест на ключовете (извиква се от Settings.testKeys()) ----------
  // formKeys = обект с ТЕКУЩО въведените (още незапазени) стойности от формата:
  // { groqKey, mistralKey, githubModelsToken, cfApiToken, cfAccountId }
  async testKeys(formKeys) {
    const lines = [];
    let anyOk = false;
    for (const source of MODEL_FINDER_SOURCE_ORDER) {
      const cfg = MODEL_FINDER_SOURCES[source];
      if (!_modelFinderSourceAvailable(source, formKeys)) {
        if (cfg.keyField) lines.push(`${cfg.label}: ⚪ няма ключ`);
        continue;
      }
      const models = await this.modelsForSource(source, formKeys);
      let found = null;
      const attempts = [];
      for (const model of models.slice(0, 3)) {
        try {
          const text = await _callModelFinderSingle(source, model, "hi", 16, formKeys);
          if (text) { found = model; AICallLog.record({ provider: "modelfinder", model: `${source}/${model}`, ok: true, note: "тест" }); break; }
        } catch (e) {
          attempts.push(`${model} → ❌ ${e.message}`);
          AICallLog.record({ provider: "modelfinder", model: `${source}/${model}`, ok: false, note: "тест: " + (e.message || "").slice(0, 100) });
        }
      }
      if (found) {
        anyOk = true;
        lines.push(`${cfg.label}: ✅ работи (${found})`);
      } else {
        lines.push(`${cfg.label}: ❌ нито един модел не отговори` + (attempts.length ? "\n   " + attempts.join("\n   ") : ""));
      }
    }
    return { ok: anyOk, lines };
  }
};

/* ---------- Единично извикване (OpenAI-съвместими източници) ---------- */
async function _callModelFinderOpenAICompatSingle(chatUrl, model, prompt, maxTokens, apiKey, _isRetry = false) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetchTimeout(proxied(chatUrl), {
    method: "POST", headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  }, 45000);
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error("Няма съдържание в отговора");
  if (choice.finish_reason === "length" && !_isRetry) {
    return _callModelFinderOpenAICompatSingle(chatUrl, model, prompt, Math.min(maxTokens * 2, 3000), apiKey, true);
  }
  return text.trim();
}

/* ---------- Единично извикване (Cloudflare Workers AI — различен формат) ---------- */
async function _callModelFinderCloudflareSingle(model, prompt, maxTokens, apiToken, accountId) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const res = await fetchTimeout(proxied(url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: maxTokens })
  }, 45000);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success === false) {
    const errMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }
  const text = data.result?.response;
  if (!text) throw new Error("Няма съдържание в отговора");
  return String(text).trim();
}

// Единна входна точка според source-а (обвива двата формата по-горе).
async function _callModelFinderSingle(source, model, prompt, maxTokens, keys) {
  const cfg = MODEL_FINDER_SOURCES[source];
  if (cfg.special === "cloudflare") {
    return _callModelFinderCloudflareSingle(model, prompt, maxTokens, keys.cfApiToken, keys.cfAccountId);
  }
  const apiKey = cfg.keyField ? keys[cfg.keyField] : null;
  return _callModelFinderOpenAICompatSingle(cfg.chatUrl, model, prompt, maxTokens, apiKey);
}

// Всяка грешка тук просто минава към следващия кандидат — различните
// източници/модели имат твърде различни грешки (HTTP кодове/мрежа), за да
// има смисъл от нюансирано "retry срещу abort" както при Claude/Gemini/
// OpenRouter; целта на AI Model Finder е да е последен, широк резерв.
function _classifyModelFinderError(candidateKey) {
  const { source, model } = _decodeCandidate(candidateKey);
  return {
    action: "next",
    removeFromRoster: false, // AgentRoster не следи "modelfinder" — безопасен no-op, но изричен за яснота
    switchMsg: (nextKey) => {
      const next = _decodeCandidate(nextKey);
      return `⚠️ ${MODEL_FINDER_SOURCES[source].label} "${model}" не се справи — превключвам на ${MODEL_FINDER_SOURCES[next.source].label} "${next.model}"...`;
    }
  };
}

/* ---------- Публичната функция, викана от callAI() в app.js ---------- */
async function callModelFinder(prompt, maxTokens = 900) {
  const keys = Keys.load();
  const sources = MODEL_FINDER_SOURCE_ORDER.filter(s => _modelFinderSourceAvailable(s, keys));
  if (!sources.length) throw new Error("no key"); // нито един от 4-те безплатни ключа не е конфигуриран

  // Плосък списък от кандидати "source::model" по фиксирания приоритет
  // на източниците, до 3 модела на всеки, за да не увисне заявката, ако
  // всичко гърми едновременно.
  const candidates = [];
  for (const source of sources) {
    const models = await ModelFinder.modelsForSource(source, keys);
    for (const model of models.slice(0, 3)) candidates.push(_encodeCandidate(source, model));
  }

  return runModelFallbackLoop(
    candidates,
    (candidateKey) => {
      const { source, model } = _decodeCandidate(candidateKey);
      return _callModelFinderSingle(source, model, prompt, maxTokens, keys);
    },
    {
      provider: "modelfinder",
      classify: (e, candidateKey) => _classifyModelFinderError(candidateKey),
      exhaustedMsg: "AI Model Finder: неуспешно след всички безплатни източници"
    }
  );
}

// Като callModelFinder(), но САМО за ЕДИН конкретен източник (Groq ИЛИ
// Mistral ИЛИ GitHub Models ИЛИ Cloudflare) — ползва се от чат секцията
// (виж js/agent-registry.js), когато потребителят изрично е избрал ТОЧНО
// този агент от менюто. За разлика от callModelFinder() по-горе (fallback
// верига през ВСИЧКИ източници, ползвана само като последна мярка от
// callAI() другаде в таблото), тук НИКОГА не се прескача към друга
// компания при грешка — само между МОДЕЛИТЕ на СЪЩИЯ избран източник
// (напр. ако llama-3.3 на Groq гръмне, пробва llama-3.1 — пак Groq,
// не изведнъж Mistral). Точно това разделяне разреши объркването "избрах
// Mistral, но отговори друг доставчик".
async function callModelFinderSource(source, prompt, maxTokens = 900) {
  const keys = Keys.load();
  if (!_modelFinderSourceAvailable(source, keys)) throw new Error("no key");
  const models = await ModelFinder.modelsForSource(source, keys);
  if (!models.length) throw new Error(`Няма известни модели за ${MODEL_FINDER_SOURCES[source].label}`);

  return runModelFallbackLoop(
    models,
    (model) => _callModelFinderSingle(source, model, prompt, maxTokens, keys),
    {
      provider: "modelfinder:" + source,
      classify: () => ({ action: "next", removeFromRoster: false }),
      exhaustedMsg: `${MODEL_FINDER_SOURCES[source].label}: неуспешно след всички известни модела`
    }
  );
}
