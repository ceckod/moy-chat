/* =========================================================
   PROVIDER: AI MODEL FINDER — свързва вградения инструмент "AI Model
   Finder" (папка /ai-model-finder/, обединен в това repo на 2026-08-08)
   с основното табло като ЧЕТВЪРТИ, РЕАЛЕН AI provider — не само
   информационен панел. callAI() (app.js) вече го включва в края на
   fallback реда (Claude → Gemini → OpenRouter → Model Finder), така че
   ако трите "основни" провайдъра нямат ключ или гръмнат, таблото пак има
   работещ AI път — вкл. с НУЛА конфигурирани ключове, благодарение на
   Pollinations (безплатен, без ключ).

   Извиква директно 5 безплатни/евтини източника (OpenAI-съвместими,
   освен Cloudflare, който има собствен формат):
     - Groq            (нужен ключ: groqKey)
     - Mistral AI      (нужен ключ: mistralKey)
     - GitHub Models   (нужен ключ: githubModelsToken — PAT със scope "models: read")
     - Cloudflare Workers AI (нужни: cfApiToken + cfAccountId)
     - Pollinations    (БЕЗ ключ — винаги достъпен)

   Hugging Face НЕ участва в автоматичното извикване тук (само в
   информационния списък по-долу) — HF скрейпва хиляди произволни
   community модели с несигурен/непредвидим chat формат, рисковано е за
   автоматичен fallback. Groq/Mistral/GitHub Models/Cloudflare/
   Pollinations имат стабилни, документирани OpenAI-съвместими endpoint-и.

   Зависи от: js/network.js (fetchTimeout, proxied) и
   js/providers/fallback-loop.js (runModelFallbackLoop) — заредени преди
   този файл в index.html. Ползва Keys/Storage/toast/AICallLog/
   QuotaTracker — дефинирани в app.js, реално ползвани само ВЪТРЕ във
   функциите (същия принцип като бележката в js/providers/claude.js).

   Публичен интерфейс:
     - callModelFinder(prompt, maxTokens)  — извиква се от callAI() в app.js
     - ModelFinder.testKeys(formKeys)      — извиква се от Settings.testKeys()
     - ModelFinder.render() / .refresh()   — информационният панел (view "AI Model Finder")
   ========================================================= */

const MODEL_FINDER_CACHE_KEY = "cdb_model_finder_cache_v1";
const MODEL_FINDER_CACHE_HOURS = 6;
const MODEL_FINDER_JSON_PATH = "ai-model-finder/ai-models.json";

// Ред + endpoint-и + резервни (curated) модели за случая, в който
// ai-model-finder/ai-models.json още не е генериран (напр. GitHub Action-ът
// не е пуснат нито веднъж) или fetch-ът гръмне — същия принцип като
// CLAUDE_FALLBACK_MODELS/OPENROUTER_FALLBACK_MODELS в другите provider файлове.
const MODEL_FINDER_SOURCES = {
  groq: {
    label: "Groq", keyField: "groqKey", special: null,
    chatUrl: "https://api.groq.com/openai/v1/chat/completions",
    curated: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "deepseek-r1-distill-llama-70b"]
  },
  mistral: {
    label: "Mistral", keyField: "mistralKey", special: null,
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
    curated: ["open-mistral-nemo", "open-mixtral-8x22b", "ministral-8b-2410"]
  },
  github: {
    label: "GitHub Models", keyField: "githubModelsToken", special: null,
    chatUrl: "https://models.github.ai/inference/chat/completions",
    curated: ["gpt-4o-mini", "meta-llama-3.3-70b-instruct", "phi-4"]
  },
  cloudflare: {
    label: "Cloudflare Workers AI", keyField: "cfApiToken", extraKeyField: "cfAccountId", special: "cloudflare",
    curated: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/qwen/qwen2.5-coder-32b-instruct"]
  },
  pollinations: {
    label: "Pollinations", keyField: null, special: null,
    chatUrl: "https://text.pollinations.ai/openai", // самият endpoint = /chat/completions еквивалент, без суфикс
    curated: ["openai", "openai-large", "mistral", "llama"]
  }
};
// Фиксиран приоритет — по-щедри/по-бързи безплатни tier-ове напред,
// Pollinations последен (винаги достъпен без ключ, но споделена опашка
// без автентикация → по-вероятно да е претоварен под чуждо натоварване).
const MODEL_FINDER_SOURCE_ORDER = ["groq", "mistral", "github", "cloudflare", "pollinations"];

function _modelFinderSourceAvailable(source, keys) {
  const cfg = MODEL_FINDER_SOURCES[source];
  if (!cfg.keyField) return true; // Pollinations
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

  // Финалният списък модели, които РЕАЛНО ще се пробват за даден source:
  // discovered (ако има) + curated резерва, дедупликирани, discovered напред
  // (по-актуални, теглени в последните 24ч от скрейпъра).
  async modelsForSource(source) {
    const { models } = await this._load();
    const cfg = MODEL_FINDER_SOURCES[source];
    const discovered = this._discoveredChatModels(models || [], source);
    const merged = [...discovered, ...cfg.curated.filter(m => !discovered.includes(m))];
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
        `Groq/Mistral/GitHub Models/Cloudflare/Pollinations по-долу пак работят с вградените резервни модели. ` +
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
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border,#2a2a3a);">` +
        `<strong>${id}</strong>` +
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
        continue; // pollinations никога не влиза тук (винаги available)
      }
      const models = await this.modelsForSource(source);
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
  const apiKey = cfg.keyField ? keys[cfg.keyField] : null; // null за Pollinations
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
  if (!sources.length) throw new Error("no key"); // на практика никога — pollinations няма нужда от ключ

  // Плосък списък от кандидати "source::model" по фиксирания приоритет
  // на източниците, до 3 модела на всеки, за да не увисне заявката, ако
  // всичко гърми едновременно.
  const candidates = [];
  for (const source of sources) {
    const models = await ModelFinder.modelsForSource(source);
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
