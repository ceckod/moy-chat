/* =========================================================
   CD-B Records — Control Dashboard
   Един файл SPA логика. Всичко локално (localStorage).
   ========================================================= */

const STORAGE_KEY = "cdb_dashboard_state_v1";
const KEYS_STORAGE = "cdb_dashboard_keys_v1";

// Безплатен Gemini модел, използван навсякъде в приложението.
// "gemini-3.1-flash-lite" има най-високата дневна квота от безплатните модели (юли 2026).
// Смени САМО тук, ако искаш друг модел — всички извиквания го четат оттук.
const GEMINI_MODEL = "gemini-3.1-flash-lite";

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

/* ---------- TOAST ---------- */
function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.style.display = "none"), ms);
}

/* ---------- NAVIGATION (sidebar multi-view router) ---------- */
const Nav = {
  current: "dashboard",
  init() {
    AppState.load();
    this.showView(this.current, /*skipRender*/ false);
  },
  showView(id) {
    this.current = id;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + id));
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === id));
    if (id === "step2") Step2.syncTitleToVisualizer();
    if (id === "dashboard") Stats.renderDashboard();
    if (id === "stats-analytics") Stats.renderAnalytics();
    if (id === "set-keys" || id === "set-proxy") Settings.fillFields();
    if (id === "stats-tracker") Settings.fillFields();
    window.scrollTo(0, 0);
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

    // Claude
    if (!k.claude) lines.push("Claude: ⚪ няма ключ");
    else {
      try {
        const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": k.claude,
                     "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
        });
        lines.push(r.ok ? "Claude: ✅ работи" : `Claude: ❌ ${r.status}`);
      } catch (e) { lines.push("Claude: ❌ " + e.message); }
    }

    // Gemini — ползваме "gemini-3.1-flash-lite" (безплатен tier, най-висока дневна
    // квота от всички безплатни модели към юли 2026). "gemini-3.5-flash" също е
    // безплатен, но с по-ниска дневна квота — смени тук, ако предпочиташ него.
    // Pro моделите (gemini-3.1-pro и др.) вече изискват активен billing.
    // Ако това пак спре да работи, провери https://ai.google.dev/gemini-api/docs/models
    if (!k.gemini) lines.push("Gemini: ⚪ няма ключ");
    else {
      try {
        const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${k.gemini}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
        });
        lines.push(r.ok ? "Gemini: ✅ работи" : `Gemini: ❌ ${r.status}`);
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
    return lines;
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
        const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${k.gemini}`, {
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
    localStorage.removeItem(STORAGE_KEY);
    AppState.load();
    GeminiValidator.render();
    Stats.renderDashboard();
    const nr = document.getElementById("nicheResults"); if (nr) nr.innerHTML = "";
    const cc = document.getElementById("conceptCard"); if (cc) cc.style.display = "none";
    const lo = document.getElementById("lyricsOut"); if (lo) lo.value = "";
    toast("Нов, чист проект 🆕");
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

async function callClaude(prompt, maxTokens = 1200) {
  const k = Keys.load();
  if (!k.claude) { toast("⚠️ Липсва Claude API ключ (виж Настройки)"); throw new Error("no key"); }

  const res = await fetchTimeout(proxied("https://api.anthropic.com/v1/messages"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": k.claude,
      "anthropic-version": "2023-06-01",
      // Позволява директно извикване от браузъра (без бекенд прокси)
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  }, 45000); // по-дълъг timeout — генериране на текст отнема повече от кратка проверка
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Claude API грешка: " + t);
  }
  const data = await res.json();
  return data.content.map(b => b.text || "").join("\n").trim();
}

async function callGemini(prompt, useSearch = false) {
  const k = Keys.load();
  if (!k.gemini) { toast("⚠️ Липсва Gemini API ключ (виж Настройки)"); throw new Error("no key"); }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${k.gemini}`;
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  // Google Search grounding — дава на Gemini достъп до РЕАЛНИ, актуални резултати
  // от търсачката (вместо само познания от тренировъчните данни).
  if (useSearch) body.tools = [{ google_search: {} }];

  // Retry с exponential backoff при 429 (изчерпана квота) — на безплатния tier
  // временните rate-limit грешки са чести; изчакването на 2с/4с/8с решава повечето.
  const maxRetries = 3;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchTimeout(proxied(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, 45000);
    } catch (e) {
      lastError = e;
      break; // мрежова/timeout грешка — retry тук няма да помогне
    }

    if (res.ok) {
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "(няма отговор)";
    }

    const t = await res.text();
    if (res.status === 429 && attempt < maxRetries) {
      const waitMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      toast(`⏳ Gemini квота — изчаквам ${waitMs / 1000}с и опитвам пак...`, waitMs + 500);
      await new Promise(r => setTimeout(r, waitMs));
      lastError = new Error("Gemini API грешка: " + t);
      continue;
    }
    throw new Error("Gemini API грешка: " + t);
  }
  throw lastError || new Error("Gemini API грешка: неуспешно след повторни опити");
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
   YOUTUBE OUTLIER SCAN
   Търси видеа по ниша, после сверява views/subscribers —
   канали с малко абонати, но много гледания = "outlier" =
   сигнал за висок интерес + слаба конкуренция (VidIQ логика).
   ========================================================= */
async function youtubeOutlierScan(query) {
  const k = Keys.load();
  if (!k.ytApiKey) throw new Error("Няма YouTube Data API Key (виж Настройки)");

  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=15&q=${encodeURIComponent(query)}&key=${k.ytApiKey}`;
  const sRes = await fetchTimeout(proxied(searchUrl));
  if (!sRes.ok) throw new Error("YouTube search грешка: " + (await sRes.text()));
  const sData = await sRes.json();
  const items = sData.items || [];
  if (!items.length) return { outliers: [], totalChecked: 0 };

  const videoIds = items.map(i => i.id.videoId).filter(Boolean);
  const channelIds = [...new Set(items.map(i => i.snippet.channelId))];

  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(",")}&key=${k.ytApiKey}`;
  const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds.join(",")}&key=${k.ytApiKey}`;
  const [vRes, cRes] = await Promise.all([fetch(proxied(videosUrl)), fetch(proxied(channelsUrl))]);
  if (!vRes.ok) throw new Error("YouTube videos.list грешка: " + (await vRes.text()));
  if (!cRes.ok) throw new Error("YouTube channels.list грешка: " + (await cRes.text()));
  const vData = await vRes.json();
  const cData = await cRes.json();

  const viewsById = {};
  (vData.items || []).forEach(v => viewsById[v.id] = parseInt(v.statistics?.viewCount || "0", 10));
  const subsById = {};
  (cData.items || []).forEach(c => subsById[c.id] = parseInt(c.statistics?.subscriberCount || "0", 10));

  const combined = items.map(i => {
    const views = viewsById[i.id.videoId] || 0;
    const subs = subsById[i.snippet.channelId] || 0;
    const ratio = views / Math.max(subs, 1);
    return { title: i.snippet.title, channel: i.snippet.channelTitle, views, subs, ratio };
  });

  const outliers = combined
    .filter(x => x.subs < 10000 && x.views > 20000 || x.ratio > 15)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);

  return { outliers, totalChecked: combined.length };
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
  cons
