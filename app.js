/* =========================================================
   CD-B Records — Control Dashboard
   Един файл SPA логика. Всичко локално (localStorage).
   ========================================================= */

const STORAGE_KEY = "cdb_dashboard_state_v1";
const KEYS_STORAGE = "cdb_dashboard_keys_v1";

/* =========================================================
   ДИНАМИЧЕН СПИСЪК С GEMINI МОДЕЛИ
   Вместо да разчитаме на твърдо закодирани имена на модели (Google ги
   преименува/премахва от време на време и това чупи приложението), питаме
   директно Gemini API ("/v1beta/models") какви модели РЕАЛНО са достъпни
   за твоя конкретен ключ, и подреждаме безплатните текстови модели по
   приоритет (lite → flash → останалите; изключваме pro/embedding/image/
   tts модели). Резултатът се кешира в localStorage за GEMINI_MODELS_CACHE_HOURS
   часа, за да не удряме /models endpoint-а при всяка генерация.
   Ако заявката гръмне (няма интернет, невалиден ключ...), падаме обратно
   на GEMINI_FALLBACK_MODELS — статичен списък "за всеки случай".
   ========================================================= */
const GEMINI_MODELS_CACHE_KEY = "cdb_gemini_models_cache_v1";
const GEMINI_MODELS_CACHE_HOURS = 12;

// Статичен резервен списък — ползва се САМО ако не успеем да изтеглим
// реалния списък с модели от Google. Не е гарантирано да е винаги валиден
// (затова динамичното изтегляне по-долу е предпочитаният път).
const GEMINI_FALLBACK_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
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
      const cached = JSON.parse(localStorage.getItem(GEMINI_MODELS_CACHE_KEY) || "null");
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
    localStorage.setItem(GEMINI_MODELS_CACHE_KEY, JSON.stringify({ ts: Date.now(), models: sorted }));
    return ModelPref.applyTo("gemini", sorted);
  } catch (e) {
    console.warn("Неуспешно изтегляне на реалния списък Gemini модели, ползвам резервен списък:", e.message);
    return ModelPref.applyTo("gemini", GEMINI_FALLBACK_MODELS);
  }
}

/* =========================================================
   ДИНАМИЧЕН СПИСЪК С CLAUDE МОДЕЛИ
   Същият принцип като при Gemini по-горе: питаме директно Anthropic API
   ("/v1/models") кои модели РЕАЛНО са достъпни за твоя ключ, вместо да
   разчитаме на едно твърдо закодирано име. Подреждаме sonnet → haiku →
   opus (opus е по-скъп, ползва се само като последна мярка), изключваме
   специализирани модели с ограничен достъп (Mythos/Fable — виж system
   бележките на Anthropic за Project Glasswing). Кешира се аналогично.
   ========================================================= */
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
      const cached = JSON.parse(localStorage.getItem(CLAUDE_MODELS_CACHE_KEY) || "null");
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
    localStorage.setItem(CLAUDE_MODELS_CACHE_KEY, JSON.stringify({ ts: Date.now(), models: sorted }));
    return ModelPref.applyTo("claude", sorted);
  } catch (e) {
    console.warn("Неуспешно изтегляне на реалния списък Claude модели, ползвам резервен списък:", e.message);
    return ModelPref.applyTo("claude", CLAUDE_FALLBACK_MODELS);
  }
}

/* ---------- STATE ---------- */
const AppState = {
  data: null,

  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    this.data = raw ? JSON.parse(raw) : {
      currentStep: 1,
      status: { 1: "blue", 2: "grey", 3: "grey", 4: "grey" },
      project: {
        niches: [], chosenNiche: null, nicheScore: null,
        title: "", stylePrompt: "", hashtags: [],
        lyrics: "", geminiReview: "",
        fxConfig: "", coverPrompt: "", coverImageUrl: "",
        distrokid: {}, youtube: {}
      }
    };
  },
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  }
};

const Keys = {
  load() {
    const raw = localStorage.getItem(KEYS_STORAGE);
    return raw ? JSON.parse(raw) : {};
  },
  save(obj) {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(obj));
  }
};

/* =========================================================
   MODEL PREF — кой модел се ползва "по подразбиране" за всяко
   извикване (callClaude/callGeminiWithFallback), вместо винаги да
   пробваме fallback списъка отначало (models[0]).
   Два начина да се зададе:
     - "auto"   → Settings.testKeys() пробва РЕАЛНО моделите от fallback
                  списъка по ред и хваща ПЪРВИЯ, който отговори успешно.
                  Пази се като предпочитание, докато не се промени.
     - "manual" → потребителят избира ръчно от падащото меню в Настройки.
   И в двата случая предпочитаният модел се пази в localStorage (не само
   за текущата сесия/таб, а докато не бъде презаписан/изчистен), и всяко
   място в кода, което вика модел за дадения provider, автоматично го
   ползва (виж getClaudeModelList/getGeminiModelList по-долу — те бутат
   предпочетения модел на първо място в списъка, останалите модели пак
   стоят като fallback, ако предпочетеният внезапно откаже/изчерпа квота).
   ========================================================= */
const MODEL_PREF_KEY = "cdb_model_pref_v1";

const ModelPref = {
  _load() {
    try { return JSON.parse(localStorage.getItem(MODEL_PREF_KEY) || "{}"); } catch (e) { return {}; }
  },
  _save(data) { localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(data)); },

  // { model, source: "auto" | "manual" } или null, ако няма зададено предпочитание
  get(provider) {
    const data = this._load();
    return data[provider] || null;
  },
  set(provider, model, source = "manual") {
    const data = this._load();
    data[provider] = { model, source };
    this._save(data);
    this._renderIfVisible();
  },
  clear(provider) {
    const data = this._load();
    delete data[provider];
    this._save(data);
    this._renderIfVisible();
  },
  // Подрежда списък от модели, слагайки предпочетения (ако има) на първо
  // място — останалите пазят реда си като fallback.
  applyTo(provider, models) {
    const pref = this.get(provider);
    if (!pref || !models.includes(pref.model)) return models;
    return [pref.model, ...models.filter(m => m !== pref.model)];
  },
  _renderIfVisible() {
    if (document.getElementById("modelPrefOut")) Settings.renderModelPref();
  }
};

/* =========================================================
   AI CALL LOG — диагностичен лог кой provider/модел РЕАЛНО е
   отговорил на всяко извикване (и кои опити са гръмнали по пътя).
   Полезно е за да се вижда напр. "Gemini flash-lite гръмна → падна на
   flash → отговори". Пази се отделно от проекта (не се export-ва с него),
   само последните AI_CALL_LOG_MAX записа.
   ========================================================= */
const AI_CALL_LOG_KEY = "cdb_ai_call_log_v1";
const AI_CALL_LOG_MAX = 40;

const AICallLog = {
  record({ provider, model, ok, note }) {
    let log = [];
    try { log = JSON.parse(localStorage.getItem(AI_CALL_LOG_KEY) || "[]"); } catch (e) { /* счупен лог, пренапиши */ }
    log.unshift({ ts: Date.now(), provider, model, ok: !!ok, note: note || "" });
    log = log.slice(0, AI_CALL_LOG_MAX);
    localStorage.setItem(AI_CALL_LOG_KEY, JSON.stringify(log));
    this._renderIfVisible();
  },
  get() {
    try { return JSON.parse(localStorage.getItem(AI_CALL_LOG_KEY) || "[]"); } catch (e) { return []; }
  },
  clear() {
    localStorage.removeItem(AI_CALL_LOG_KEY);
    this._renderIfVisible();
  },
  _renderIfVisible() {
    if (document.getElementById("aiCallLogOut")) this.render();
  },
  render() {
    const el = document.getElementById("aiCallLogOut");
    if (!el) return;
    const log = this.get();
    if (!log.length) { el.textContent = "Все още няма записани извиквания в тази сесия/устройство."; return; }
    el.textContent = log.map(e => {
      const time = new Date(e.ts).toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const providerLabel = e.provider === "claude" ? "Claude" : "Gemini";
      return `${time} ${e.ok ? "✅" : "❌"} ${providerLabel} · ${e.model}${e.note ? " — " + e.note : ""}`;
    }).join("\n");
  }
};

/* =========================================================
   QUOTA TRACKER — приблизителен, ЛОКАЛЕН брояч на извиквания на ден,
   по provider+модел. Google/Anthropic не връщат "оставаща квота" през
   API-то, затова това е само груба ориентация (не официална бройка) —
   нулира се условно "на нов ден" по UTC дата на устройството.
   ========================================================= */
const QUOTA_TRACKER_KEY = "cdb_quota_tracker_v1";

const QuotaTracker = {
  _today() { return new Date().toISOString().slice(0, 10); },
  _load() {
    try { return JSON.parse(localStorage.getItem(QUOTA_TRACKER_KEY) || "{}"); } catch (e) { return {}; }
  },
  _save(data) { localStorage.setItem(QUOTA_TRACKER_KEY, JSON.stringify(data)); },

  record(provider, model) {
    const data = this._load();
    const day = this._today();
    if (data.day !== day) { data.day = day; data.counts = {}; } // нов ден — чист брояч
    data.counts = data.counts || {};
    const key = provider + " · " + model;
    data.counts[key] = (data.counts[key] || 0) + 1;
    this._save(data);
    this._renderIfVisible();
  },

  summary() {
    const data = this._load();
    if (data.day !== this._today()) return {};
    return data.counts || {};
  },

  _renderIfVisible() {
    if (document.getElementById("quotaTrackerOut")) this.render();
  },

  render() {
    const el = document.getElementById("quotaTrackerOut");
    if (!el) return;
    const counts = this.summary();
    const keys = Object.keys(counts);
    el.textContent = keys.length
      ? "Днес (приблизително, локален брояч — не официална квота):\n" + keys.map(k => `${k}: ${counts[k]}`).join("\n")
      : "Още няма извиквания днес на това устройство.";
  }
};

/* =========================================================
   AI CACHE — за скъпи структурирани анализи (Viral Lab, Ghost Audience),
   за да не се хаби квота, ако потребителят натисне бутона повторно върху
   ТОЧНО СЪЩИЯ текст/жанр/заглавие. Ключиран е по хеш на входните данни;
   при промяна на текста автоматично прави нова заявка (различен хеш).
   Бутон "🔄 презареди" в UI-то може да подаде forceRefresh, за да игнорира
   кеша нарочно.
   ========================================================= */
const AI_CACHE_KEY = "cdb_ai_cache_v1";
const AI_CACHE_MAX_ENTRIES = 20;

function _simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const AICache = {
  _load() {
    try { return JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}"); } catch (e) { return {}; }
  },
  _save(data) { localStorage.setItem(AI_CACHE_KEY, JSON.stringify(data)); },
  _key(type, inputs) { return type + ":" + _simpleHash(JSON.stringify(inputs)); },

  get(type, inputs) {
    const entry = this._load()[this._key(type, inputs)];
    return entry ? entry.result : null;
  },

  set(type, inputs, result) {
    const data = this._load();
    data[this._key(type, inputs)] = { ts: Date.now(), result };
    const keys = Object.keys(data);
    if (keys.length > AI_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => data[a].ts - data[b].ts)
        .slice(0, keys.length - AI_CACHE_MAX_ENTRIES)
        .forEach(k => delete data[k]);
    }
    this._save(data);
  }
};

/* ---------- TOAST ---------- */
function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.style.display = "none"), ms);
}

/* ---------- GUARD CLICK ---------- */
// Заключва бутона по време на асинхронна AI заявка, за да не се задвоят
// генерирания при бавна мрежа (особено лесно се случва на телефон, когато
// потребителят чука бутона втори път, докато чака). Освобождава бутона
// винаги накрая — успешно или с грешка — за да не остане "залепнал".
async function guardClick(btnEl, fn) {
  if (!btnEl || btnEl.disabled) return;
  btnEl.disabled = true;
  btnEl.style.opacity = "0.6";
  btnEl.style.cursor = "not-allowed";
  try {
    await fn();
  } finally {
    btnEl.disabled = false;
    btnEl.style.opacity = "";
    btnEl.style.cursor = "";
  }
}

/* ---------- NAVIGATION (sidebar multi-view router) ---------- */
// Приложението е PWA (standalone display, виж manifest.json) — на телефон, ако
// няма browser history entries между view-овете, бутонът "Назад" на телефона
// излиза директно от приложението вместо да се връща на предишния екран в него.
// Затова всяка навигация през showView() бута нов history запис (pushState),
// а popstate (физическото Назад) само рендира view-а от запазения state,
// без пак да бута нов запис — така стека расте/намалява 1:1 с реалната
// навигация на потребителя, точно като в нативно мобилно приложение.
const Nav = {
  current: "dashboard",
  init() {
    AppState.load();
    history.replaceState({ cdbView: this.current }, "", "#" + this.current);
    window.addEventListener("popstate", (e) => {
      const id = (e.state && e.state.cdbView) || this.current;
      this.showView(id, /*fromHistory*/ true);
    });
    this.showView(this.current, /*fromHistory*/ true);
  },
  showView(id, fromHistory = false) {
    this.current = id;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + id));
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === id));
    if (id === "step2") Step2.syncTitleToVisualizer();
    if (id === "dashboard") Stats.renderDashboard();
    if (id === "stats-analytics") { Stats.renderAnalytics(); TrackRecord.render(); }
    if (id === "set-project") ProjectArchive.render();
    if (id === "set-keys" || id === "set-proxy") Settings.fillFields();
    if (id === "set-keys") { AICallLog.render(); QuotaTracker.render(); }
    if (id === "stats-tracker") Settings.fillFields();
    window.scrollTo(0, 0);
    if (!fromHistory) history.pushState({ cdbView: id }, "", "#" + id);
  }
};

