/* =========================================================
   CD-B Records — Control Dashboard
   Един файл SPA логика. Всичко локално (localStorage).
   ========================================================= */

const STORAGE_KEY = "cdb_dashboard_state_v1";
const KEYS_STORAGE = "cdb_dashboard_keys_v1";

// Безплатен Gemini модел, използван навсякъде в приложението.
// "gemini-2.5-flash-lite" има най-високата дневна квота от безплатните модели (юли 2026).
// Смени САМО тук, ако искаш друг модел — всички извиквания го четат оттук.
const GEMINI_MODEL = "gemini-2.5-flash-lite";

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

    // Gemini — ползваме "gemini-2.5-flash-lite" (безплатен tier, най-висока дневна
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
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
  const res = await fetchTimeout(proxied(url));
  if (!res.ok) throw new Error("Suggest заявка неуспешна: " + res.status);
  const data = await res.json();
  return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 10) : [];
}


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
      const raw2 = await callClaude(prompt, 600);
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
    el.innerHTML = "⏳ Проверявам YouTube outliers...";
    try {
      const { outliers, totalChecked } = await youtubeOutlierScan(niche);
      if (!outliers.length) {
        el.innerHTML = `<p class="muted">📊 Провери ${totalChecked} видеа за "${niche}" — няма ясни outliers (нишата е или наситена, или все още много малка).</p>`;
        return;
      }
      let html = `<strong style="font-size:13px;">📊 YouTube Outliers за "${niche}"</strong><p class="muted">Малки канали с непропорционално много гледания — сигнал за търсене без силна конкуренция:</p>`;
      outliers.forEach(o => {
        html += `<div class="copy-field"><span><strong>${o.channel}</strong> — ${o.views.toLocaleString()} views / ${o.subs.toLocaleString()} абонати (×${o.ratio.toFixed(1)})<br><span class="muted">${o.title}</span></span></div>`;
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
      const raw = await callClaude(prompt, 1800);
      const list = extractJson(raw);
      AppState.data.project.albumSprint = list;
      AppState.save();
      let html = "";
      list.forEach((c, i) => {
        html += `<div class="copy-field"><span><strong>${c.title}</strong> <span class="muted">(${c.mood})</span><br>"${c.hook}"</span>
          <button onclick="Step1.useAlbumIdea(${i})">➡️ Ползвай</button></div>`;
      });
      document.getElementById("albumSprintOut").innerHTML = html;
      GeminiValidator.autoReview("Стъпка 1 — Album Sprint", JSON.stringify(list));
    } catch (e) {
      document.getElementById("albumSprintOut").innerHTML = "❌ " + e.message;
    }
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
      const raw = await callClaude(prompt, 400);
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
    const prompt = `Напиши текст на песен в жанр "${niche}", със заглавие "${title}".
ЗАДЪЛЖИТЕЛНО:
- [Chorus] секцията да е НАЙ-ОТПРЕД (преди първия куплет)
- Използвай ясни мета-тагове: [Chorus], [Verse], [Drop] (ако жанрът позволява drop)
- Текстът да е готов за качване в Suno AI
Върни само текста с таговете, без допълнителни обяснения.`;
    document.getElementById("lyricsOut").value = "⏳ Генерирам...";
    try {
      const lyrics = await callClaude(prompt, 900);
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
      const raw = await callClaude(prompt, 300);
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
      const p = await callClaude(prompt, 300);
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
      const raw = await callClaude(prompt, 500);
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
      const raw = await callClaude(prompt, 500);
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
        document.getElementById("gAuthStatus").textContent = "✅ Вписан";
        document.getElementById("gAuthStatus").className = "badge ok";
        toast("Успешен вход в Google");
      }
    });
    document.getElementById("gSignInBtn").innerHTML =
      `<button class="ghost" onclick="Step4.tokenClient.requestAccessToken()">🔑 Вход с Google</button>`;
  },

  async uploadVideo() {
    if (!this.accessToken) return toast("⚠️ Първо влез с Google бутона по-горе");
    const fileInput = document.getElementById("youtubeVideoFile");
    if (!fileInput.files.length) return toast("Избери видео файл");
    const file = fileInput.files[0];

    const title = document.getElementById("ytTitle").value || AppState.data.project.title || "Untitled";
    const description = document.getElementById("ytDescription").value;
    const tags = document.getElementById("ytTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const madeForKids = document.getElementById("ytMadeForKids").checked;

    const metadata = {
      snippet: { title, description, tags },
      status: {
        privacyStatus: "unlisted", // ЗАДЪЛЖИТЕЛНО — не се променя
        selfDeclaredMadeForKids: madeForKids,
        containsSyntheticMedia: true // Synthetic/AI content отметка
      }
    };

    document.getElementById("ytUploadProgress").textContent = "⏳ Качвам видеото...";
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

      document.getElementById("ytUploadProgress").innerHTML =
        `✅ Качено! Video ID: <strong>${result.id}</strong> (unlisted)`;
      AppState.data.project.youtube = { videoId: result.id, title };
      AppState.save();
    } catch (e) {
      document.getElementById("ytUploadProgress").textContent = "❌ " + e.message;
    }
  }
};

/* =========================================================
   PREFS — тема (тъмна/светла) + тихa проверка на ключовете
   ========================================================= */
const PREFS_STORAGE = "cdb_dashboard_prefs_v1";
const Prefs = {
  data: { theme: "dark", healthCheck: true },
  load() {
    const raw = localStorage.getItem(PREFS_STORAGE);
    this.data = raw ? JSON.parse(raw) : this.data;
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
  init() {
    this.load();
    this.applyTheme();
    this.applyHealthSwitch();
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
      </div>`;
    this._drawChart("analyticsChart", snaps);
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
window.addEventListener("DOMContentLoaded", () => {
  Nav.init();
  Step3.buildDistrokidFields();
  GeminiValidator.render();
  SystemLog.init();
  Prefs.init();
  Stats.renderDashboard();

  // Зареждаме Google Identity Services скрипта динамично
  const gsi = document.createElement("script");
  gsi.src = "https://accounts.google.com/gsi/client";
  gsi.onload = () => Step4.initGoogleAuth();
  document.head.appendChild(gsi);
});
