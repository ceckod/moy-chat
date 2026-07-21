/* =========================================================
   CD-B Records — Control Dashboard
   Един файл SPA логика. Всичко локално (localStorage).
   ========================================================= */

const STORAGE_KEY = "cdb_dashboard_state_v1";
const KEYS_STORAGE = "cdb_dashboard_keys_v1";

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

/* ---------- NAVIGATION / CHECKLIST ---------- */
const Nav = {
  init() {
    AppState.load();
    this.render();
  },
  goTo(step) {
    AppState.data.currentStep = step;
    // ако стъпката е сива (未посетена) и я отваряш, я маркирай синя (in progress)
    if (AppState.data.status[step] === "grey") AppState.data.status[step] = "blue";
    AppState.save();
    this.render();
    if (step === 2) Step2.syncTitleToVisualizer();
  },
  completeStep(step) {
    AppState.data.status[step] = "green";
    const next = step + 1;
    if (next <= 4 && AppState.data.status[next] === "grey") {
      AppState.data.status[next] = "blue";
    }
    AppState.data.currentStep = Math.min(next, 4);
    AppState.save();
    this.render();
    toast(`Стъпка ${step} завършена ✅`);
  },
  render() {
    for (let i = 1; i <= 4; i++) {
      document.getElementById(`panel-${i}`).classList.toggle("active", AppState.data.currentStep === i);
      document.querySelector(`.step-btn[data-step="${i}"]`).classList.toggle("active", AppState.data.currentStep === i);
      const dot = document.getElementById(`dot-${i}`);
      dot.className = "dot " + AppState.data.status[i];
    }
    const doneCount = Object.values(AppState.data.status).filter(s => s === "green").length;
    document.getElementById("progressFill").style.width = (doneCount / 4 * 100) + "%";
  }
};

/* ---------- SETTINGS MODAL ---------- */
const Settings = {
  open() {
    const k = Keys.load();
    document.getElementById("key_claude").value = k.claude || "";
    document.getElementById("key_gemini").value = k.gemini || "";
    document.getElementById("key_yt_client_id").value = k.ytClientId || "";
    document.getElementById("key_yt_apikey").value = k.ytApiKey || "";
    document.getElementById("key_proxy_url").value = k.proxyUrl || "";
    document.getElementById("keyTestOut").textContent = "";
    document.getElementById("settingsModal").classList.add("open");
  },
  close() {
    document.getElementById("settingsModal").classList.remove("open");
  },
  save() {
    Keys.save({
      claude: document.getElementById("key_claude").value.trim(),
      gemini: document.getElementById("key_gemini").value.trim(),
      ytClientId: document.getElementById("key_yt_client_id").value.trim(),
      ytApiKey: document.getElementById("key_yt_apikey").value.trim(),
      proxyUrl: document.getElementById("key_proxy_url").value.trim().replace(/\/$/, ""),
    });
    toast("Ключовете са запазени локално 🔒");
    this.close();
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
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": k.claude,
                     "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
        });
        lines.push(r.ok ? "Claude: ✅ работи" : `Claude: ❌ ${r.status}`);
      } catch (e) { lines.push("Claude: ❌ " + e.message); }
    }

    // Gemini
    if (!k.gemini) lines.push("Gemini: ⚪ няма ключ");
    else {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${k.gemini}`, {
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
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${k.ytApiKey}`);
        lines.push(r.ok ? "YouTube API Key: ✅ работи" : `YouTube API Key: ❌ ${r.status}`);
      } catch (e) { lines.push("YouTube API Key: ❌ " + e.message); }
    }

    lines.push("YouTube OAuth Client ID: проверява се само при 🔑 Вход с Google в Стъпка 4");
    out.textContent = lines.join("\n");
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
        if (!parsed.project) throw new Error("Файлът не изглежда като валиден CD-B проект");
        AppState.data = parsed;
        AppState.save();
        Nav.render();
        GeminiValidator.render();
        toast("Проектът е импортиран ✅");
        this.close();
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
    Nav.render();
    GeminiValidator.render();
    document.getElementById("nicheResults").innerHTML = "";
    document.getElementById("conceptCard").style.display = "none";
    document.getElementById("lyricsOut").value = "";
    toast("Нов, чист проект 🆕");
    this.close();
  }
};

/* =========================================================
   API HELPERS
   ========================================================= */

// Ако е зададен Proxy URL в Настройки, минаваме заявките през него
// (полезно при CORS грешки, напр. с някои Imagen endpoint-и).
// Прокси-то се очаква да приема ?target=ORIGINAL_URL и да препраща
// метод/хедъри/тяло 1:1 към него.
function proxied(url) {
  const k = Keys.load();
  if (!k.proxyUrl) return url;
  return `${k.proxyUrl}?target=${encodeURIComponent(url)}`;
}