/* ---------- SETTINGS (view-based, no modal) ---------- */
const Settings = {
  // попълва полетата с ключове, когато потребителят отвори която и да е settings страница
  fillFields() {
    const k = Keys.load();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
    set("key_claude", k.claude);
    set("key_gemini", k.gemini);
    set("key_yt_client_id", k.ytClientId);
    set("key_yt_apikey", k.ytApiKey);
    set("key_proxy_url", k.proxyUrl);
    set("gh_owner", k.ghOwner);
    set("gh_repo", k.ghRepo);
    set("gh_branch", k.ghBranch || "main");
    const kt = document.getElementById("keyTestOut");
    if (kt) kt.textContent = "";
    this.populateModelDropdowns();
    this.renderModelPref();
  },

  save() {
    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : undefined; };
    const prev = Keys.load();
    Keys.save({
      ...prev,
      claude: val("key_claude") ?? prev.claude,
      gemini: val("key_gemini") ?? prev.gemini,
      ytClientId: val("key_yt_client_id") ?? prev.ytClientId,
      ytApiKey: val("key_yt_apikey") ?? prev.ytApiKey,
      proxyUrl: ((val("key_proxy_url") ?? prev.proxyUrl) || "").replace(/\/$/, ""),
    });
    toast("Запазено локално 🔒");
    // Бутонът "Вход с Google" се създава само ако ytClientId вече е бил наличен
    // при първоначалното зареждане на страницата — ако е добавен/сменен ТУК,
    // трябва да презаредим Google auth инициализацията, иначе бутонът никога не се появява.
    if (window.google) Step4.initGoogleAuth();
    else setTimeout(() => { if (window.google) Step4.initGoogleAuth(); }, 1500);
  },

  async testKeys() {
    const out = document.getElementById("keyTestOut");
    out.textContent = "⏳ Тествам...";
    const k = {
      claude: document.getElementById("key_claude").value.trim(),
      gemini: document.getElementById("key_gemini").value.trim(),
      ytApiKey: document.getElementById("key_yt_apikey").value.trim(),
    };
    const lines = [];

    // Claude — пробва моделите от fallback списъка ПО РЕД (не само models[0])
    // и хваща ПЪРВИЯ, който реално отговори успешно. Той автоматично става
    // предпочитаният модел за Claude навсякъде в приложението (ModelPref,
    // source: "auto"), докато не бъде презаписан от нов тест или ръчен избор.
    if (!k.claude) lines.push("Claude: ⚪ няма ключ");
    else {
      try {
        // getClaudeModelList вече би избутал предишно ръчно/auto избрания модел
        // на първо място — но тук нарочно тестваме "чист" списък по приоритет,
        // за да проверим наистина всички модели, ако предпочитаният вече не работи.
        const rawModels = await getClaudeModelList(k.claude, true); // forceRefresh
        let found = null;
        const attempts = [];
        for (const testModel of rawModels) {
          try {
            const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": k.claude,
                         "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
              body: JSON.stringify({ model: testModel, max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
            });
            if (r.ok) { found = testModel; break; }
            attempts.push(`${testModel} → ❌ ${r.status}`);
          } catch (e) { attempts.push(`${testModel} → ❌ ${e.message}`); }
        }
        if (found) {
          ModelPref.set("claude", found, "auto");
          lines.push(`Claude: ✅ работи (${found}) — зададен като модел по подразбиране`);
        } else {
          lines.push("Claude: ❌ нито един модел от списъка не отговори" + (attempts.length ? "\n   " + attempts.join("\n   ") : ""));
        }
      } catch (e) { lines.push("Claude: ❌ " + e.message); }
    }

    // Gemini — същият принцип: пробва РЕАЛНО достъпните модели за твоя ключ
    // (виж getGeminiModelList по-горе) един по един, докато някой отговори,
    // и го пази като предпочитание за следващите извиквания.
    if (!k.gemini) lines.push("Gemini: ⚪ няма ключ");
    else {
      try {
        const rawModels = await getGeminiModelList(k.gemini, true); // forceRefresh
        let found = null;
        const attempts = [];
        for (const testModel of rawModels) {
          try {
            const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${k.gemini}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
            });
            if (r.ok) { found = testModel; break; }
            const body = await r.text();
            attempts.push(`${testModel} → ❌ ${r.status} ${body.slice(0, 120)}`);
          } catch (e) { attempts.push(`${testModel} → ❌ ${e.message}`); }
        }
        if (found) {
          ModelPref.set("gemini", found, "auto");
          lines.push(`Gemini: ✅ работи (${found}) — зададен като модел по подразбиране`);
        } else {
          lines.push("Gemini: ❌ нито един модел от списъка не отговори" + (attempts.length ? "\n   " + attempts.join("\n   ") : ""));
        }
      } catch (e) { lines.push("Gemini: ❌ " + e.message); }
    }

    // YouTube Data API key (cheap read-only call)
    if (!k.ytApiKey) lines.push("YouTube API Key: ⚪ няма ключ");
    else {
      try {
        const r = await fetchTimeout(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${k.ytApiKey}`);
        lines.push(r.ok ? "YouTube API Key: ✅ работи" : `YouTube API Key: ❌ ${r.status}`);
      } catch (e) { lines.push("YouTube API Key: ❌ " + e.message); }
    }

    lines.push("YouTube OAuth Client ID: проверява се само при 🔑 Вход с Google в Стъпка 3");
    out.textContent = lines.join("\n");
    // Опресни падащите менюта и текущите "по подразбиране" модели, за да
    // се вижда веднага какво е хванал теста, без да се налага refresh.
    await this.populateModelDropdowns();
    this.renderModelPref();
    return lines;
  },

  // ---------- Ръчен избор на модел (падащо меню в Настройки) ----------
  // Пълни двете падащи менюта (Claude/Gemini) с РЕАЛНО достъпните модели за
  // текущо въведените ключове (или запазените, ако полето е празно), плюс
  // опция "Автоматично" (= fallback ред / последно хванатия при тест).
  async populateModelDropdowns() {
    const saved = Keys.load();
    const claudeKey = (document.getElementById("key_claude")?.value.trim()) || saved.claude;
    const geminiKey = (document.getElementById("key_gemini")?.value.trim()) || saved.gemini;

    const fill = async (selectId, key, listFn, provider) => {
      const sel = document.getElementById(selectId);
      if (!sel || !key) return;
      let models = [];
      try { models = await listFn(key); } catch (e) { return; }
      const pref = ModelPref.get(provider);
      const current = sel.value; // пази текущия избор, ако вече е бил направен в тази сесия
      sel.innerHTML = '<option value="">🔄 Автоматично (fallback ред / последен успешен тест)</option>' +
        models.map(m => `<option value="${m}">${m}</option>`).join("");
      // Ако има ръчно зададено предпочитание, го селектираме; иначе оставяме "Автоматично"
      if (pref && pref.source === "manual" && models.includes(pref.model)) {
        sel.value = pref.model;
      } else if (current && models.includes(current)) {
        sel.value = current;
      } else {
        sel.value = "";
      }
    };

    await Promise.all([
      fill("model_select_claude", claudeKey, getClaudeModelList, "claude"),
      fill("model_select_gemini", geminiKey, getGeminiModelList, "gemini")
    ]);
  },

  // Извиква се при onchange на падащото меню — задава/изчиства ръчното
  // предпочитание за съответния provider и веднага го прилага навсякъде.
  setManualModel(provider, model) {
    if (model) {
      ModelPref.set(provider, model, "manual");
      toast(`✅ ${provider === "claude" ? "Claude" : "Gemini"} модел зададен ръчно: ${model}`);
    } else {
      ModelPref.clear(provider);
      toast(`🔄 ${provider === "claude" ? "Claude" : "Gemini"} — обратно на автоматичен избор`);
    }
    this.renderModelPref();
  },

  // Показва текущо активния модел по подразбиране (и откъде идва — auto тест
  // или ръчен избор) под падащите менюта.
  renderModelPref() {
    const el = document.getElementById("modelPrefOut");
    if (!el) return;
    const label = (p) => {
      const pref = ModelPref.get(p);
      if (!pref) return "автоматично (fallback ред)";
      const src = pref.source === "manual" ? "ръчно избран" : "хванат при тест";
      return `${pref.model} (${src})`;
    };
    el.textContent = `Claude по подразбиране: ${label("claude")}\nGemini по подразбиране: ${label("gemini")}`;
  },

  // Показва РЕАЛНИЯ списък модели, достъпни за твоя Gemini ключ — директно на екрана
  // (без нужда от F12/Console — работи еднакво на телефон и компютър).
  async listGeminiModels() {
    const out = document.getElementById("keyTestOut");
    const gemini = document.getElementById("key_gemini").value.trim();
    if (!gemini) { out.textContent = "⚠️ Първо въведи Gemini API ключ по-горе."; return; }
    out.textContent = "⏳ Зареждам списък с модели...";
    try {
      const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${gemini}`, {}, 15000);
      const data = await r.json();
      if (!r.ok) { out.textContent = "❌ Грешка: " + (data.error?.message || r.status); return; }
      const names = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace("models/", ""));
      out.textContent = names.length
        ? "Модели, достъпни за твоя ключ:\n" + names.join("\n")
        : "Ключът е валиден, но не върна нито един модел за generateContent.";
    } catch (e) {
      out.textContent = "❌ " + e.message;
    }
  },

  // Форсира ново изтегляне на fallback-редицата модели (Gemini + Claude) от
  // техните /models endpoint-и и презаписва localStorage кеша — полезно, ако
  // Google/Anthropic пуснат нов модел или оттеглят стар, без да чакаш
  // GEMINI_MODELS_CACHE_HOURS/CLAUDE_MODELS_CACHE_HOURS да изтекат сами.
  async refreshModelLists() {
    const out = document.getElementById("keyTestOut");
    const gemini = document.getElementById("key_gemini").value.trim() || Keys.load().gemini;
    const claude = document.getElementById("key_claude").value.trim() || Keys.load().claude;
    if (!gemini && !claude) { out.textContent = "⚠️ Нужен е поне един ключ (Gemini или Claude) по-горе."; return; }
    out.textContent = "⏳ Обновявам списъците с модели...";
    const lines = [];
    if (gemini) {
      try {
        const models = await getGeminiModelList(gemini, true);
        lines.push("Gemini fallback ред: " + models.join(" → "));
      } catch (e) { lines.push("Gemini: ❌ " + e.message); }
    }
    if (claude) {
      try {
        const models = await getClaudeModelList(claude, true);
        lines.push("Claude fallback ред: " + models.join(" → "));
      } catch (e) { lines.push("Claude: ❌ " + e.message); }
    }
    out.textContent = lines.join("\n");
    toast("Списъците с модели са обновени 🔄");
    await this.populateModelDropdowns();
    this.renderModelPref();
  },

  // Export/Import САМО на API ключовете (отделно от "Export проект" по-долу,
  // защото ключовете са чувствителна информация — с изричен предупредителен
  // confirm() и преди export, и преди import).
  exportKeys() {
    const k = Keys.load();
    if (!Object.keys(k).length) { toast("⚠️ Няма запазени ключове за export."); return; }
    if (!confirm("Файлът ще съдържа API ключовете ти в ЧИСТ ТЕКСТ (незашифровани). Пази го на сигурно място, не го споделяй и не го качвай в GitHub/облак без защита. Продължаваш ли?")) return;
    const blob = new Blob([JSON.stringify(k, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "cdb-api-keys-backup.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Export на ключовете готов ⬇️ — пази файла на сигурно място!");
  },

  importKeys(file) {
    if (!file) return;
    if (!confirm("Това ще ПРЕЗАПИШЕ текущите ти API ключове с тези от избрания файл. Продължаваш ли?")) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        Keys.save({ ...Keys.load(), ...parsed });
        this.fillFields();
        toast("Ключовете са импортирани ✅");
      } catch (e) {
        toast("❌ Грешка при импорт: " + e.message);
      }
    };
    reader.readAsText(file);
  },

  // Тиха версия на testKeys, викана автоматично при зареждане (ако е включено в Предпочитания).
  // Не пипа UI-полета — работи директно със запазените ключове, показва само кратък статус горе.
  async silentHealthCheck() {
    const k = Keys.load();
    const dot = document.getElementById("validatorStatusDot");
    const txt = document.getElementById("validatorStatusText");
    if (!k.gemini && !k.claude) {
      if (txt) txt.textContent = "Няма ключове";
      if (dot) dot.style.background = "var(--amber)";
      return;
    }
    try {
      if (k.gemini) {
        const models = await getGeminiModelList(k.gemini); // ползва кеша, не форсира refresh при всяко зареждане
        const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${models[0]}:generateContent?key=${k.gemini}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
        });
        if (!r.ok) throw new Error("Gemini ключ не работи (" + r.status + ")");
      }
      if (txt) txt.textContent = "Всички системи активни";
      if (dot) dot.style.background = "var(--green)";
    } catch (e) {
      if (txt) txt.textContent = "Провери ключовете";
      if (dot) dot.style.background = "var(--red)";
      toast("⚠️ " + e.message + " — виж Настройки → API Ключове");
    }
  },

  exportProject() {
    const blob = new Blob([JSON.stringify(AppState.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const name = (AppState.data.project.title || "cdb-project").replace(/[^a-z0-9а-я_-]+/gi, "_");
    a.href = url; a.download = `${name}-backup.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Export готов ⬇️");
  },

  importProject(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.project) throw new Error("Файлът не изглежда като валиден проект");
        AppState.data = parsed;
        AppState.save();
        GeminiValidator.render();
        Stats.renderDashboard();
        toast("Проектът е импортиран ✅");
      } catch (e) {
        toast("❌ Грешка при импорт: " + e.message);
      }
    };
    reader.readAsText(file);
  },

  newProject() {
    if (!confirm("Сигурен ли си? Това ще изчисти текущия проект (заглавие, текст, лог). Ключовете НЕ се пипат.")) return;
    // Автоматично архивираме текущия проект, преди да го изтрием — нищо не се губи безвъзвратно.
    if (AppState.data.project.title || AppState.data.project.lyrics) {
      ProjectArchive.saveCurrent();
    }
    localStorage.removeItem(STORAGE_KEY);
    AppState.load();
    GeminiValidator.render();
    Stats.renderDashboard();
    const nr = document.getElementById("nicheResults"); if (nr) nr.innerHTML = "";
    const cc = document.getElementById("conceptCard"); if (cc) cc.style.display = "none";
    const lo = document.getElementById("lyricsOut"); if (lo) lo.value = "";
    toast("Нов, чист проект 🆕 (старият е в Архива)");
  }
};

/* =========================================================
   PROJECT ARCHIVE — история от предишни песни
   "Нов проект" вече не изтрива безвъзвратно — старият проект се
   архивира автоматично. Може и ръчно да запазиш текущия по всяко
   време, за да сравняваш Viral Score между песни във времето.
   ========================================================= */
const ARCHIVE_STORAGE = "cdb_dashboard_archive_v1";
const ProjectArchive = {
  load() {
    const raw = localStorage.getItem(ARCHIVE_STORAGE);
    return raw ? JSON.parse(raw) : [];
  },
  saveAll(list) {
    localStorage.setItem(ARCHIVE_STORAGE, JSON.stringify(list.slice(0, 30)));
  },

  saveCurrent() {
    const p = AppState.data.project;
    if (!p.title && !p.lyrics) return toast("Няма какво да се архивира — проектът е празен");
    const list = this.load();
    list.unshift({
      id: Date.now(),
      date: new Date().toLocaleDateString("bg-BG"),
      title: p.title || "(без заглавие)",
      niche: p.chosenNiche || "",
      viralScore: p.viralReport?.viral_score ?? null,
      snapshot: AppState.data // пълен запис — може да се "зареди" обратно 1:1
    });
    this.saveAll(list);
    toast("Проектът е архивиран 💾");
    this.render();
  },

  render() {
    const el = document.getElementById("projectArchiveOut");
    if (!el) return;
    const list = this.load();
    if (!list.length) { el.innerHTML = `<p class="muted">Архивът е празен — запази текущия проект или направи "Нов проект" (архивира автоматично).</p>`; return; }
    el.innerHTML = list.map((it, i) => `
      <div class="copy-field">
        <span><strong>${it.title}</strong> <span class="muted">· ${it.niche || "—"} · ${it.date}</span>
          ${it.viralScore != null ? `<br><span class="muted">Viral Score: <strong>${it.viralScore}</strong></span>` : ""}</span>
        <button onclick="ProjectArchive.loadItem(${i})">📂 Зареди</button>
        <button onclick="ProjectArchive.remove(${i})">🗑️</button>
      </div>`).join("");
  },

  loadItem(i) {
    const list = this.load();
    const it = list[i];
    if (!it) return;
    if (!confirm(`Зареди "${it.title}"? Текущият (незапазен) проект ще бъде презаписан.`)) return;
    AppState.data = it.snapshot;
    AppState.save();
    GeminiValidator.render();
    Stats.renderDashboard();
    toast(`Зареден проект: ${it.title}`);
  },

  remove(i) {
    const list = this.load();
    list.splice(i, 1);
    this.saveAll(list);
    this.render();
  }
};

/* =========================================================
   API HELPERS
   ========================================================= */

// Ако е зададен Proxy URL в Настройки, минаваме заявките през него
// (полезно при CORS грешки, напр. с някои Imagen endpoint-и).
// Прокси-то се очаква да приема ?target=ORIGINAL_URL и да препраща
// метод/хедъри/тяло 1:1 към него.
// fetch с вграден timeout — без това, при лоша/нестабилна мрежа (особено на телефон)
// заявката може да увисне БЕЗКРАЙНО (нито успех, нито грешка), и spinner-ът никога не спира.
async function fetchTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Заявката отне повече от ${ms / 1000}с и беше прекратена (провери мрежата)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function proxied(url) {
  const k = Keys.load();
  if (!k.proxyUrl) return url;
  return `${k.proxyUrl}?target=${encodeURIComponent(url)}`;
}

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

/* =========================================================
   Общ helper за всички Gemini заявки (текст и multimodal).
   Пробва моделите, върнати от getGeminiModelList(), по ред. За текущия модел прави
   кратък retry с exponential backoff при 429 (временен rate-limit).
   Ако след тези опити моделът ВСЕ ОЩЕ е на 429 (обикновено = изчерпана
   дневна квота, не временен rate-limit), автоматично минава на СЛЕДВАЩИЯ
   модел от списъка — с ясен toast, за да се разбира какво реално е
   генерирало отговора. Само ако всички модели са изчерпани, гърми грешка.
   Грешки, различни от 429 (невалиден ключ/prompt и т.н.), спират веднага
   без да пробват други модели, защото смяна на модела няма да ги реши.
   ========================================================= */
async function callGeminiWithFallback(body, apiKey, timeoutMs = 45000) {
  const models = await getGeminiModelList(apiKey);
  let lastError;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const maxRetries = 2;
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
          const waitMs = 2000 * Math.pow(2, attempt); // 2s, 4s
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

      // грешка, различна от квота — няма смисъл да пробваме друг модел
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

/* =========================================================
   CALL AI — единна точка за генериране на съдържание (Стъпка 1-3).
   Избира Claude или Gemini според Prefs.data.contentProvider
   (превключвател горе вдясно / Настройки → Предпочитания).
   Ако избраният провайдър гръмне грешка (напр. изчерпан Claude
   абонамент/квота) И другият провайдър има зареден ключ, автоматично
   пада на него вместо да чупи целия flow — с ясен toast, за да знаеш
   какво реално те е генерирало съдържанието.
   ЗАБЕЛЕЖКА: Gemini Validator-ът (autoReview и т.н.) НЕ минава през
   тази функция — той нарочно винаги е Gemini, като "втори, независим
   поглед" върху резултата, дори когато Gemini е и основният генератор.
   ========================================================= */
async function callAI(prompt, maxTokens = 1200) {
  const k = Keys.load();
  const provider = Prefs.data.contentProvider || "claude";
  const other = provider === "claude" ? "gemini" : "claude";
  const hasKey = { claude: !!k.claude, gemini: !!k.gemini };

  const run = (p) => p === "claude" ? callClaude(prompt, maxTokens) : callGemini(prompt);

  try {
    return await run(provider);
  } catch (e) {
    if (hasKey[other]) {
      toast(`⚠️ ${provider === "claude" ? "Claude" : "Gemini"} гръмна (${e.message}) — превключвам на ${other === "claude" ? "Claude" : "Gemini"} за тази заявка...`, 4000);
      return await run(other);
    }
    throw e;
  }
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

// Превръща File/Blob в base64 текст (без "data:...;base64," префикса) — нужно за inline_data.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Неуспешно четене на файла"));
    reader.readAsDataURL(file);
  });
}

// Извлича първия валиден JSON блок (масив или обект) от текст, дори ако
// моделът е добавил коментари/цитати около него (случва се с grounded search).
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "");
  const startArr = cleaned.indexOf("[");
  const startObj = cleaned.indexOf("{");
  let start = -1, isArr = false;
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) { start = startArr; isArr = true; }
  else if (startObj !== -1) { start = startObj; isArr = false; }
  if (start === -1) throw new Error("Няма JSON в отговора на модела");
  const end = isArr ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (end === -1 || end < start) throw new Error("Непълен JSON в отговора на модела");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* =========================================================
   GEMINI VALIDATOR — малък модул за "втори поглед"
   Автоматично прави бърз анализ на резултата от ВСЯКА стъпка
   (без да чака потребителя да натисне бутон), и трупа лог.
   ========================================================= */
const GeminiValidator = {
  // fire-and-forget: не блокира основния workflow, ако Gemini ключ липсва/грешка
  autoReview(stepLabel, content) {
    this.review(stepLabel, content)
      .then(text => this._log(stepLabel, text))
      .catch(e => this._log(stepLabel, "⚠️ Пропуснат авто-анализ: " + e.message));
  },

  async review(stepLabel, content) {
    const prompt = `Ти си "втори поглед" (validator) в музикален production pipeline.
Стъпка: "${stepLabel}"
Съдържание за анализ:
---
${content}
---
Дай МАКСИМУМ 3 кратки изречения: (1) бърза оценка има ли проблем/риск,
(2) дали е готово за следваща стъпка, (3) ако не, кратка препоръка.
Пиши директно, без встъпление.`;
    return await callGemini(prompt);
  },

  _log(stepLabel, text) {
    const entry = { label: stepLabel, time: new Date().toLocaleTimeString("bg-BG"), text };
    AppState.data.project.geminiLog = AppState.data.project.geminiLog || [];
    AppState.data.project.geminiLog.unshift(entry);
    AppState.data.project.geminiLog = AppState.data.project.geminiLog.slice(0, 20);
    AppState.save();
    this.render();
  },

  render() {
    const el = document.getElementById("geminiOut");
    const log = (AppState.data.project.geminiLog || []);
    const countChip = document.getElementById("dashValidatorCount");
    if (countChip) countChip.textContent = log.length;
    if (!el) return;
    if (!log.length) { el.textContent = "Все още няма анализи — ще се появят автоматично след всяка стъпка."; return; }
    el.innerHTML = log.map(e =>
      `<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
        <strong>${e.label}</strong> <span class="muted">· ${e.time}</span><br>${e.text}
      </div>`).join("");
  }
};

/* =========================================================
   YOUTUBE TRENDING POOL (споделена, времево-ограничена основа)
   ---------------------------------------------------------
   ВАЖНО — тук преди имаше бъг: старите youtubeTopTitles() и
   youtubeOutlierScan() търсеха с order=viewCount БЕЗ никакъв
   времеви филтър, което значи "най-гледаните видеа за цялото
   съществуване на YouTube" по темата — не това, което реално
   трендва СЕГА. Резултатът: стари вирусни хитове изглеждаха
   като "актуален тренд" и това пряко влизаше в контекста за
   генериране на нови песни (ViralLab genreGrounding) — грешен
   сигнал → грешни песни.

   Този helper:
   1. Търси само видеа, публикувани в скорошен прозорец от време
      (publishedAfter), НЕ цялата история на YouTube.
   2. Ако прозорецът е твърде тесен за дадена ниша (малко скорошни
      видеа), прогресивно го разширява (30 → 60 → 120 → 180 дни) —
      НИКОГА не пада обратно на "без филтър", защото точно това
      беше бъгът. Ако дори 180 дни не дадат достатъчно данни,
      връща insufficientData=true, за да може UI/промптът честно
      да каже "няма достатъчно скорошни данни", вместо тихо да
      подаде подвеждаща информация.
   3. Смята view VELOCITY (гледания / дни от публикуването) — това
      е истинският "trending сега" сигнал: видео на 3 дни с 50k
      views трендва много по-силно от видео на 2 години с 500k.
      Сортирането по velocity, не по абсолютни views, е това, което
      прави разликата между "стар хит" и "реален тренд днес".
   ========================================================= */
async function fetchRecentTrendingVideos(query, opts = {}) {
  const k = Keys.load();
  const maxResults = opts.maxResults || 25;
  const minResults = opts.minResults || 6;
  if (!k.ytApiKey) return { videos: [], windowDays: null, insufficientData: true, noKey: true };

  const windows = [30, 60, 120, 180]; // дни — прогресивно разширяване, никога "без филтър"
  let items = [];
  let usedWindow = windows[windows.length - 1];

  for (const days of windows) {
    const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=${maxResults}&publishedAfter=${encodeURIComponent(publishedAfter)}&q=${encodeURIComponent(query)}&key=${k.ytApiKey}`;
    const sRes = await fetchTimeout(proxied(searchUrl));
    if (!sRes.ok) throw new Error("YouTube search грешка: " + (await sRes.text()));
    const sData = await sRes.json();
    items = sData.items || [];
    usedWindow = days;
    if (items.length >= minResults) break;
  }

  if (!items.length) return { videos: [], windowDays: usedWindow, insufficientData: true };

  const videoIds = items.map(i => i.id.videoId).filter(Boolean);
  const channelIds = [...new Set(items.map(i => i.snippet.channelId))];
  if (!videoIds.length) return { videos: [], windowDays: usedWindow, insufficientData: true };

  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds.join(",")}&key=${k.ytApiKey}`;
  const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds.join(",")}&key=${k.ytApiKey}`;
  const [vRes, cRes] = await Promise.all([fetchTimeout(proxied(videosUrl)), fetchTimeout(proxied(channelsUrl))]);
  if (!vRes.ok) throw new Error("YouTube videos.list грешка: " + (await vRes.text()));
  if (!cRes.ok) throw new Error("YouTube channels.list грешка: " + (await cRes.text()));
  const vData = await vRes.json();
  const cData = await cRes.json();

  const statsById = {};
  (vData.items || []).forEach(v => statsById[v.id] = v);
  const subsById = {};
  (cData.items || []).forEach(c => subsById[c.id] = parseInt(c.statistics?.subscriberCount || "0", 10));

  const now = Date.now();
  const videos = items.map(i => {
    const stat = statsById[i.id.videoId];
    const views = parseInt(stat?.statistics?.viewCount || "0", 10);
    const publishedAt = stat?.snippet?.publishedAt || i.snippet.publishedAt;
    // мин. 0.5 дни, за да не гърми velocity до безкрайност за видеа отпреди часове
    const ageDays = Math.max((now - new Date(publishedAt).getTime()) / 86400000, 0.5);
    const subs = subsById[i.snippet.channelId] || 0;
    return {
      videoId: i.id.videoId,
      title: i.snippet.title,
      channel: i.snippet.channelTitle,
      channelId: i.snippet.channelId,
      views, subs,
      publishedAt,
      ageDays: Math.round(ageDays * 10) / 10,
      velocity: Math.round(views / ageDays), // гледания/ден — реалният "трендва СЕГА" сигнал
      ratio: views / Math.max(subs, 1),
    };
  });

  videos.sort((a, b) => b.velocity - a.velocity);
  return { videos, windowDays: usedWindow, insufficientData: videos.length < minResults };
}

/* Жанрово заземяване за ViralLab: заглавия на видеа, които РЕАЛНО
   набират инерция точно сега (по velocity), не всички-времена топ. */
async function youtubeTopTitles(query, max = 12) {
  try {
    const { videos } = await fetchRecentTrendingVideos(query, { maxResults: max, minResults: 5 });
    return videos.slice(0, max).map(v => v.title).filter(Boolean);
  } catch (e) {
    return []; // тихо пропускаме — ViralLab пада обратно на model knowledge
  }
}

/* VidIQ-стил "outlier": малък канал (<10k абонати), чието скорошно
   видео вече расте непропорционално бързо — реален сигнал за
   органичен пробив СЕГА, изчислен само от скорошния прозорец. */
async function youtubeOutlierScan(query) {
  const k = Keys.load();
  if (!k.ytApiKey) throw new Error("Няма YouTube Data API Key (виж Настройки)");

  const { videos, windowDays, insufficientData } = await fetchRecentTrendingVideos(query, { maxResults: 25, minResults: 6 });
  if (!videos.length) return { outliers: [], totalChecked: 0, windowDays, insufficientData: true };

  const outliers = videos
    .filter(v => (v.ratio > 15 && v.views > 3000) || (v.subs < 10000 && v.views > 20000))
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 5);

  return { outliers, totalChecked: videos.length, windowDays, insufficientData };
}

/* =========================================================
   KEYWORD SUGGESTIONS (musicalSEO-подобен ефект)
   Ползва неофициалния Google/YouTube autocomplete suggest
   endpoint — показва какво реално дописва/търси аудиторията.
   ИЗИСКВА Proxy URL в Настройки (endpoint-ът няма CORS хедъри).
   ========================================================= */
async function keywordSuggest(query) {
  const k = Keys.load();
  if (!k.proxyUrl) throw new Error("Изисква се Proxy URL в Настройки за тази функция (виж бележката в Настройки)");
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
  const res = await fetchTimeout(proxied(url));
  if (!res.ok) throw new Error("Suggest заявка неуспешна: " + res.status);
  const data = await res.json();
  return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 10) : [];
}


/* =========================================================
   LYRICS HISTORY — версии на текста
   Пази предишните версии (при ново генериране или при "Подобри"
   от ViralLab), за да може да се върнеш назад, ако подобрението
   всъщност не е по-добро.
   ========================================================= */
const LyricsHistory = {
  push(label) {
    const current = (document.getElementById("lyricsOut")?.value || "").trim();
    if (!current) return;
    const p = AppState.data.project;
    p.lyricsHistory = p.lyricsHistory || [];
    p.lyricsHistory.unshift({ label, text: current, time: new Date().toLocaleTimeString("bg-BG") });
    p.lyricsHistory = p.lyricsHistory.slice(0, 15);
    AppState.save();
  },

  render() {
    const el = document.getElementById("lyricsHistoryOut");
    if (!el) return;
    const hist = AppState.data.project.lyricsHistory || [];
    if (!hist.length) { el.innerHTML = `<p class="muted">Все още няма запазени версии.</p>`; return; }
    el.innerHTML = hist.map((v, i) => `
      <div class="copy-field"><span><strong>${v.label}</strong> <span class="muted">· ${v.time}</span><br>
        <span class="muted">${v.text.slice(0, 90).replace(/\n/g, " ")}${v.text.length > 90 ? "…" : ""}</span></span>
        <button onclick="LyricsHistory.revert(${i})">↩️ Върни</button></div>`).join("");
  },

  toggle() {
    const el = document.getElementById("lyricsHistoryOut");
    if (!el) return;
    const showing = el.style.display !== "none";
    if (showing) { el.style.display = "none"; return; }
    el.style.display = "block";
    this.render();
  },

  revert(i) {
    const hist = AppState.data.project.lyricsHistory || [];
    const v = hist[i];
    if (!v) return;
    this.push("Преди връщане назад");
    document.getElementById("lyricsOut").value = v.text;
    AppState.data.project.lyrics = v.text;
    AppState.save();
    toast(`Върнато към версия "${v.label}"`);
    this.render();
  }
};