async function callClaude(prompt, maxTokens = 1200) {
  const k = Keys.load();
  if (!k.claude) { toast("⚠️ Липсва Claude API ключ (виж Настройки)"); throw new Error("no key"); }

  const res = await fetch(proxied("https://api.anthropic.com/v1/messages"), {
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
  });
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${k.gemini}`;
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  // Google Search grounding — дава на Gemini достъп до РЕАЛНИ, актуални резултати
  // от търсачката (вместо само познания от тренировъчните данни).
  if (useSearch) body.tools = [{ google_search: {} }];

  const res = await fetch(proxied(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Gemini API грешка: " + t);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "(няма отговор)";
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
    if (!el) return;
    const log = (AppState.data.project.geminiLog || []);
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
  const sRes = await fetch(proxied(searchUrl));
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
  const res = await fetch(proxied(url));
  if (!res.ok) throw new Error("Suggest заявка неуспешна: " + res.status);
  const data = await res.json();
  return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 10) : [];
}


const Step1 = {
  // Главен бутон "🔍 Предложение за песен".
  // Ако textarea-та е празна → автоматично сканиране на трендове (Gemini + Google Search grounding).
  // Ако потребителят е въвел свои ниши → сравнява точно тях (старото поведение).
  async scanNiches() {
    const raw = document.getElementById("nicheInput").value.trim();
    if (raw) return this._scoreGivenNiches(raw.split("\n").map(s => s.trim()).filter(Boolean));
    return this._autoTrendScan();
  },

  // РЕАЛНО сканиране: Gemini с Google Search grounding търси текущи данни
  // за музикални жанрове в Google/YouTube Trends и оценява търсене vs конкуренция.
  async _autoTrendScan() {
    document.getElementById("nicheResults").innerHTML = "⏳ Сканирам Google/YouTube Trends...";
    const k = Keys.load();
    if (!k.gemini) {
      document.getElementById("nicheResults").innerHTML = "⚠️ Нужен е Gemini API ключ (виж Настройки) за реално сканиране на трендове.";
      return toast("⚠️ Добави Gemini ключ в Настройки за авто-сканиране");
    }

    const prompt = `Ти си музикален A&R / SEO анализатор. Използвай Google Search, за да провериш
КАКВО Е АКТУАЛНО СЕГА (${new Date().toISOString().slice(0, 10)}) по отношение на музикални жанрове/ниши
с растящ интерес в Google Trends и YouTube (нови/набиращи популярност звучения — напр. Balkan phonk,
drift phonk, sad boy hyperpop, latin trap, sped up remixes, dark folk и подобни — но провери РЕАЛНО, не познавай).

За всяка от 5-те най-интересни намерени ниши прецени:
- search_signal: качествена оценка на нивото на търсене/интерес (расте/стабилно/спада + защо)
- competition_signal: колко много подобно съдържание вече се качва (ниска/средна/висока конкуренция)
- score: число 0-100 = комбинация (високо търсене + ниска конкуренция = висок score)
- reason: 1 изречение обяснение защо точно сега

Върни САМО чист JSON масив, без обяснения извън него, формат:
[{"niche":"...", "score":number, "reason":"...", "search_signal":"...", "competition_signal":"..."}]`;

    try {
      const raw2 = await callGemini(prompt, true); // true = Google Search grounding включено
      const results = extractJson(raw2);
      results.sort((a, b) => b.score - a.score);
      this._renderNicheResults(results, true);
      GeminiValidator.autoReview("Стъпка 1 — Trend Scan", JSON.stringify(results));
    } catch (e) {
      document.getElementById("nicheResults").innerHTML = "❌ " + e.message +
        "<br><span class='muted'>Ако продължава, въведи 2-3 ниши ръчно в полето отгоре и натисни бутона пак.</span>";
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

    let html = fromTrendScan ? `<p class="muted">🔴 Live сканиране чрез Gemini + Google Search</p>` : "";
    results.forEach(r => {
      const color = r.score > 75 ? "🟢" : r.score > 50 ? "🟡" : "⚪";
      const signals = (r.search_signal || r.competition_signal)
        ? `<br><span class="muted">Търсене: ${r.search_signal || "—"} · Конкуренция: ${r.competition_signal || "—"}</span>` : "";
      html += `<div class="copy-field"><span>${color} <strong>${r.niche}</strong> — ${r.score}/100<br><span class="muted">${r.reason}</span>${signals}</span></div>`;
    });
    document.getElementById("nicheResults").innerHTML = html;

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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${k.gemini}`;
      const res = await fetch(proxied(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Square album cover art, 3000x3000px composition: ${prompt}` }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
        })
      });
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
   INIT
   ========================================================= */
window.addEventListener("DOMContentLoaded", () => {
  Nav.init();
  Step3.buildDistrokidFields();
  GeminiValidator.render();

  // Зареждаме Google Identity Services скрипта динамично
  const gsi = document.createElement("script");
  gsi.src = "https://accounts.google.com/gsi/client";
  gsi.onload = () => Step4.initGoogleAuth();
  document.head.appendChild(gsi);
});