const Step1 = {
  // Главен бутон "🔍 Предложение за песен".
  // Ако textarea-та е празна → чете готовите daily trend данни от GitHub (безплатно, без Gemini).
  // Ако потребителят е въвел свои ниши → сравнява точно тях (Claude, старото поведение).
  async scanNiches() {
    const raw = document.getElementById("nicheInput").value.trim();
    if (raw) return this._scoreGivenNiches(raw.split("\n").map(s => s.trim()).filter(Boolean));
    return this._autoTrendScan();
  },

  // Чете data/trends-history.json от GitHub (пише го .github/workflows/daily-trends.yml,
  // веднъж на ден, през pytrends + YouTube Data API — БЕЗ Gemini, БЕЗ live-search квота).
  async _autoTrendScan() {
    const out = document.getElementById("nicheResults");
    out.innerHTML = "⏳ Зареждам вчерашния/днешния trend snapshot...";
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) {
      out.innerHTML = "⚠️ Нужен е GitHub Trend Tracker setup (Настройки → YouTube Тракер — същите ghOwner/ghRepo поля) " +
        "+ пуснат поне веднъж <code>daily-trends.yml</code> workflow (Actions таб → Run workflow).<br>" +
        "<span class='muted'>Дотогава: въведи 2-3 ниши ръчно в полето отгоре.</span>";
      return;
    }

    const branch = k.ghBranch || "main";
    const url = `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/trends-history.json`;
    try {
      const res = await fetchTimeout(url, {}, 15000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const snapshots = data.snapshots || [];
      if (!snapshots.length) {
        out.innerHTML = "⚠️ Файлът съществува, но е празен — workflow-ът още не се е пуснал. " +
          "Actions таб → \"Daily Music Trend Tracker\" → Run workflow (ръчно, за да не чакаш до утре).";
        return;
      }
      const latest = snapshots[snapshots.length - 1];
      const results = latest.niches || [];
      if (!results.length) {
        out.innerHTML = "⚠️ Последният snapshot няма ниши с пълни данни (Trends/YouTube грешка онзи ден). Пробвай ръчно въведени ниши.";
        return;
      }
      out.innerHTML = `<p class="muted">📅 Snapshot от ${latest.date} (обновява се веднъж на ден)</p>`;
      this._renderNicheResults(results, true);
    } catch (e) {
      out.innerHTML = "❌ " + e.message +
        "<br><span class='muted'>Провери дали repo-то е публично и daily-trends.yml вече е пускан поне веднъж. " +
        "Дотогава: въведи 2-3 ниши ръчно в полето отгоре и натисни бутона пак.</span>";
    }
  },

  // Старото поведение: потребителят подава списък сам, Claude ги оценява.
  async _scoreGivenNiches(niches) {
    document.getElementById("nicheResults").innerHTML = "⏳ Анализирам...";
    const prompt = `Ти си музикален A&R / SEO анализатор за 2026 година.
Дадени са следните музикални ниши/жанрове:
${niches.map((n, i) => `${i + 1}. ${n}`).join("\n")}

За всяка ниша дай:
- Score от 0 до 100 (комбинация от търсене и ниска конкуренция)
- Кратка причина (1 изречение)

Върни ЧИСТ JSON масив без обяснения, формат:
[{"niche":"...", "score":number, "reason":"..."}]`;

    try {
      const raw2 = await callAI(prompt, 600);
      const results = extractJson(raw2);
      results.sort((a, b) => b.score - a.score);
      this._renderNicheResults(results, false);
      GeminiValidator.autoReview("Стъпка 1 — Сравнение на ниши", JSON.stringify(results));
    } catch (e) {
      document.getElementById("nicheResults").innerHTML = "❌ " + e.message;
    }
  },

  async _renderNicheResults(results, fromTrendScan) {
    const best = results[0];
    AppState.data.project.niches = results;
    AppState.data.project.chosenNiche = best.niche;
    AppState.data.project.nicheScore = best.score;
    AppState.save();

    let html = fromTrendScan ? `<p class="muted">📈 Дневен trend snapshot (GitHub Actions, без Gemini)</p>` : "";
    results.forEach(r => {
      const color = r.score > 75 ? "🟢" : r.score > 50 ? "🟡" : "⚪";
      const signals = (r.search_signal || r.competition_signal)
        ? `<br><span class="muted">Търсене: ${r.search_signal || "—"} · Конкуренция: ${r.competition_signal || "—"}</span>` : "";
      html += `<div class="copy-field"><span>${color} <strong>${r.niche}</strong> — ${r.score}/100<br><span class="muted">${r.reason}</span>${signals}</span></div>`;
    });
    document.getElementById("nicheResults").innerHTML = html;
    this._renderDashNicheQuick(results);

    document.getElementById("conceptCard").style.display = "block";
    document.getElementById("nicheScore").value = best.score + "/100";

    if (best.score > 75) {
      toast(`🟢 Най-добра ниша: ${best.niche} (${best.score}/100)`);
    } else {
      toast(`Най-добър резултат ${best.score}/100 — под прага 75, но може да продължиш ръчно.`);
    }
    document.getElementById("albumSprintCard").style.display = "block";
    this.runOutlierScan(best.niche);
    this.runKeywordSuggest(best.niche);
    await this.generateConcept(best.niche);

    // Автопилот (опционален, изключен по подразбиране — виж Настройки → Предпочитания):
    // верижно продължава автоматично към текст на песента + Viral Lab анализ,
    // за да не чакаш ръчно всяка стъпка. Винаги ясно съобщено с toast.
    if (Prefs.data.autopilot) {
      toast("🤖 Автопилот: генерирам текст + Viral анализ автоматично...", 4000);
      await this.generateLyrics();
      await ViralLab.analyze();
    }
  },

  // Малка карта-версия на резултатите за Dashboard-а (Бърз изглед).
  _renderDashNicheQuick(results) {
    const el = document.getElementById("dashNicheQuick");
    if (!el) return;
    el.innerHTML = results.slice(0, 4).map(r => {
      const level = r.score > 75 ? ["🟢", "Висок потенциал"] : r.score > 50 ? ["🟡", "Среден потенциал"] : ["⚪", "Нисък потенциал"];
      return `<div class="card tight"><strong style="font-size:13px;">${r.niche}</strong>
        <p class="muted" style="margin:8px 0 0;">${level[0]} ${level[1]}</p></div>`;
    }).join("");
  },

  // VidIQ-стил "outlier" анализ: канали с малко абонати, но много гледания в тази ниша.
  async runOutlierScan(niche) {
    const el = document.getElementById("outlierResults");
    el.innerHTML = "⏳ Проверявам YouTube outliers (само скорошни видеа)...";
    try {
      const { outliers, totalChecked, windowDays, insufficientData } = await youtubeOutlierScan(niche);
      const windowNote = windowDays ? `последните ${windowDays} дни` : "скорошния период";
      if (!outliers.length) {
        const warn = insufficientData
          ? ` ⚠️ Малко скорошни видеа намерени за тази ниша — сигналът е слаб, не разчитай само на него.`
          : "";
        el.innerHTML = `<p class="muted">📊 Провери ${totalChecked} видеа за "${niche}" (${windowNote}) — няма ясни outliers.${warn}</p>`;
        return;
      }
      let html = `<strong style="font-size:13px;">📊 YouTube Outliers за "${niche}"</strong><p class="muted">Малки канали с видео, което расте непропорционално бързо ПРЯВО СЕГА (${windowNote}, ${totalChecked} видеа проверени):</p>`;
      if (insufficientData) {
        html += `<p class="muted">⚠️ Скорошните данни за тази ниша са оскъдни — третирай тези резултати с повишено внимание.</p>`;
      }
      outliers.forEach(o => {
        html += `<div class="copy-field"><span><strong>${o.channel}</strong> — ${o.views.toLocaleString()} views / ${o.subs.toLocaleString()} абонати (×${o.ratio.toFixed(1)}) · ${o.ageDays}д от публикуване · ~${o.velocity.toLocaleString()} views/ден<br><span class="muted">${o.title}</span></span></div>`;
      });
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<p class="muted">📊 Outlier анализ пропуснат: ${e.message}</p>`;
    }
  },

  // "Хората също търсят" — реални autocomplete предложения (нужен Proxy URL).
  async runKeywordSuggest(niche) {
    const el = document.getElementById("keywordSuggestOut");
    el.innerHTML = "⏳ Проверявам свързани търсения...";
    try {
      const suggestions = await keywordSuggest(niche);
      if (!suggestions.length) { el.innerHTML = ""; return; }
      el.innerHTML = `<strong style="font-size:13px;">🔎 Хората също търсят</strong>
        <div class="hashtags">${suggestions.map(s => `<span>${s}</span>`).join("")}</div>`;
    } catch (e) {
      el.innerHTML = `<p class="muted">🔎 Свързани търсения пропуснати: ${e.message}</p>`;
    }
  },

  // "Album Sprint" — 10-30 заглавия+hook идеи наведнъж в избраната ниша (batch мета-промптиране).
  async generateAlbumSprint() {
    const niche = AppState.data.project.chosenNiche || "modern pop";
    const count = document.getElementById("albumSprintCount").value;
    document.getElementById("albumSprintOut").innerHTML = "⏳ Генерирам...";
    const prompt = `За музикалната ниша "${niche}" генерирай ${count} РАЗЛИЧНИ концепции за песни.
За всяка концепция дай:
- title: кратко заглавие (до 3 думи)
- hook: 1 ред от потенциален chorus/hook, звучащ естествено за жанра
- mood: 2-3 думи атмосфера

Всички трябва да пасват на нишата, но да звучат различно едно от друго (не повтаряй теми).
Върни ЧИСТ JSON масив: [{"title":"...", "hook":"...", "mood":"..."}]`;
    try {
      const raw = await callAI(prompt, 2400);
      const list = extractJson(raw);
      AppState.data.project.albumSprint = list;
      AppState.save();
      this._renderAlbumSprint(list, null);
      GeminiValidator.autoReview("Стъпка 1 — Album Sprint", JSON.stringify(list));
      this._scoreAlbumSprint(list, niche);
    } catch (e) {
      document.getElementById("albumSprintOut").innerHTML = "❌ " + e.message;
    }
  },

  // Лек, бърз "quick score" (само по заглавие+hook+mood, без пълен текст) за ВСИЧКИ
  // идеи наведнъж — за да видиш кое си струва да напишеш преди да похарчиш
  // token-и/време за пълни текстове на слаби идеи.
  async _scoreAlbumSprint(list, niche) {
    const prompt = `Ти си A&R анализатор. Дадени са ${list.length} концепции за песни в жанр "${niche}"
(само заглавие+hook+mood, текстовете още не са написани). За всяка дай quick_score 0-100
(бърза прогноза за вирусен потенциал само на база тези 3 неща — hook сила, оригиналност, жанрово пасване).
${list.map((c, i) => `${i + 1}. "${c.title}" — "${c.hook}" (${c.mood})`).join("\n")}

Върни ЧИСТ JSON масив в СЪЩИЯ ред: [{"quick_score": number}]`;
    try {
      const raw = await callAI(prompt, 800);
      const scores = extractJson(raw);
      this._renderAlbumSprint(list, scores);
    } catch (e) {
      // Тихо пропускаме — списъкът вече е видим и без quick score.
    }
  },

  _renderAlbumSprint(list, scores) {
    const withScores = list.map((c, i) => ({ ...c, _i: i, quick_score: scores?.[i]?.quick_score ?? null }));
    if (scores) withScores.sort((a, b) => (b.quick_score ?? 0) - (a.quick_score ?? 0));
    let html = scores ? `<p class="muted">Сортирано по прогнозиран потенциал (само по идея, преди пълен текст):</p>` : "";
    withScores.forEach(c => {
      const badge = c.quick_score != null
        ? `<span class="chip ${c.quick_score > 75 ? "green" : c.quick_score > 50 ? "cyan" : "amber"}" style="margin-left:6px;">${c.quick_score}</span>`
        : "";
      html += `<div class="copy-field"><span><strong>${c.title}</strong>${badge} <span class="muted">(${c.mood})</span><br>"${c.hook}"</span>
        <button onclick="Step1.useAlbumIdea(${c._i})">➡️ Ползвай</button></div>`;
    });
    document.getElementById("albumSprintOut").innerHTML = html;
  },

  // Взима избрана идея от Album Sprint-а и я праща в основната концепция.
  useAlbumIdea(i) {
    const c = (AppState.data.project.albumSprint || [])[i];
    if (!c) return;
    document.getElementById("songTitle").value = c.title;
    AppState.data.project.title = c.title;
    AppState.save();
    toast(`Заглавие сменено на "${c.title}" — hook-а може да вкараш ръчно в текста`);
  },

  async generateConcept(niche) {
    const prompt = `За музикалната ниша "${niche}" за 2026 генерирай:
1. Кратко, запомнящо се заглавие на песен (на български или английски, каквото пасва на жанра)
2. Style Prompt за Suno AI (детайлен, максимум 200 символа, описващ звук/настроение/инструменти)
3. Точно 3 хаштага (с #, релевантни за YouTube/TikTok/Instagram)

Върни ЧИСТ JSON: {"title":"...", "style_prompt":"...", "hashtags":["#...","#...","#..."]}`;
    try {
      const raw = await callAI(prompt, 400);
      const c = extractJson(raw);
      document.getElementById("songTitle").value = c.title;
      document.getElementById("stylePrompt").value = c.style_prompt;
      document.getElementById("hashtagsOut").innerHTML = c.hashtags.map(h => `<span>${h}</span>`).join("");

      AppState.data.project.title = c.title;
      AppState.data.project.stylePrompt = c.style_prompt;
      AppState.data.project.hashtags = c.hashtags;
      AppState.save();

      GeminiValidator.autoReview("Стъпка 1 — Концепция (заглавие/стил/хаштагове)", JSON.stringify(c));
    } catch (e) {
      toast("Грешка при генериране на концепция: " + e.message);
    }
  },

  async generateLyrics() {
    const niche = AppState.data.project.chosenNiche || "modern pop";
    const title = AppState.data.project.title || "(без заглавие)";
    const winningHook = AppState.data.project.winningHook;
    const prompt = `Напиши текст на песен в жанр "${niche}", със заглавие "${title}".
ЗАДЪЛЖИТЕЛНО:
- [Chorus] секцията да е НАЙ-ОТПРЕД (преди първия куплет)
- Използвай ясни мета-тагове: [Chorus], [Verse], [Drop] (ако жанрът позволява drop)
- Текстът да е готов за качване в Suno AI
${winningHook ? `- Използвай ТОЧНО този ред като основен hook/първи ред на [Chorus] (дошъл е от Hook Evolution Arena, тестван и избран): "${winningHook}"` : ""}
Върни само текста с таговете, без допълнителни обяснения.`;
    LyricsHistory.push("Преди ново генериране");
    document.getElementById("lyricsOut").value = "⏳ Генерирам...";
    try {
      const lyrics = await callAI(prompt, 1400);
      document.getElementById("lyricsOut").value = lyrics;
      AppState.data.project.lyrics = lyrics;
      AppState.save();

      GeminiValidator.autoReview("Стъпка 1 — Текст на песента", lyrics);
    } catch (e) {
      document.getElementById("lyricsOut").value = "";
      toast("Грешка: " + e.message);
    }
  },

  // Ръчно повторно/задълбочено валидиране на текста (по избор — авто-анализът вече тръгва сам).
  async validateWithGemini() {
    const lyrics = document.getElementById("lyricsOut").value;
    const niche = AppState.data.project.chosenNiche || "";
    if (!lyrics.trim()) return toast("Първо генерирай текст на песента");
    const prompt = `Анализирай следния текст на песен за жанр "${niche}".
Дай честна, кратка оценка (5-8 изречения) на:
- качеството и логиката на римите
- дали пасва на жанра
- структурата (има ли ясен Chorus/Verse/Drop)
Текст:
${lyrics}`;
    try {
      const review = await callGemini(prompt);
      GeminiValidator._log("Стъпка 1 — Ръчна проверка на текста", review);
      AppState.data.project.geminiReview = review;
      AppState.save();
    } catch (e) {
      GeminiValidator._log("Стъпка 1 — Ръчна проверка", "❌ " + e.message);
    }
  }
};

/* =========================================================
   VIRAL LAB — AI Music Producer
   Превръща приложението от "генератор на текст" в анализатор,
   който взема решения на база данни: Viral Score, прогноза за
   успех, оценка на текста/hook-а/структурата/жанра, конкурентни
   препоръки, AI Producer Review и автоматично подобряване на
   слабите части (rewrite само на конкретната секция).
   ========================================================= */
const ViralLab = {
  // Едно голямо структурирано Claude извикване вместо 8 отделни —
  // по-бързо, по-евтино (по-малко round-trips) и лесно за поддръжка.
  // forceRefresh=true игнорира кеша (бутон "🔄 Презареди анализа").
  async analyze(forceRefresh = false) {
    const p = AppState.data.project;
    const lyrics = (document.getElementById("lyricsOut")?.value || p.lyrics || "").trim();
    if (!lyrics) return toast("Първо генерирай текст на песента (по-горе)");

    const niche = p.chosenNiche || "modern pop";
    const title = p.title || "(без заглавие)";
    const out = document.getElementById("viralLabOut");

    // Кешираме по хеш на реалните входни данни — ако текстът/заглавието/нишата
    // не са се променили от последния анализ, връщаме готовия резултат вместо
    // да хабим API квота за идентична заявка.
    const cacheInputs = { lyrics, niche, title, nicheScore: p.nicheScore };
    if (!forceRefresh) {
      const cached = AICache.get("viralLab", cacheInputs);
      if (cached) {
        AppState.data.project.viralReport = cached;
        AppState.save();
        this.render(cached);
        toast("♻️ Показвам кеширан анализ (текстът не се е променил) — 🔄 Презареди за нов", 4000);
        return;
      }
    }

    // Реални пазарни сигнали, които вече имаме от Стъпка 1 (trend snapshot /
    // niche score) — подаваме ги на Claude вместо да гадае от нулата.
    const nicheRow = (p.niches || []).find(n => n.niche === niche) || {};
    const marketContext = `Niche score (0-100, от дневния trend snapshot / SEO анализ): ${p.nicheScore ?? "няма данни"}
Search signal: ${nicheRow.search_signal || "няма данни"}
Competition signal: ${nicheRow.competition_signal || "няма данни"}`;

    out.innerHTML = `<p class="muted">⏳ AI Producer анализира песента (Viral Score, hook, chorus, структура, жанр, конкуренция, review)...</p>`;

    // Жанрово заземяване: реални заглавия на топ видеа в нишата (ако има YouTube ключ),
    // за да не гадае Claude BPM/теми само от тренировъчните си данни.
    const topTitles = await youtubeTopTitles(niche);
    const genreGrounding = topTitles.length
      ? `\nРЕАЛНИ ЗАГЛАВИЯ НА ВИДЕА, КОИТО РЕАЛНО НАБИРАТ ИНЕРЦИЯ В НИШАТА "${niche}" ТОЧНО СЕГА (YouTube, последните месеци, сортирани по темп на растеж — не стари all-time хитове), използвай ги като реален контекст за genre_check, не гадай:\n${topTitles.map(t => `- ${t}`).join("\n")}\n`
      : "";

    const prompt = `Ти си AI музикален продуцент, A&R анализатор и маркетинг стратег за 2026 година.
Анализирай следната песен КАТО ЦЯЛОСТЕН ПРОДУКТ (не само текста) — вземи предвид жанра, заглавието
и реалните пазарни сигнали по-долу. Бъди честен и критичен, не завишавай оценки без основание.

ЗАГЛАВИЕ: ${title}
ЖАНР/НИША: ${niche}

ПАЗАРЕН КОНТЕКСТ:
${marketContext}

ТЕКСТ НА ПЕСЕНТА:
---
${lyrics}
---
${genreGrounding}
Върни ЧИСТ JSON (без markdown, без обяснения извън JSON) с ТОЧНО тази структура:
{
  "viral_score": number (0-100, претеглена комбинация: Trend Momentum 30%, Search Volume 20%, Music Competition 15%, Audience Match 15%, Emotional Impact 10%, TikTok Potential 10% — изчисли реално претеглената стойност),
  "breakdown": {
    "trend_momentum": number (0-100),
    "search_volume": number (0-100),
    "competition": number (0-100, по-високо = по-слаба конкуренция/по-добра позиция),
    "audience_match": number (0-100),
    "emotional_impact": number (0-100),
    "tiktok_potential": number (0-100)
  },
  "predictions": {
    "attention_chance": number (0-100, % шанс да привлече внимание),
    "shorts_fit": number (0-100, % колко е добра за YouTube Shorts),
    "tiktok_sound_chance": number (0-100, % шанс да стане TikTok звук),
    "youtube_ctr_chance": number (0-100, % шанс за висок CTR в YouTube)
  },
  "lyrics_analysis": {
    "hook_strength": number (0-100),
    "memorability": number (0-100),
    "repeatability": number (0-100),
    "emotional_intensity": number (0-100),
    "singability": number (0-100),
    "rhyme_quality": number (0-100),
    "simplicity": number (0-100)
  },
  "chorus": {
    "text": "извлеченият припев от текста, дословно (или '(няма ясен [Chorus] таг)')",
    "has_repeating_hook": boolean,
    "word_count": number,
    "memorability": number (0-100),
    "fits_15_30s_clip": boolean,
    "notes": "1-2 изречения защо"
  },
  "structure": {
    "expected_for_genre": ["Intro","Verse","Pre-Chorus","Chorus","Verse","Bridge","Final Chorus"] (адаптирай реално за жанра, не копирай сляпо),
    "detected_in_lyrics": ["...секциите, които реално откри по [таговете] в текста..."],
    "fits_genre": boolean,
    "notes": "1-2 изречения препоръка"
  },
  "genre_check": {
    "typical_bpm": [number, number, number] (типични BPM за жанра),
    "common_themes": ["...", "...", "...", "..."] (най-чести теми в жанра),
    "alignment_notes": "доколко темата/лириката на тази песен пасва на очакванията на аудиторията в жанра — 1-2 изречения"
  },
  "competition_advice": ["конкретна препоръка 1", "конкретна препоръка 2", "конкретна препоръка 3"] (действия, не статистика — напр. смяна на гледна точка, по-кратък припев, по-силен първи ред и т.н., съобразени с competition signal-а по-горе),
  "ai_review": {
    "stars": number (1-5, може с .5),
    "pros": ["плюс 1", "плюс 2", "плюс 3"],
    "cons": ["минус 1", "минус 2"]
  },
  "weak_sections": [
    {"section": "напр. Verse 2 / Chorus / Bridge — конкретна секция от ТОЗИ текст", "score": number (0-10), "reason": "защо е слаба, 1 изречение"}
  ] (0-3 елемента; само реално слаби секции, ако всичко е силно — празен масив)
}`;

    try {
      const raw = await callAI(prompt, 3200);
      const r = extractJson(raw);
      AICache.set("viralLab", cacheInputs, r);
      AppState.data.project.viralReport = r;
      AppState.save();
      this.render(r);
      TrackRecord.save(r);
      GeminiValidator.autoReview("Стъпка 1 — Viral Lab анализ", JSON.stringify(r.breakdown) + " | Score: " + r.viral_score);
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ Грешка при анализ: ${e.message}</p>`;
    }
  },

  _bar(label, val) {
    return `<div class="vbar-row">
      <div class="lbl"><span>${label}</span><span>${val}</span></div>
      <div class="vbar-track"><div class="vbar-fill" style="width:${Math.max(0, Math.min(100, val))}%;"></div></div>
    </div>`;
  },

  _stars(n) {
    const full = Math.floor(n), half = n % 1 >= 0.5;
    let s = "★".repeat(full);
    if (half) s += "⯨";
    s += "☆".repeat(Math.max(0, 5 - full - (half ? 1 : 0)));
    return s;
  },

  render(r) {
    const out = document.getElementById("viralLabOut");
    const b = r.breakdown || {}, pr = r.predictions || {}, la = r.lyrics_analysis || {};
    const ch = r.chorus || {}, st = r.structure || {}, gc = r.genre_check || {};
    const score = Math.round(r.viral_score || 0);
    const scoreColor = score >= 75 ? "var(--green)" : score >= 50 ? "var(--amber)" : "var(--red)";

    let html = `
      <div class="vscore-hero">
        <div class="vscore-ring" style="--pct:${score};">
          <div class="v" style="color:${scoreColor};">${score}<small>VIRAL SCORE</small></div>
        </div>
        <div class="vscore-meta">
          <strong>Overall Viral Score</strong>
          <p class="muted">Претеглена комбинация от 6 фактора (Trend 30% · Search 20% · Competition 15% · Audience 15% · Emotion 10% · TikTok 10%).</p>
        </div>
      </div>

      ${this._bar("📈 Trend Momentum", b.trend_momentum ?? 0)}
      ${this._bar("🔍 Search Volume", b.search_volume ?? 0)}
      ${this._bar("🎵 Music Competition", b.competition ?? 0)}
      ${this._bar("🎯 Audience Match", b.audience_match ?? 0)}
      ${this._bar("💬 Emotional Impact", b.emotional_impact ?? 0)}
      ${this._bar("📱 TikTok Potential", b.tiktok_potential ?? 0)}

      <div class="vpred-grid">
        <div class="vpred-item"><div class="pv">${pr.attention_chance ?? "—"}%</div><div class="pl">⭐ Шанс да привлече внимание</div></div>
        <div class="vpred-item"><div class="pv">${pr.shorts_fit ?? "—"}%</div><div class="pl">⭐ Добра за YouTube Shorts</div></div>
        <div class="vpred-item"><div class="pv">${pr.tiktok_sound_chance ?? "—"}%</div><div class="pl">⭐ Шанс да стане TikTok звук</div></div>
        <div class="vpred-item"><div class="pv">${pr.youtube_ctr_chance ?? "—"}%</div><div class="pl">⭐ Висок CTR в YouTube</div></div>
      </div>

      <div class="section-title" style="margin:20px 0 8px;">✍️ Анализ на текста</div>
      ${this._bar("Hook Strength", la.hook_strength ?? 0)}
      ${this._bar("Memorability", la.memorability ?? 0)}
      ${this._bar("Repeatability", la.repeatability ?? 0)}
      ${this._bar("Emotional Intensity", la.emotional_intensity ?? 0)}
      ${this._bar("Singability", la.singability ?? 0)}
      ${this._bar("Rhyme Quality", la.rhyme_quality ?? 0)}
      ${this._bar("Simplicity", la.simplicity ?? 0)}

      <div class="section-title" style="margin:20px 0 8px;">🎤 Анализ на припева (Chorus)</div>
      <div class="copy-field"><span><em>"${ch.text || "—"}"</em></span></div>
      <p class="muted" style="margin:8px 0 0;">
        ${ch.has_repeating_hook ? "✅" : "⚠️"} Повтарящ се hook ·
        ${ch.word_count ?? "—"} думи ·
        Memorability ${ch.memorability ?? "—"}/100 ·
        ${ch.fits_15_30s_clip ? "✅ Пасва на 15-30с клипове" : "⚠️ Не е идеален за кратки клипове"}
      </p>
      <p class="muted">${ch.notes || ""}</p>

      <div class="section-title" style="margin:20px 0 8px;">🧱 Структура</div>
      <p class="muted">Очаквана за жанра: ${(st.expected_for_genre || []).join(" → ") || "—"}</p>
      <p class="muted">Открита в текста: ${(st.detected_in_lyrics || []).join(" → ") || "—"}</p>
      <p>${st.fits_genre ? "🟢 Структурата пасва на жанра" : "🟡 Структурата не пасва напълно"} — ${st.notes || ""}</p>

      <div class="section-title" style="margin:20px 0 8px;">🎯 Жанрова проверка</div>
      <p class="muted">Типични BPM за "${AppState.data.project.chosenNiche || ""}": <strong>${(gc.typical_bpm || []).join(" / ") || "—"}</strong></p>
      <div class="hashtags">${(gc.common_themes || []).map(t => `<span>${t}</span>`).join("")}</div>
      <p class="muted" style="margin-top:8px;">${gc.alignment_notes || ""}</p>

      <div class="section-title" style="margin:20px 0 8px;">🏁 Анализ на конкуренцията</div>
      <ul class="vlist">${(r.competition_advice || []).map(a => `<li>${a}</li>`).join("")}</ul>

      <div class="section-title" style="margin:20px 0 8px;">🤖 AI Producer Review</div>
      <div class="stars">${this._stars(r.ai_review?.stars || 0)}</div>
      <p class="muted" style="margin:6px 0 0;">Плюсове:</p>
      <ul class="vlist">${(r.ai_review?.pros || []).map(x => `<li>${x}</li>`).join("")}</ul>
      <p class="muted" style="margin:6px 0 0;">Минуси:</p>
      <ul class="vlist cons">${(r.ai_review?.cons || []).map(x => `<li>${x}</li>`).join("")}</ul>
    `;

    const weak = r.weak_sections || [];
    html += `<div class="section-title" style="margin:20px 0 8px;">✨ Подобри слабите места</div>`;
    if (!weak.length) {
      html += `<p class="muted">Няма ясно слаби секции — текстът е стабилен като цяло.</p>`;
    } else {
      html += weak.map((w, i) => `
        <div class="weak-card">
          <span><strong>${w.section}</strong> <span class="ws-score">${w.score}/10</span><br>
            <span class="muted">${w.reason}</span></span>
          <button class="btn ghost" onclick="ViralLab.improveSection(${i})">✨ Подобри</button>
        </div>`).join("");
    }
    html += `<div id="viralImproveOut" style="margin-top:10px;"></div>`;

    out.innerHTML = html;
  },

  // Пренаписва САМО посочената слаба секция (не цялата песен) и връща
  // текста обратно в lyricsOut — с before/after "score", за да се вижда
  // реалният ефект от подобрението.
  async improveSection(i) {
    const r = AppState.data.project.viralReport;
    const w = r?.weak_sections?.[i];
    const lyrics = document.getElementById("lyricsOut").value.trim();
    if (!w || !lyrics) return;
    const el = document.getElementById("viralImproveOut");
    el.innerHTML = `<p class="muted">⏳ Пренаписвам "${w.section}"...</p>`;

    const prompt = `Дадена е песен. Пренапиши САМО секцията "${w.section}", защото: "${w.reason}".
Не пипай останалите секции — върни ги дословно същите. Запази мета-таговете ([Chorus], [Verse] и т.н.),
стила и жанра. Новата версия на секцията трябва да е осезаемо по-силна (по-добър hook/рими/образност).

Пълен текст:
---
${lyrics}
---

Върни ЧИСТ JSON: {"full_lyrics": "целият текст с пренаписаната секция", "new_section_score": number (0-10, честна нова оценка САМО на пренаписаната секция), "what_changed": "1 изречение какво промени"}`;

    try {
      const raw = await callAI(prompt, 1800);
      const res = extractJson(raw);
      LyricsHistory.push(`Преди подобряване: ${w.section}`);
      document.getElementById("lyricsOut").value = res.full_lyrics;
      AppState.data.project.lyrics = res.full_lyrics;
      AppState.save();
      el.innerHTML = `<div class="copy-field"><span>✅ <strong>${w.section}</strong>: ${w.score}/10 → <strong style="color:var(--green);">${res.new_section_score}/10</strong><br><span class="muted">${res.what_changed}</span></span></div>
        <p class="muted">Текстът по-горе е обновен. Препоръка: пусни "Анализирай вирусния потенциал" пак за нов пълен доклад.</p>`;
      GeminiValidator.autoReview(`Стъпка 1 — Подобряване (${w.section})`, res.what_changed);
    } catch (e) {
      el.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  }
};

/* =========================================================
   HOOK EVOLUTION ARENA
   Вместо 1 hook и се надяваш да е добър: генерираме 8 различни,
   тестваме всеки с "3-секунден scroll тест" (симулация на реално
   TikTok/Shorts поведение — не цялата песен, само прозорче от 3с),
   選ираме топ 3, и ги "кръстосваме" — хибриди + мутации — за
   следващо поколение. 3 поколения по-късно остава 1 победител.
   Вдъхновено от генетични алгоритми: селекция + кръстосване >
   просто "генерирай N пъти и избери най-добрия".
   ========================================================= */
const HookArena = {
  running: false,

  async start() {
    if (this.running) return;
    this.running = true;
    const p = AppState.data.project;
    const niche = p.chosenNiche || "modern pop";
    const title = p.title || "";
    const out = document.getElementById("hookArenaOut");
    out.innerHTML = `<p class="muted">🧬 Generation 1 — създавам 8 различни hook-а...</p>`;

    try {
      let pool = await this._generateInitial(niche, title);
      let allGenerationsHtml = "";

      for (let gen = 1; gen <= 3; gen++) {
        out.innerHTML = allGenerationsHtml + `<p class="muted">🧬 Generation ${gen} — 3-секунден scroll тест на ${pool.length} hook-а...</p>`;
        const scored = await this._scoreHooks(pool, niche);
        const merged = pool.map((h, i) => ({ ...h, ...scored[i] }))
          .sort((a, b) => (b.hook_score ?? 0) - (a.hook_score ?? 0));

        const isFinal = gen === 3;
        allGenerationsHtml += this._renderGeneration(gen, merged, isFinal);
        out.innerHTML = allGenerationsHtml;

        if (isFinal) {
          const winner = merged[0];
          AppState.data.project.winningHook = winner.text;
          AppState.save();
          out.innerHTML = allGenerationsHtml + `
            <div class="card tight" style="margin-top:12px;border-color:var(--green);">
              <strong>🏆 Победител: Gen 3, score ${winner.hook_score}</strong>
              <p style="margin:6px 0 0;font-size:13px;">"${winner.text}"</p>
              <p class="muted" style="margin-top:6px;">Запазен — при следващото "✍️ Генерирай текст" Claude ще го вгради като chorus hook.</p>
            </div>`;
          GeminiValidator.autoReview("Стъпка 1 — Hook Evolution Arena (победител)", winner.text);
          break;
        }

        const top3 = merged.slice(0, 3);
        out.innerHTML = allGenerationsHtml + `<p class="muted">🧬 Кръстосвам топ 3 в следващо поколение...</p>`;
        pool = await this._breed(top3, niche, title, gen === 2 ? 5 : 8);
      }
    } catch (e) {
      out.innerHTML += `<p class="muted">❌ ${e.message}</p>`;
    } finally {
      this.running = false;
    }
  },

  async _generateInitial(niche, title) {
    const prompt = `Генерирай 8 РАЗЛИЧНИ hook/chorus реда (1 ред всеки) за песен в жанр "${niche}"${title ? ` със заглавие "${title}"` : ""}.
Всеки трябва да звучи различно: различна рима схема, различен ъгъл/емоция, различен ключов образ.
Не повтаряй теми/думи между тях. Пиши директно репликите, без обяснения.
Върни ЧИСТ JSON масив: [{"text":"..."}]`;
    const raw = await callAI(prompt, 700);
    return extractJson(raw);
  },

  // "3-секунден scroll тест" — симулира реално TikTok/Shorts поведение:
  // не цялата песен, само прозорче, каквото реално вижда скролващ човек.
  async _scoreHooks(hooks, niche) {
    const prompt = `Ти си симулация на TikTok/YouTube Shorts scroll поведение за жанр "${niche}".
За всеки от следните hook редове, представи си, че потребител чува САМО първите 3 секунди
докато скролва — направи честен "3-секунден window тест":

${hooks.map((h, i) => `${i + 1}. "${h.text}"`).join("\n")}

За всеки върни:
- hook_score: 0-100 (обща сила — запомняемост, ритъм, изненада, "stopping power")
- stops_scroll: boolean (дали тези 3 секунди реално биха спрели скрола)
- why: кратка причина, максимум 8 думи

Върни ЧИСТ JSON масив, В СЪЩИЯ РЕД: [{"hook_score":number,"stops_scroll":boolean,"why":"..."}]`;
    const raw = await callAI(prompt, 1300);
    return extractJson(raw);
  },

  async _breed(top3, niche, title, targetCount) {
    const isFinal = targetCount === 5;
    const prompt = `Ти си AI hook "breeder" — вземаш най-силните hook-ове от предишно поколение и ги кръстосваш,
за песен в жанр "${niche}"${title ? ` със заглавие "${title}"` : ""}.

РОДИТЕЛИ (топ 3 от предишно поколение):
${top3.map((h, i) => `${i + 1}. "${h.text}" — защо е силен: ${h.why || "висок scroll score"}`).join("\n")}

Генерирай СЛЕДВАЩО поколение от ${targetCount} ${isFinal ? "ФИНАЛНО РАФИНИРАНИ" : "НОВИ"} hook-а:
${isFinal
      ? `- Вземи най-добрите елементи от родителите и ги доизпипай до максимална сила — по-остри думи, по-чист ритъм, по-силна изненада. Всеки трябва да е реално по-добър от родителите си, не просто различен.`
      : `- ${Math.max(targetCount - 3, 1)} "хибрида": вземи най-силния елемент от 1 родител (напр. рима/ритъм) + най-силния елемент от друг (напр. образ/тема) и ги слей в нов hook.
- останалите "мутации": вземи 1 самостоятелен родител и направи смел творчески туист (нов ъгъл/метафора), запазвайки основната му сила.`}

За всеки нов hook дай lineage: кратко обяснение на произхода (кой родител/и и какво взе от всеки), до 15 думи.
Върни ЧИСТ JSON масив: [{"text":"...", "lineage":"..."}]`;
    const raw = await callAI(prompt, 1500);
    return extractJson(raw);
  },

  _renderGeneration(gen, merged, isFinal) {
    const best = merged[0];
    let html = `<div class="arena-gen">
      <div class="arena-gen-title">🧬 Generation ${gen} ${isFinal ? "(финал)" : ""} <span class="best">— best: ${best.hook_score ?? "—"}</span></div>`;
    merged.forEach((h, i) => {
      html += `<div class="arena-hook ${i === 0 ? "winner" : ""}">
        <span class="txt">"${h.text}"${h.lineage ? `<div class="lineage">🧬 ${h.lineage}</div>` : ""}${h.why ? `<div class="lineage">${h.stops_scroll ? "✅" : "⚠️"} ${h.why}</div>` : ""}</span>
        <span class="sc">${h.hook_score ?? "—"}</span>
      </div>`;
    });
    html += `</div>`;
    return html;
  }
};

/* =========================================================
   GHOST AUDIENCE
   Симулирана фокус-група: 12 синтетични, но правдоподобни
   персони "чуват" песента и реагират — с техните думи, техния
   сленг, техните предразсъдъци. Не абстрактно число, а РЕАКЦИЯ.
   Плюс: attention heatmap (секунда по секунда по структурата) и
   meme risk radar (редове, за които няколко персони независимо
   се закачат подигравателно — улавя нещото, за което си твърде
   близо до текста, за да го видиш сам).
   ========================================================= */
const GhostAudience = {
  // forceRefresh=true игнорира кеша (бутон "🔄 Презареди фокус-групата").
  async run(forceRefresh = false) {
    const p = AppState.data.project;
    const lyrics = (document.getElementById("lyricsOut")?.value || p.lyrics || "").trim();
    if (!lyrics) return toast("Първо генерирай текст на песента (по-горе)");
    const niche = p.chosenNiche || "modern pop";
    const out = document.getElementById("ghostAudienceOut");

    // Кешираме по хеш на текста+нишата — 12 персони е скъпа заявка, не я
    // повтаряй за идентичен вход.
    const cacheInputs = { lyrics, niche };
    if (!forceRefresh) {
      const cached = AICache.get("ghostAudience", cacheInputs);
      if (cached) {
        AppState.data.project.ghostAudience = cached;
        AppState.save();
        this.render(cached);
        toast("♻️ Показвам кеширана фокус-група (текстът не се е променил) — 🔄 Презареди за нова", 4000);
        return;
      }
    }

    out.innerHTML = `<p class="muted">👻 Свиквам 12 синтетични слушателя да чуят песента...</p>`;

    const prompt = `Ти симулираш РЕАЛНА, разнообразна публика от 12 души, слушащи следната песен
за пръв път (жанр: "${niche}"), все едно я срещат случайно на своя TikTok/YouTube feed.

ТЕКСТ:
---
${lyrics}
---

Създай 12 РАЗЛИЧНИ, правдоподобни персони (различна възраст, вкус, платформа, отношение —
от фен до циничен критик). За всяка:
- name: измислено кратко име/псевдоним (не истинска знаменитост)
- context: 3-5 думи кой е (напр. "17г, drill фен, TikTok")
- reaction: 1-2 изречения РЕАЛНА реакция, С ТЕХНИЯ ГЛАС/СЛЕНГ (не обяснение — самата реакция, все едно я пише в коментар)
- would_scroll_away: boolean — дали биха скролнали до края
- scroll_away_at: ако would_scroll_away е true, коя секция от текста ги "загуби" (напр. "Verse 2"); ако false — null

После, на база всичките 12 реакции, направи:
- attention_heatmap: масив от {"section":"Intro/Verse/Chorus и т.н., в реда на текста","attention":number 0-100} — колко от персоните останаха "включени" на всяка секция
- meme_risk: масив от 0-2 елемента {"line":"конкретен ред от текста, за който 2+ персони се закачиха подигравателно","flagged_by":number,"note":"защо е рисков, 1 изречение"} — САМО ако реално има такъв риск, иначе празен масив

Върни ЧИСТ JSON: {"personas":[...], "attention_heatmap":[...], "meme_risk":[...]}`;

    try {
      const raw = await callAI(prompt, 3200);
      const r = extractJson(raw);
      AICache.set("ghostAudience", cacheInputs, r);
      AppState.data.project.ghostAudience = r;
      AppState.save();
      this.render(r);
      GeminiValidator.autoReview("Стъпка 1 — Ghost Audience", `${r.personas?.length || 0} персони, ${r.meme_risk?.length || 0} meme риска`);
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  },

  render(r) {
    const out = document.getElementById("ghostAudienceOut");
    const personas = r.personas || [];
    const stayCount = personas.filter(p => !p.would_scroll_away).length;

    let html = `<p class="muted">${stayCount}/${personas.length} персони биха останали до края.</p>
      <div class="persona-grid">`;
    personas.forEach(p => {
      html += `<div class="persona-card">
        <div class="who"><span>👤 ${p.name}</span><span>${p.context || ""}</span></div>
        <div class="quote">"${p.reaction}"</div>
        <div class="scroll ${p.would_scroll_away ? "leave" : "stay"}">
          ${p.would_scroll_away ? `⚠️ Скролва на: ${p.scroll_away_at || "—"}` : "✅ Остава до края"}
        </div>
      </div>`;
    });
    html += `</div>`;

    if (r.attention_heatmap?.length) {
      html += `<div class="section-title" style="margin:20px 0 4px;">📈 Attention Heatmap</div>`;
      r.attention_heatmap.forEach(s => {
        const val = Math.max(0, Math.min(100, s.attention ?? 0));
        const color = val >= 70 ? "var(--green)" : val >= 40 ? "var(--amber)" : "var(--red)";
        html += `<div class="heat-row"><span class="sec">${s.section}</span>
          <div class="heat-track"><div class="heat-fill" style="width:${val}%;background:${color};"></div></div>
          <span class="muted" style="width:34px;text-align:right;">${val}</span></div>`;
      });
    }

    if (r.meme_risk?.length) {
      html += `<div class="section-title" style="margin:20px 0 4px;">⚠️ Meme Risk Radar</div>`;
      r.meme_risk.forEach(m => {
        html += `<div class="meme-flag"><strong>"${m.line}"</strong><br>
          <span class="muted">${m.flagged_by} персони се закачиха за този ред — ${m.note}</span></div>`;
      });
    } else {
      html += `<p class="muted" style="margin-top:14px;">✅ Никой ред не беше маркиран за подигравателен риск.</p>`;
    }

    out.innerHTML = html;
  }
};

/* =========================================================
   STEP 2 — Suno & Визуализатор
   (Основната видео логика ще се вгради тук след като предоставиш
    кода на съществуващия си визуализатор)
   ========================================================= */
const Step2 = {
  syncTitleToVisualizer() {
    const frame = document.getElementById("visualizerFrame");
    if (!frame || !frame.contentWindow) return;
    const title = AppState.data.project.title || "";
    const send = () => frame.contentWindow.postMessage({ type: "cdb-set-title", title }, "*");
    // ако iframe вече е зареден - изпращаме веднага; иначе чакаме load-а му
    if (frame.dataset.loaded === "true") send();
    else frame.addEventListener("load", () => { frame.dataset.loaded = "true"; send(); }, { once: true });
  },

  async generateFxConfig() {
    const niche = AppState.data.project.chosenNiche || "pop";
    const prompt = `Генерирай JSON конфигурация за видео ефекти (FX) подходящи за музикален жанр "${niche}".
Включи полета: pulse_on_bass (bool), glitch_intensity (0-1), color_grade (string, напр. "warm cinematic"),
particle_effect (string или null), transition_style (string).
Върни САМО чист JSON, без обяснения.`;
    document.getElementById("fxConfigOut").value = "⏳ Генерирам...";
    try {
      const raw = await callAI(prompt, 300);
      const parsed = extractJson(raw);
      document.getElementById("fxConfigOut").value = JSON.stringify(parsed, null, 2);
      AppState.data.project.fxConfig = JSON.stringify(parsed);
      AppState.save();

      GeminiValidator.autoReview("Стъпка 2 — FX конфигурация", JSON.stringify(parsed));
    } catch (e) {
      document.getElementById("fxConfigOut").value = "";
      toast("Грешка: " + e.message);
    }
  }
  // TODO: renderVisualizer() — ще бъде добавена тук след интеграция
  // на съществуващия ти HTML/JS визуализатор (видео1 + видео2 + лого).
};

/* =========================================================
   STEP 3 — DistroKid & Обложка
   ========================================================= */
const Step3 = {
  async generateCoverPrompt() {
    const title = AppState.data.project.title || "untitled";
    const niche = AppState.data.project.chosenNiche || "pop";
    const prompt = `Създай детайлен визуален промпт (на английски, за Imagen/Flow Music AI) за квадратна
обложка на песен (3000x3000px, streaming cover art) със заглавие "${title}" в жанр "${niche}".
Опиши стил, цветова палитра, композиция, настроение. Максимум 4-5 изречения, само промпта.`;
    document.getElementById("coverPromptOut").value = "⏳ Генерирам...";
    try {
      const p = await callAI(prompt, 300);
      document.getElementById("coverPromptOut").value = p;
      AppState.data.project.coverPrompt = p;
      AppState.save();

      GeminiValidator.autoReview("Стъпка 3 — Промпт за обложка", p);
    } catch (e) {
      document.getElementById("coverPromptOut").value = "";
      toast("Грешка: " + e.message);
    }
  },

  async generateCoverImage() {
    const prompt = document.getElementById("coverPromptOut").value.trim();
    if (!prompt) return toast("Първо генерирай визуалния промпт");
    const k = Keys.load();
    if (!k.gemini) return toast("⚠️ Нужен е Gemini/Imagen API ключ в Настройки");

    document.getElementById("coverImgOut").innerHTML = "⏳ Генерирам обложка...";
    try {
      // ЗАБЕЛЕЖКА: Точният endpoint/модел за Imagen генериране на изображения
      // през Gemini API може да варира — провери актуалното име на модела
      // в Google AI Studio (напр. модел с "image-generation" в името).
      // Тук е генеричен пример с responseModalities.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${k.gemini}`;
      const res = await fetchTimeout(proxied(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Square album cover art, 3000x3000px composition: ${prompt}` }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
        })
      }, 60000); // image generation отнема по-дълго
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const imgPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imgPart) throw new Error("Моделът не върна изображение — провери името на модела в Настройки/документацията.");
      const imgUrl = `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
      document.getElementById("coverImgOut").innerHTML = `<img src="${imgUrl}" style="max-width:300px;border-radius:8px;">`;
      AppState.data.project.coverImageUrl = imgUrl;
      AppState.save();
    } catch (e) {
      document.getElementById("coverImgOut").innerHTML = `❌ ${e.message}<br><span class="muted">Ако Imagen откаже директен браузър достъп (CORS), ще трябва малък proxy — виж бележките в разговора.</span>`;
    }
  },

  buildDistrokidFields() {
    const p = AppState.data.project;
    const fields = [
      { label: "Заглавие", value: p.title || "" },
      { label: "Изпълнител", value: "CD-B Records" },
      { label: "Жанр", value: p.chosenNiche || "" },
      { label: "Цена", value: "$5.99" },
      { label: "AI отметки", value: "✅ Съдържа AI-генерирана музика / текст" },
      { label: "Хаштагове", value: (p.hashtags || []).join(" ") },
    ];
    let html = "";
    fields.forEach((f, i) => {
      html += `<label>${f.label}</label>
        <div class="copy-field">
          <span id="dk-field-${i}">${f.value || "(няма данни — попълни Стъпка 1)"}</span>
          <button onclick="Step3.copyField(${i})">📋 Copy</button>
        </div>`;
    });
    document.getElementById("distrokidFields").innerHTML = html;
    AppState.data.project.distrokid = fields;
    AppState.save();
  },

  copyField(i) {
    const text = document.getElementById(`dk-field-${i}`).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Копирано ✅"));
  },

  // 12 — Spotify for Artists / Apple Music for Artists готови текстове
  async generateSpotifyAppleText() {
    const p = AppState.data.project;
    if (!p.title) return toast("Първо генерирай концепция в Стъпка 1");
    const el = document.getElementById("spotifyAppleOut");
    el.innerHTML = "⏳ Генерирам...";
    const prompt = `За песен със заглавие "${p.title}" в жанр "${p.chosenNiche || "pop"}", генерирай:
- spotify_bio: кратко Spotify for Artists "Pitch to editors" описание (до 500 знака) — какво прави песента специална, звучене, настроение.
- apple_bio: кратко Apple Music for Artists описание на пускането (до 400 знака), малко по-формален тон.
- release_note: 1-2 изречения "бележка към феновете" за социалните мрежи.
Върни ЧИСТ JSON: {"spotify_bio":"...", "apple_bio":"...", "release_note":"..."}`;
    try {
      const raw = await callAI(prompt, 500);
      const c = extractJson(raw);
      AppState.data.project.spotifyAppleText = c;
      AppState.save();
      el.innerHTML = `
        <label style="margin-top:0;">🎵 Spotify for Artists</label>
        <div class="copy-field"><span id="sa-0">${c.spotify_bio}</span><button onclick="Step3._copySA(0)">📋</button></div>
        <label>🍏 Apple Music for Artists</label>
        <div class="copy-field"><span id="sa-1">${c.apple_bio}</span><button onclick="Step3._copySA(1)">📋</button></div>
        <label>💬 Бележка към феновете</label>
        <div class="copy-field"><span id="sa-2">${c.release_note}</span><button onclick="Step3._copySA(2)">📋</button></div>`;
      GeminiValidator.autoReview("Стъпка 3 — Spotify/Apple текстове", JSON.stringify(c));
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  },
  _copySA(i) {
    const text = document.getElementById(`sa-${i}`).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Копирано ✅"));
  },

  // 13 — YouTube A/B заглавия + thumbnail текст, с кратък Gemini "глас" кой е по-clickable
  async generateABTitles() {
    const p = AppState.data.project;
    if (!p.title) return toast("Първо генерирай концепция в Стъпка 1");
    const el = document.getElementById("abTitlesOut");
    el.innerHTML = "⏳ Генерирам...";
    const prompt = `За песен "${p.title}" в жанр "${p.chosenNiche || "pop"}", генерирай 3 РАЗЛИЧНИ YouTube A/B варианта:
За всеки: title (до 60 символа, clickable но не clickbait), thumbnail_text (2-4 думи за thumbnail overlay).
Върни ЧИСТ JSON масив: [{"title":"...", "thumbnail_text":"..."}]`;
    try {
      const raw = await callAI(prompt, 500);
      const variants = extractJson(raw);
      AppState.data.project.abTitles = variants;
      AppState.save();
      let html = variants.map((v, i) =>
        `<div class="copy-field"><span><strong>Вариант ${i + 1}:</strong> ${v.title}<br><span class="muted">Thumbnail: "${v.thumbnail_text}"</span></span>
          <button onclick="Step3._useTitle(${i})">➡️ Ползвай</button></div>`).join("");
      el.innerHTML = html + `<div id="abVoteOut" class="muted" style="margin-top:10px;">⏳ Gemini преценява кой е по-clickable...</div>`;

      GeminiValidator.autoReview("Стъпка 3 — YouTube A/B заглавия", JSON.stringify(variants));

      // Кратък отделен Gemini "глас" кой вариант е по-clickable
      const votePrompt = `Кой от следните 3 YouTube заглавия за песен в жанр "${p.chosenNiche || "pop"}" е най-вероятно да получи най-много кликове, и защо?
${variants.map((v, i) => `${i + 1}. "${v.title}"`).join("\n")}
Отговори с 2 изречения максимум — посочи номер и кратка причина.`;
      const vote = await callGemini(votePrompt);
      document.getElementById("abVoteOut").innerHTML = "🤖 <strong>Gemini глас:</strong> " + vote;
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  },
  _useTitle(i) {
    const v = (AppState.data.project.abTitles || [])[i];
    if (!v) return;
    document.getElementById("ytTitle").value = v.title;
    toast(`YouTube заглавие сменено на Вариант ${i + 1}`);
  },

  // 14 — Бърза проверка за прилика със съществуваща песен (YouTube search)
  async checkSimilarity() {
    const title = document.getElementById("songTitle")?.value || AppState.data.project.title;
    if (!title) return toast("Първо генерирай заглавие в Стъпка 1");
    const k = Keys.load();
    const el = document.getElementById("similarityOut");
    if (!k.ytApiKey) { el.innerHTML = "⚠️ Нужен е YouTube Data API Key (Настройки → API Ключове)"; return; }
    el.innerHTML = "⏳ Проверявам...";
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(title)}&key=${k.ytApiKey}`;
      const res = await fetchTimeout(proxied(url));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) { el.innerHTML = "✅ Не намерих близки съвпадения — заглавието изглежда свободно."; return; }

      const norm = s => s.toLowerCase().replace(/[^a-zа-я0-9]/gi, "");
      const exact = items.some(i => norm(i.snippet.title) === norm(title));
      const chipHtml = exact
        ? `<span class="chip red">⚠️ Точно съвпадение намерено</span>`
        : `<span class="chip amber">Близки резултати — прегледай ръчно</span>`;

      let html = chipHtml + items.map(i =>
        `<div class="copy-field"><span><strong>${i.snippet.title}</strong><br><span class="muted">${i.snippet.channelTitle}</span></span></div>`).join("");
      el.innerHTML = html;
      GeminiValidator.autoReview("Стъпка 3 — Проверка за прилика", `Заглавие: "${title}". Точно съвпадение: ${exact}. Топ резултат: "${items[0].snippet.title}"`);
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  }
};

/* =========================================================
   STEP 4 — YouTube Публикуване (Unlisted)
   ========================================================= */
const Step4 = {
  tokenClient: null,
  accessToken: null,

  initGoogleAuth() {
    const k = Keys.load();
    if (!k.ytClientId || !window.google) return;
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: k.ytClientId,
      scope: "https://www.googleapis.com/auth/youtube.upload",
      callback: (resp) => {
        this.accessToken = resp.access_token;
        document.querySelectorAll(".g-auth-status").forEach(el => { el.textContent = "✅ Вписан"; el.className = "chip green g-auth-status"; });
        toast("Успешен вход в Google");
        // Ако Бърз ъплоуд вече има готово видео + метаданни и е чакал само Google вход — качва автоматично.
        if (window.QuickUpload) QuickUpload._checkBothReady();
      }
    });
    document.querySelectorAll(".g-signin-slot").forEach(el => {
      el.innerHTML = `<button class="ghost" onclick="Step4.tokenClient.requestAccessToken()">🔑 Вход с Google</button>`;
    });
  },

  // fileOverride/metaOverride/progressElId — по избор, ползва се от QuickUpload режима,
  // за да качи видео Blob-а от визуализатора директно, без потребителят да минава
  // през ръчния <input type="file"> на Стъпка 3.
  async uploadVideo(fileOverride, metaOverride, progressElId) {
    if (!this.accessToken) return toast("⚠️ Първо влез с Google бутона по-горе");
    const progressEl = document.getElementById(progressElId || "ytUploadProgress");

    let file = fileOverride;
    if (!file) {
      const fileInput = document.getElementById("youtubeVideoFile");
      if (!fileInput.files.length) return toast("Избери видео файл");
      file = fileInput.files[0];
    }

    const title = metaOverride?.title ?? (document.getElementById("ytTitle").value || AppState.data.project.title || "Untitled");
    const description = metaOverride?.description ?? document.getElementById("ytDescription").value;
    const tags = metaOverride?.tags ?? document.getElementById("ytTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const madeForKids = metaOverride?.madeForKids ?? document.getElementById("ytMadeForKids").checked;

    const metadata = {
      snippet: { title, description, tags },
      status: {
        privacyStatus: "unlisted", // ЗАДЪЛЖИТЕЛНО — не се променя
        selfDeclaredMadeForKids: madeForKids,
        containsSyntheticMedia: true // Synthetic/AI content отметка
      }
    };

    progressEl.textContent = "⏳ Качвам видеото...";
    try {
      // Стъпка 1: инициализация на resumable upload сесия
      const initRes = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": file.type
          },
          body: JSON.stringify(metadata)
        }
      );
      if (!initRes.ok) throw new Error(await initRes.text());
      const uploadUrl = initRes.headers.get("Location");

      // Стъпка 2: качване на самия файл
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });
      if (!uploadRes.ok) throw new Error(await uploadRes.text());
      const result = await uploadRes.json();

      progressEl.innerHTML =
        `✅ Качено! Video ID: <strong>${result.id}</strong> (unlisted)`;
      AppState.data.project.youtube = { videoId: result.id, title };
      AppState.save();
      return result;
    } catch (e) {
      progressEl.textContent = "❌ " + e.message;
      throw e;
    }
  }
};

/* =========================================================
   QUICK UPLOAD — "⚡ Бърз ъплоуд за стари песни"
   Прескача концепция/обложка (Стъпки 1 и 3 от основния процес):
   аудио → визуализаторът прави видео → Gemini анализира звука
   (жанр/настроение/енергия) и текста (пейстнат или разпознат от
   аудиото) → Claude генерира заглавие/описание/тагове → авто
   попълване → авто качване в YouTube (unlisted).
   ========================================================= */
const QuickUpload = {
  audioFile: null,
  videoBlob: null,
  videoFileName: "video.webm",
  analysis: null,
  meta: null,
  _msgBound: false,

  // Извиква се веднъж при стартиране на приложението — слуша за отговори
  // от скрития визуализатор-iframe (готово видео / грешка).
  initListener() {
    if (this._msgBound) return;
    this._msgBound = true;
    window.addEventListener("message", (ev) => {
      if (!ev.data) return;
      if (ev.data.type === "cdb-video-ready") {
        this.videoBlob = ev.data.blob;
        this.videoFileName = ev.data.fileName || "video.webm";
        this._setVideoProgress(100);
        this.log("✅ Видеото е готово (" + Math.round(this.videoBlob.size / 1024 / 1024 * 10) / 10 + " MB).");
        this._checkBothReady();
      }
      if (ev.data.type === "cdb-video-progress") {
        this._setVideoProgress(ev.data.percent);
      }
      if (ev.data.type === "cdb-video-error") {
        this.log("❌ Грешка от визуализатора: " + ev.data.message);
        this._setRunning(false);
      }
    });
  },

  _setVideoProgress(pct) {
    const bar = document.getElementById("qVideoProgressBar");
    const wrap = document.getElementById("qVideoProgressWrap");
    const label = document.getElementById("qVideoProgressLabel");
    if (!bar) return;
    if (wrap) wrap.style.display = "block";
    bar.style.width = pct + "%";
    if (label) label.textContent = pct >= 100 ? "Видео: готово ✅" : `Видео: записва се… ${pct}%`;
  },

  onAudioSelected(input) {
    const f = input.files[0];
    const infoEl = document.getElementById("qAudioInfo");
    if (!f) { if (infoEl) infoEl.textContent = ""; this.audioFile = null; return; }
    this.audioFile = f;
    if (infoEl) infoEl.textContent = `Избрано: ${f.name} (${Math.round(f.size / 1024 / 1024 * 10) / 10} MB)`;
    const nameEl = document.getElementById("qSongName");
    if (nameEl && !nameEl.value.trim()) {
      // Само предлагаме — потребителят може да го поправи преди да старира,
      // ако името на файла не е точното име на песента.
      nameEl.value = f.name.replace(/\.[^/.]+$/, "").replace(/[_\-]+/g, " ").trim();
    }
    document.getElementById("qStartBtn").disabled = false;
  },

  log(msg) {
    const el = document.getElementById("qLog");
    if (!el) return;
    const time = new Date().toLocaleTimeString("bg-BG");
    el.innerHTML += `<div>[${time}] ${msg}</div>`;
    el.scrollTop = el.scrollHeight;
  },

  _setRunning(v) {
    const btn = document.getElementById("qStartBtn");
    if (btn) btn.disabled = v;
    const spinner = document.getElementById("qRunning");
    if (spinner) spinner.style.display = v ? "block" : "none";
  },

  // Основен вход — стартира целия pipeline.
  async runFull() {
    if (!this.audioFile) return toast("Първо избери аудио файл");
    this.videoBlob = null;
    this.analysis = null;
    this.meta = null;
    document.getElementById("qLog").innerHTML = "";
    document.getElementById("qResultCard").style.display = "none";
    const progWrap = document.getElementById("qVideoProgressWrap");
    if (progWrap) progWrap.style.display = "none";
    const progBar = document.getElementById("qVideoProgressBar");
    if (progBar) progBar.style.width = "0%";
    this._setRunning(true);
    this.log("🚀 Стартирам — прескачам концепция/обложка, директно видео от аудио.");

    // Точното име на песента, което заглавието е ЗАДЪЛЖИТЕЛНО да започва с него —
    // взето от редактируемото поле (предпопълнено от файла, но потребителят може
    // да го е поправил, ако името на файла не е точно).
    const songNameEl = document.getElementById("qSongName");
    const guessTitle = (songNameEl && songNameEl.value.trim()) || this.audioFile.name.replace(/\.[^/.]+$/, "");
    this._sendAudioToVisualizer(guessTitle);
    this.log("🎬 Пращам аудиото на визуализатора — прави видео във фонов режим...");

    // Паралелно — анализ на звук/текст с Gemini, после заглавие/описание/тагове с Claude.
    // Не чакаме видеото за това, за да вървят двата процеса едновременно.
    this._runAnalysisAndMeta(guessTitle).catch(e => {
      this.log("❌ Грешка при анализ: " + e.message);
      this._setRunning(false);
    });
  },

  _sendAudioToVisualizer(guessTitle) {
    const frame = document.getElementById("quickVisualizerFrame");
    const send = () => frame.contentWindow.postMessage(
      { type: "cdb-quick-audio", file: this.audioFile, title: guessTitle }, "*"
    );
    // Ако iframe вече е зареден (напр. втори пуск в същата сесия) — пращаме веднага,
    // иначе презареждаме iframe-а (за чист старт) и чакаме неговия load.
    frame.onload = send;
    frame.src = "visualizer.html";
  },

  async _runAnalysisAndMeta(guessTitle) {
    this.log("🎧 Gemini анализира жанр/настроение/енергия" + (this._pastedLyrics() ? " и текста (пейстнат)..." : " и се опитва да разпознае текста от аудиото..."));
    const base64 = await fileToBase64(this.audioFile);
    const mimeType = this.audioFile.type || "audio/mpeg";
    const pasted = this._pastedLyrics();

    const prompt = `Ти си музикален анализатор. Слушай приложения аудио файл (стара песен) и анализирай:
1. genre — жанр/поджанр (кратко, 2-4 думи)
2. mood — настроение/атмосфера (2-4 думи)
3. energy — ниво на енергия: "ниско", "средно" или "високо"
4. sound_description — 1-2 изречения свободно описание на звука/инструментите/вокала
5. language — ЕЗИКЪТ, на който се пее/говори в песента (напр. "български", "английски", "китайски мандарин", "руски" и т.н.) — определи го САМО от това, което чуваш/разбираш в аудиото, без значение на какъв език е зададен този промпт
6. language_code — ISO 639-1 код на същия език (напр. "bg", "en", "zh", "ru")
7. lyrics — текстът на песента, на РЕАЛНИЯ й език (НЕ превеждай)${pasted ? " (по-долу е дадена ГОТОВА версия на текста от потребителя — ползвай я КАКТО Е, само провери/довърши срещу това, което чуваш в аудиото, ако има пропуснати редове)" : " (РАЗПОЗНАЙ го directly от аудиото, доколкото е разбираемо; ако не можеш да разпознаеш част, отбележи [неразбираемо])"}
8. lyrics_source — "provided" ако е ползван пейстнатият текст, "extracted" ако е разпознат от аудиото

${pasted ? `Текст, пейстнат от потребителя:\n---\n${pasted}\n---` : ""}

Върни ЧИСТ JSON: {"genre":"...", "mood":"...", "energy":"...", "sound_description":"...", "language":"...", "language_code":"...", "lyrics":"...", "lyrics_source":"..."}`;

    const raw = await callGeminiMultimodal(prompt, base64, mimeType);
    const analysis = extractJson(raw);
    this.analysis = analysis;
    this.log(`✅ Анализ готов — жанр: "${analysis.genre}", настроение: "${analysis.mood}", енергия: "${analysis.energy}", език: "${analysis.language}" (текст: ${analysis.lyrics_source === "provided" ? "пейстнат от теб" : "разпознат от Gemini"}).`);

    this.log("✍️ Claude генерира заглавие, описание и тагове...");
    const metaPrompt = `За стара песен, чието ТОЧНО заглавие/име е: "${guessTitle}"

Допълнителен анализ на звука и текста:
Жанр: ${analysis.genre}
Настроение: ${analysis.mood}
Енергия: ${analysis.energy}
Описание на звука: ${analysis.sound_description}
Език на песента: ${analysis.language} (код: ${analysis.language_code})
Текст (откъс, за контекст на темата — НЕ го копирай изцяло в описанието): ${(analysis.lyrics || "").slice(0, 600)}

ЗАДЪЛЖИТЕЛНО ПРАВИЛО ЗА ЗАГЛАВИЕТО: title ТРЯБВА да започва ТОЧНО с "${guessTitle}" (без промяна, без превод на името), последвано от " - " и кратко, атрактивно описателно подзаглавие базирано на жанр/настроение. Формат: "${guessTitle} - [описателно подзаглавие]". НЕ подменяй и НЕ перифразирай самото име на песента.

ЗАДЪЛЖИТЕЛНО ПРАВИЛО ЗА ЕЗИК: title (описателната част след тирето) и description ТРЯБВА да бъдат написани на езика на самата песен — ${analysis.language} (${analysis.language_code}). Не превеждай и не пиши на друг език (включително не на български), дори ако песента е на съвсем различен от български език. Единствено placeholder редовете за линкове могат да останат с универсални имена на платформи (Spotify/Apple Music/DistroKid).

Генерирай:
- title: "${guessTitle} - [описателно подзаглавие]" (до 60 символа общо), на езика на песента
- description: YouTube описание, на езика на песента — ЗАДЪЛЖИТЕЛНО в този ред: (1) най-горе 2-3 placeholder реда за линкове ("🎧 Spotify: [линк]", "🍏 Apple Music: [линк]", "📀 DistroKid: [линк]"), (2) после кратък абзац (2-3 изречения) описващ песента базирано на жанр/настроение, (3) най-долу 5-8 релевантни хаштага с #
- tags: масив от 8-12 YouTube тагове (думи/кратки фрази, БЕЗ #), предимно на езика на песента; по избор 1-2 общоприети английски тагове за по-широк обхват (напр. името на жанра), ако е уместно

Върни ЧИСТ JSON: {"title":"...", "description":"...", "tags":["...", "..."]}`;
    const metaRaw = await callAI(metaPrompt, 900);
    const meta = extractJson(metaRaw);
    // Гаранция на кода (не само на промпта) — ако генерираното заглавие не
    // започва точно с реалното име на песента, го поправяме тук вместо да
    // разчитаме единствено на това LLM-ът да го спази.
    const normalizedGuess = guessTitle.trim();
    if (!meta.title || !meta.title.trim().toLowerCase().startsWith(normalizedGuess.toLowerCase())) {
      const subtitle = (meta.title || "").replace(/^[^-–—]*[-–—]\s*/, "").trim();
      meta.title = subtitle ? `${normalizedGuess} - ${subtitle}` : normalizedGuess;
    }
    this.meta = meta;
    this.log("✅ Заглавие/описание/тагове готови.");

    this._fillResultFields();
    this._checkBothReady();
  },

  _pastedLyrics() {
    const el = document.getElementById("qLyricsPaste");
    return el ? el.value.trim() : "";
  },

  _fillResultFields() {
    const card = document.getElementById("qResultCard");
    card.style.display = "block";
    document.getElementById("qTitle").value = this.meta.title || "";
    document.getElementById("qDescription").value = this.meta.description || "";
    document.getElementById("qTags").value = (this.meta.tags || []).join(", ");
    document.getElementById("qAnalysisOut").innerHTML = `
      <div class="copy-field"><span><strong>Жанр:</strong> ${this.analysis.genre} · <strong>Настроение:</strong> ${this.analysis.mood} · <strong>Енергия:</strong> ${this.analysis.energy} · <strong>Език:</strong> ${this.analysis.language || "?"}</span></div>`;
    document.getElementById("qLyricsOut").value = this.analysis.lyrics || "";
  },

  _checkBothReady() {
    if (!this.videoBlob || !this.meta) return;
    this.log("🎉 Видео + метаданни готови. Опитвам автоматично качване в YouTube (unlisted)...");
    this._setRunning(false);
    this.autoUpload();
  },

  async autoUpload() {
    if (!this.videoBlob) return toast("Няма готово видео още");
    if (!this.meta) return toast("Няма готови метаданни още");
    if (!Step4.accessToken) {
      this.log("⚠️ Не си вписан с Google — влез с бутона по-долу, после натисни \"Качи в YouTube\" ръчно.");
      return;
    }
    const file = new File([this.videoBlob], this.videoFileName, { type: "video/webm" });
    const tags = document.getElementById("qTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const meta = {
      title: document.getElementById("qTitle").value || this.meta.title,
      description: document.getElementById("qDescription").value || this.meta.description,
      tags,
      madeForKids: false
    };
    try {
      await Step4.uploadVideo(file, meta, "qUploadProgress");
      this.log("✅ Качено в YouTube като unlisted!");
    } catch (e) {
      this.log("❌ Грешка при качване: " + e.message);
    }
  },

  // Ръчен бутон — за случаите, в които auto-upload-а не е минал (напр. Google вход
  // е направен ПОСЛЕ като видеото/метаданните вече са готови).
  async manualUpload() {
    await this.autoUpload();
  }
};

/* =========================================================
   PREFS — тема (тъмна/светла) + тихa проверка на ключовете
   ========================================================= */
const PREFS_STORAGE = "cdb_dashboard_prefs_v1";
const Prefs = {
  data: { theme: "dark", healthCheck: true, contentProvider: "claude", autopilot: false },
  load() {
    const raw = localStorage.getItem(PREFS_STORAGE);
    this.data = raw ? Object.assign({ theme: "dark", healthCheck: true, contentProvider: "claude", autopilot: false }, JSON.parse(raw)) : this.data;
  },
  save() {
    localStorage.setItem(PREFS_STORAGE, JSON.stringify(this.data));
  },
  applyTheme() {
    document.body.classList.toggle("theme-light", this.data.theme === "light");
    document.querySelectorAll("#themeSwitch,#themeSwitch2,#themeSwitch3").forEach(s => {
      if (s) s.classList.toggle("on", this.data.theme === "light");
    });
  },
  toggleTheme() {
    this.data.theme = this.data.theme === "light" ? "dark" : "light";
    this.save();
    this.applyTheme();
  },
  applyHealthSwitch() {
    document.querySelectorAll("#healthSwitch,#healthSwitch2").forEach(s => {
      if (s) s.classList.toggle("on", this.data.healthCheck);
    });
  },
  toggleHealthCheck() {
    this.data.healthCheck = !this.data.healthCheck;
    this.save();
    this.applyHealthSwitch();
    toast(this.data.healthCheck ? "Проверка при зареждане: включена" : "Проверка при зареждане: изключена");
  },
  applyContentProvider() {
    document.querySelectorAll("#contentProviderSelect,#contentProviderSelectTop").forEach(s => {
      if (s) s.value = this.data.contentProvider;
    });
  },
  setContentProvider(value) {
    if (value !== "claude" && value !== "gemini") return;
    this.data.contentProvider = value;
    this.save();
    this.applyContentProvider();
    toast(value === "claude" ? "✍️ Генериране на съдържание: Claude" : "✍️ Генериране на съдържание: Gemini");
  },
  applyAutopilotSwitch() {
    document.querySelectorAll("#autopilotSwitch").forEach(s => {
      if (s) s.classList.toggle("on", this.data.autopilot);
    });
  },
  // Автопилот (по избор, изключен по подразбиране): след като най-добрата ниша
  // е избрана, автоматично верижно генерира текст на песента + Viral Lab анализ,
  // без да чакаш ръчно да натискаш всеки бутон поотделно. Вижте _renderNicheResults().
  toggleAutopilot() {
    this.data.autopilot = !this.data.autopilot;
    this.save();
    this.applyAutopilotSwitch();
    toast(this.data.autopilot
      ? "🤖 Автопилот: включен (текст + Viral анализ ще тръгват автоматично)"
      : "🤖 Автопилот: изключен");
  },
  init() {
    this.load();
    this.applyTheme();
    this.applyHealthSwitch();
    this.applyContentProvider();
    this.applyAutopilotSwitch();
    if (this.data.healthCheck) Settings.silentHealthCheck();
    else {
      const txt = document.getElementById("validatorStatusText");
      if (txt) txt.textContent = "Проверката е изключена";
    }
  }
};

/* =========================================================
   SYSTEM LOG — улавя JS грешки в реално време на сесията
   ========================================================= */
const SystemLog = {
  entries: [],
  init() {
    window.addEventListener("error", (e) => {
      this.push("error", `${e.message} (${e.filename}:${e.lineno})`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.push("error", "Unhandled promise rejection: " + (e.reason?.message || e.reason));
    });
    this.push("info", "Системата стартира нормално.");
  },
  push(level, msg) {
    this.entries.unshift({ level, msg, time: new Date().toLocaleTimeString("bg-BG") });
    this.entries = this.entries.slice(0, 50);
    this.render();
  },
  clear() {
    this.entries = [];
    this.render();
  },
  render() {
    const el = document.getElementById("systemLogOut");
    if (!el) return;
    if (!this.entries.length) { el.textContent = "Няма логове в тази сесия."; return; }
    el.innerHTML = this.entries.map(e =>
      `<div style="color:${e.level === 'error' ? 'var(--red)' : 'var(--muted)'};margin-bottom:4px;">[${e.time}] ${e.msg}</div>`).join("");
  }
};

/* =========================================================
   STATS — чете data/stats-history.json от GitHub (Actions tracker)
   и рисува KPI карти + графика + таблица с последни видеа.
   ========================================================= */
/* =========================================================
   TRACK RECORD — Предсказание срещу реалност
   Всеки път, когато ViralLab направи анализ, записваме прогнозата.
   По-късно, когато песента е публикувана и daily YouTube tracker-ът
   вече има данни за нея, потребителят я "свързва" с реално видео —
   и приложението показва честно колко точни са били предсказанията
   му във времето (не само едно число без последствия).
   ========================================================= */
const TRACK_STORAGE = "cdb_dashboard_trackrecord_v1";
const TrackRecord = {
  load() {
    const raw = localStorage.getItem(TRACK_STORAGE);
    return raw ? JSON.parse(raw) : [];
  },
  saveAll(list) {
    localStorage.setItem(TRACK_STORAGE, JSON.stringify(list.slice(0, 40)));
  },

  save(report) {
    const p = AppState.data.project;
    const list = this.load();
    list.unshift({
      id: Date.now(),
      date: new Date().toLocaleDateString("bg-BG"),
      title: p.title || "(без заглавие)",
      niche: p.chosenNiche || "",
      predicted: {
        viral_score: report.viral_score,
        attention_chance: report.predictions?.attention_chance,
        shorts_fit: report.predictions?.shorts_fit,
        tiktok_sound_chance: report.predictions?.tiktok_sound_chance,
        youtube_ctr_chance: report.predictions?.youtube_ctr_chance
      },
      actual: null
    });
    this.saveAll(list);
  },

  async render() {
    const el = document.getElementById("trackRecordOut");
    if (!el) return;
    const list = this.load();
    if (!list.length) {
      el.innerHTML = `<p class="muted">Все още няма записани прогнози — направи анализ в "🚀 Viral Lab" (Стъпка 1) и той автоматично ще се появи тук.</p>`;
      return;
    }

    const statsData = await Stats.fetchData();
    const latest = statsData?.snapshots?.length ? statsData.snapshots[statsData.snapshots.length - 1] : null;
    const videos = latest?.videos || [];

    // Обща калибрация: колко от "високите" прогнози реално излязоха силни
    const linked = list.filter(r => r.actual);
    let calibrationHtml = "";
    if (linked.length) {
      const hits = linked.filter(r => (r.predicted.viral_score >= 70 && r.actual.perf === "Отлично") ||
        (r.predicted.viral_score < 70 && r.actual.perf !== "Отлично")).length;
      calibrationHtml = `<div class="card tight" style="margin-bottom:12px;">
        <strong>🎯 Точност на предсказанията</strong>
        <p class="muted" style="margin:6px 0 0;">${hits}/${linked.length} свързани песни съвпаднаха посоката на прогнозата с реалния резултат (${Math.round(hits / linked.length * 100)}%).</p>
      </div>`;
    }

    el.innerHTML = calibrationHtml + list.map((r, i) => {
      const actualHtml = r.actual
        ? `<span class="chip ${r.actual.perf === "Отлично" ? "green" : r.actual.perf === "Добре" ? "cyan" : "amber"}">${r.actual.perf}</span>
           <span class="muted"> — "${r.actual.videoTitle}" · ${r.actual.perDay.toFixed(0)} views/ден</span>`
        : videos.length
          ? `<select id="trackLink-${i}" style="width:auto;display:inline-block;padding:6px 8px;">
               <option value="">— избери публикувано видео —</option>
               ${videos.map((v, vi) => `<option value="${vi}">${v.title}</option>`).join("")}
             </select>
             <button class="btn ghost sm" onclick="TrackRecord.link(${i})">🔗 Свържи</button>`
          : `<span class="muted">Няма още публикувани видеа в YouTube Тракера, за да сравним.</span>`;

      return `<div class="copy-field" style="align-items:flex-start;">
        <span>
          <strong>${r.title}</strong> <span class="muted">· ${r.niche} · ${r.date}</span><br>
          <span class="muted">Прогноза: Viral Score ${r.predicted.viral_score} · Внимание ${r.predicted.attention_chance}% · Shorts ${r.predicted.shorts_fit}% · TikTok ${r.predicted.tiktok_sound_chance}% · CTR ${r.predicted.youtube_ctr_chance}%</span><br>
          <span style="display:inline-block;margin-top:6px;">${actualHtml}</span>
        </span>
      </div>`;
    }).join("");
  },

  async link(i) {
    const sel = document.getElementById(`trackLink-${i}`);
    const vi = sel?.value;
    if (vi === "" || vi === undefined) return toast("Избери видео първо");
    const statsData = await Stats.fetchData();
    const latest = statsData.snapshots[statsData.snapshots.length - 1];
    const videos = latest.videos || [];
    const v = videos[vi];
    if (!v) return;

    // Същата логика като Stats.renderAnalytics — views/ден спрямо медианата на канала
    const rates = videos.map(vv => {
      const days = Math.max(1, (new Date(latest.date) - new Date(vv.published_at)) / 86400000);
      return (vv.views || 0) / days;
    }).sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)] || 1;
    const days = Math.max(1, (new Date(latest.date) - new Date(v.published_at)) / 86400000);
    const perDay = (v.views || 0) / days;
    const ratio = perDay / median;
    const perf = ratio > 1.3 ? "Отлично" : ratio > 0.8 ? "Добре" : "Средно";

    const list = this.load();
    list[i].actual = { videoTitle: v.title, perDay, perf };
    this.saveAll(list);
    toast("Свързано ✅");
    this.render();
  }
};

const Stats = {
  cache: null,

  saveRepoConfig() {
    const prev = Keys.load();
    Keys.save({
      ...prev,
      ghOwner: document.getElementById("gh_owner").value.trim(),
      ghRepo: document.getElementById("gh_repo").value.trim(),
      ghBranch: document.getElementById("gh_branch").value.trim() || "main",
    });
    toast("Запазено — зареждам статистика...");
    this.cache = null;
    this.renderDashboard();
    this.renderAnalytics();
  },

  dataUrl() {
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) return null;
    const branch = k.ghBranch || "main";
    return `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/stats-history.json`;
  },

  async fetchData() {
    if (this.cache) return this.cache;
    const url = this.dataUrl();
    if (!url) return null;
    try {
      const res = await fetchTimeout(url);
      if (!res.ok) return null;
      this.cache = await res.json();
      return this.cache;
    } catch (e) {
      return null;
    }
  },

  trendsCache: null,
  trendsUrl() {
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) return null;
    const branch = k.ghBranch || "main";
    return `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/trends-history.json`;
  },
  async fetchTrendsData() {
    if (this.trendsCache) return this.trendsCache;
    const url = this.trendsUrl();
    if (!url) return null;
    try {
      const res = await fetchTimeout(url);
      if (!res.ok) return null;
      this.trendsCache = await res.json();
      return this.trendsCache;
    } catch (e) {
      return null;
    }
  },

  // Сравнява последните ДВА snapshot-а по video_id и връща видеата с най-голям
  // прираст на гледания между тях — реален сигнал "какво расте точно сега",
  // за разлика от абсолютните гледания в таблицата "Всички видеа".
  _computeTopMovers(snaps) {
    if (!snaps || snaps.length < 2) return null;
    const latest = snaps[snaps.length - 1];
    const prev = snaps[snaps.length - 2];
    const prevMap = new Map((prev.videos || []).map(v => [v.video_id, v]));
    return (latest.videos || [])
      .map(v => {
        const old = prevMap.get(v.video_id);
        if (!old) return null; // ново видео от последния snapshot — няма база за сравнение още
        const delta = (v.views || 0) - (old.views || 0);
        if (delta <= 0) return null;
        return { title: v.title, views: v.views || 0, delta, deltaPct: old.views ? (delta / old.views * 100) : null };
      })
      .filter(Boolean)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 8);
  },

  async renderTopMovers() {
    const el = document.getElementById("topMoversCard");
    if (!el) return;
    const data = await this.fetchData();
    const snaps = data?.snapshots || [];
    if (snaps.length < 2) {
      el.innerHTML = `<strong>📈 Top Movers (най-бързо растящи видеа)</strong>
        <p class="muted" style="margin-top:8px;">Трябват поне 2 дневни snapshot-а, за да се смята прираст — тракерът тепърва трупа история (текущо: ${snaps.length}).</p>`;
      return;
    }
    const movers = this._computeTopMovers(snaps);
    if (!movers || !movers.length) {
      el.innerHTML = `<strong>📈 Top Movers (най-бързо растящи видеа)</strong>
        <p class="muted" style="margin-top:8px;">Няма видеа с прираст спрямо предишния snapshot.</p>`;
      return;
    }
    el.innerHTML = `<strong>📈 Top Movers (най-бързо растящи видеа спрямо предния snapshot)</strong>
      <table class="data" style="margin-top:10px;"><thead><tr><th>Видео</th><th>Гледания</th><th>+ От вчера</th></tr></thead>
      <tbody>${movers.map(m =>
        `<tr><td>${m.title}</td><td>${m.views.toLocaleString()}</td><td>+${m.delta.toLocaleString()}${m.deltaPct != null ? ` (${m.deltaPct.toFixed(1)}%)` : ""}</td></tr>`).join("")}
      </tbody></table>`;
  },

  async renderTrendNiches() {
    const el = document.getElementById("trendNichesCard");
    if (!el) return;
    const data = await this.fetchTrendsData();
    const snaps = data?.snapshots || [];
    if (!snaps.length) {
      el.innerHTML = `<strong>🔥 Трендващи ниши</strong>
        <p class="muted" style="margin-top:8px;">Няма данни още — виж <strong>YouTube Тракер</strong> за setup на дневния trend snapshot.</p>`;
      return;
    }
    const latest = snaps[snaps.length - 1];
    const niches = (latest.niches || []).slice(0, 6);
    if (!niches.length) {
      el.innerHTML = `<strong>🔥 Трендващи ниши</strong><p class="muted" style="margin-top:8px;">Последният snapshot няма ниши с данни.</p>`;
      return;
    }
    el.innerHTML = `<strong>🔥 Трендващи ниши</strong> <span class="muted">· snapshot от ${latest.date}</span>
      ${niches.map(n => {
        const color = n.score > 75 ? "🟢" : n.score > 50 ? "🟡" : "⚪";
        return `<div class="copy-field"><span>${color} <strong>${n.niche}</strong> — ${n.score}/100<br>
          <span class="muted">Търсене: ${n.search_signal || "—"} · Конкуренция: ${n.competition_signal || "—"}</span></span></div>`;
      }).join("")}`;
  },

  async renderDashboard() {
    const el = document.getElementById("dashStatsArea");
    if (!el) return;
    const data = await this.fetchData();
    if (!data || !data.snapshots || !data.snapshots.length) {
      el.innerHTML = `<div class="card muted">Все още няма данни. Настрой <strong>YouTube Тракер</strong> в Настройки (GitHub repo + Actions), за да видиш статистика тук.
        <br><button class="btn ghost sm" style="margin-top:10px;" onclick="Nav.showView('stats-tracker')">Настрой сега →</button></div>`;
      return;
    }
    const snaps = data.snapshots;
    const latest = snaps[snaps.length - 1];
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : latest;
    const ch = latest.channel || {};
    const chPrev = prev.channel || {};
    const delta = (a, b) => (a - b >= 0 ? "+" : "") + (a - b).toLocaleString();

    el.innerHTML = `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Абонати</div><div class="value">${(ch.subscribers || 0).toLocaleString()}</div><div class="delta">${delta(ch.subscribers || 0, chPrev.subscribers || 0)}</div></div>
        <div class="kpi"><div class="label">Общо гледания</div><div class="value">${(ch.total_views || 0).toLocaleString()}</div><div class="delta">${delta(ch.total_views || 0, chPrev.total_views || 0)}</div></div>
        <div class="kpi"><div class="label">Общо видеа</div><div class="value">${ch.video_count || 0}</div></div>
        <div class="kpi"><div class="label">Последно обновено</div><div class="value" style="font-size:14px;">${latest.date}</div></div>
      </div>
      <div class="card" style="margin-top:14px;height:260px;"><canvas id="dashGrowthChart"></canvas></div>
      <div class="card" style="margin-top:14px;">
        <strong>Последни видеа</strong>
        <table class="data" style="margin-top:10px;"><thead><tr><th>Видео</th><th>Гледания</th><th>👍</th><th>💬</th></tr></thead>
        <tbody>${(latest.videos || []).slice(0, 6).map(v =>
          `<tr><td>${v.title}</td><td>${(v.views || 0).toLocaleString()}</td><td>${(v.likes || 0).toLocaleString()}</td><td>${(v.comments || 0).toLocaleString()}</td></tr>`).join("")}
        </tbody></table>
      </div>`;

    this._drawChart("dashGrowthChart", snaps);
  },

  async renderAnalytics() {
    const el = document.getElementById("analyticsArea");
    if (!el) return;
    const data = await this.fetchData();
    if (!data || !data.snapshots || !data.snapshots.length) {
      el.innerHTML = `<div class="card muted">Няма данни още — виж <strong>YouTube Тракер</strong> за setup.
        <button class="btn ghost sm" style="margin-left:8px;" onclick="Nav.showView('stats-tracker')">Настрой →</button></div>`;
      return;
    }
    const snaps = data.snapshots;
    const latest = snaps[snaps.length - 1];
    const videos = latest.videos || [];

    // Performance Check: сравнява views/ден-от-качване спрямо медианата на канала
    const rates = videos.map(v => {
      const days = Math.max(1, (new Date(latest.date) - new Date(v.published_at)) / 86400000);
      return { ...v, perDay: (v.views || 0) / days };
    });
    const sortedRates = [...rates].map(r => r.perDay).sort((a, b) => a - b);
    const median = sortedRates[Math.floor(sortedRates.length / 2)] || 1;

    el.innerHTML = `
      <div class="card" style="height:300px;"><canvas id="analyticsChart"></canvas></div>
      <div class="card" style="margin-top:14px;">
        <strong>Всички видеа — Performance Check</strong>
        <table class="data" style="margin-top:10px;"><thead><tr><th>Видео</th><th>Гледания</th><th>Views/ден</th><th>Perf.</th></tr></thead>
        <tbody>${rates.map(v => {
          const ratio = v.perDay / median;
          const chip = ratio > 1.3 ? '<span class="chip green">Отлично</span>' : ratio > 0.8 ? '<span class="chip cyan">Добре</span>' : '<span class="chip amber">Средно</span>';
          return `<tr><td>${v.title}</td><td>${(v.views || 0).toLocaleString()}</td><td>${v.perDay.toFixed(0)}</td><td>${chip}</td></tr>`;
        }).join("")}
        </tbody></table>
      </div>
      <div class="card" id="topMoversCard" style="margin-top:14px;">⏳ Зареждам Top Movers...</div>
      <div class="card" id="trendNichesCard" style="margin-top:14px;">⏳ Зареждам трендващи ниши...</div>`;
    this._drawChart("analyticsChart", snaps);
    this.renderTopMovers();
    this.renderTrendNiches();
  },

  _drawChart(canvasId, snaps) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === "undefined") return;
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    canvas._chartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels: snaps.map(s => s.date),
        datasets: [
          { label: "Абонати", data: snaps.map(s => s.channel?.subscribers || 0), borderColor: "#8b5cf6", backgroundColor: "transparent", tension: .35 },
          { label: "Гледания", data: snaps.map(s => s.channel?.total_views || 0), borderColor: "#22d3ee", backgroundColor: "transparent", tension: .35, yAxisID: "y1" }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { ticks: { color: "#8b8fb0" }, grid: { color: "#25263f" } },
          y1: { position: "right", ticks: { color: "#8b8fb0" }, grid: { display: false } },
          x: { ticks: { color: "#8b8fb0" }, grid: { color: "#1d1e35" } }
        },
        plugins: { legend: { labels: { color: "#eef0fb" } } }
      }
    });
  }
};

/* =========================================================
   INIT
   ========================================================= */
/* =========================================================
   RESTORE UI — хидратира екрана от localStorage след презареждане
   Преди това: AppState.save() пазеше всичко, но при F5 полетата
   (заглавие, текст, Viral Report...) оставаха празни, въпреки че
   данните бяха налични. Сега при зареждане екранът се "връща" на
   мястото, където си спрял — без нищо да е загубено.
   ========================================================= */
function restoreUI() {
  const p = AppState.data?.project;
  if (!p) return;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = "block"; };

  setVal("songTitle", p.title);
  setVal("stylePrompt", p.stylePrompt);
  setVal("lyricsOut", p.lyrics);
  if (p.nicheScore != null) setVal("nicheScore", p.nicheScore + "/100");

  if (p.hashtags?.length) {
    const h = document.getElementById("hashtagsOut");
    if (h) h.innerHTML = p.hashtags.map(x => `<span>${x}</span>`).join("");
  }
  if (p.title) { show("conceptCard"); show("albumSprintCard"); }

  if (p.niches?.length) {
    const el = document.getElementById("nicheResults");
    if (el) {
      el.innerHTML = p.niches.map(r => {
        const color = r.score > 75 ? "🟢" : r.score > 50 ? "🟡" : "⚪";
        return `<div class="copy-field"><span>${color} <strong>${r.niche}</strong> — ${r.score}/100<br><span class="muted">${r.reason || ""}</span></span></div>`;
      }).join("");
    }
  }
  if (p.viralReport) ViralLab.render(p.viralReport);
}

window.addEventListener("DOMContentLoaded", () => {
  Nav.init();
  restoreUI();
  Step3.buildDistrokidFields();
  GeminiValidator.render();
  SystemLog.init();
  Prefs.init();
  Stats.renderDashboard();
  QuickUpload.initListener();

  // Зареждаме Google Identity Services скрипта динамично
  const gsi = document.createElement("script");
  gsi.src = "https://accounts.google.com/gsi/client";
  gsi.onload = () => Step4.initGoogleAuth();
  document.head.appendChild(gsi);
});
