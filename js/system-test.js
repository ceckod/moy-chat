/* =========================================================
   SYSTEM TEST — "стимулира" цялото приложение (доколкото е възможно от
   чист браузърен JS, без headless browser/test framework), проверява за
   грешки, и накрая пита цял AI екип (Claude/Gemini/OpenRouter — всеки,
   за когото има зададен ключ) какво може да се добави като нови функции.

   Зареден МАКСИМАЛНО РАНО в index.html (веднага след ui/toast.js), за да
   хване JS грешки от възможно най-голяма част от живота на страницата —
   window.onerror/unhandledrejection се регистрират веднага при парсене на
   този файл, преди всичко останало да се е заредило.

   Останалите проверки (Storage, Keys, AppState, AI ключове...) реално се
   изпълняват само при извикване на SystemTest.runAll(), по който момент
   всички <script> тагове вече са заредени — затова редът в HTML не чупи
   нищо, както при останалите модули (виж бележките в js/network.js).
   ========================================================= */

const SystemTest = {
  // Буфер с JS грешки от текущата сесия (само в паметта — не се пази между
  // презареждания, тъй като целта е "нещо счупи ли се ДОКАТО тествам сега").
  _errors: [],
  _lastResults: null,
  _lastLogId: null, // id на последния запис в историята — Gemini отговорът се допълва към него

  // Ескейпва текст преди да влезе в innerHTML — AI отговорите/грешките са
  // произволен текст (може да съдържа "<", ">", "&"), и без това биха се
  // интерпретирали като HTML и чупили визуално картата вместо да се покажат
  // като текст.
  _esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  },

  /* ---------- ИСТОРИЯ (последните 10 теста, с дата/час + Gemini отговор) ---------- */
  _LOG_KEY: "cdb_system_test_log_v1",
  _LOG_MAX: 10,

  _loadLog() {
    return Storage.get(this._LOG_KEY) || [];
  },
  _saveLog(list) {
    Storage.set(this._LOG_KEY, list.slice(0, this._LOG_MAX));
  },
  // Добавя нов запис най-отпред, връща генерирания id (използваме ts като id).
  _pushLogEntry(results) {
    const log = this._loadLog();
    const entry = {
      id: Date.now(),
      ts: Date.now(),
      okCount: results.filter(r => r.status === "ok").length,
      warnCount: results.filter(r => r.status === "warn").length,
      failCount: results.filter(r => r.status === "fail").length,
      results: results.map(r => ({ name: r.name, status: r.status, detail: r.detail })),
      agentIdeas: null // масив {agent, label, text, error} — виж _attachAgentIdeas()
    };
    log.unshift(entry);
    this._saveLog(log);
    return entry.id;
  },
  // Допълва отговорите на AI екипа към записа, генериран от последния runAll().
  _attachAgentIdeas(agentResults) {
    if (!this._lastLogId) return;
    const log = this._loadLog();
    const entry = log.find(e => e.id === this._lastLogId);
    if (entry) { entry.agentIdeas = agentResults; this._saveLog(log); }
  },
  _fmtDate(ts) {
    return new Date(ts).toLocaleString("bg-BG", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  },

  renderHistory() {
    const el = document.getElementById("systemTestHistoryOut");
    if (!el) return;
    const log = this._loadLog();
    if (!log.length) { el.innerHTML = `<p class="muted">Още няма пуснати тестове.</p>`; return; }
    const icon = (s) => s === "ok" ? "✅" : s === "warn" ? "🟡" : "❌";
    el.innerHTML = log.map((entry, i) => {
      const overall = entry.failCount ? "❌" : entry.warnCount ? "🟡" : "✅";
      const detailsId = `sysTestDetail_${entry.id}`;
      return `
        <div class="card tight" style="margin-top:${i === 0 ? 0 : 8}px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;" onclick="document.getElementById('${detailsId}').style.display = document.getElementById('${detailsId}').style.display === 'none' ? 'block' : 'none';">
            <span><strong>${overall} ${this._fmtDate(entry.ts)}</strong> <span class="muted">— ${entry.okCount} ✅ / ${entry.warnCount} 🟡 / ${entry.failCount} ❌</span></span>
            <span class="muted" style="font-size:11px;">${entry.agentIdeas?.length ? `🤖 ${entry.agentIdeas.length} AI отговора` : "без AI отговори"} · разгъни ▾</span>
          </div>
          <div id="${detailsId}" style="display:none;margin-top:10px;">
            ${entry.results.map(r => `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border-soft);">${icon(r.status)} <strong>${this._esc(r.name)}</strong> — <span class="muted">${this._esc(r.detail)}</span></div>`).join("")}
            ${(entry.agentIdeas || []).map(a => `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);white-space:pre-wrap;font-size:12.5px;line-height:1.6;"><strong>🤖 ${a.label}:</strong><br>${a.error ? `<span class="muted">❌ ${this._esc(a.error)}</span>` : this._esc(a.text)}</div>`).join("")}
          </div>
        </div>`;
    }).join("");
  },

  /* ---------- АРХИВ ОТ ИДЕИ (всяко реално предложение от AI екипа, не
     грешки) — пази се трайно в localStorage, независимо от 10-те последни
     теста в _LOG_KEY по-горе. Потребителят маркира кои е изградил, и точно
     тези "изградени" се подават обратно на AI екипа в следващия prompt,
     за да не предлага пак нещо вече готово. ---------- */
  _IDEAS_KEY: "cdb_ai_ideas_v1",
  _IDEAS_MAX: 200,

  _loadIdeas() {
    try { return Storage.get(this._IDEAS_KEY) || []; } catch (e) { return []; }
  },
  _saveIdeas(list) {
    Storage.set(this._IDEAS_KEY, list.slice(0, this._IDEAS_MAX));
  },
  // Разбива ЕДИН отговор на AI агент (текст с няколко предложения наведнъж)
  // на отделни идеи, всяка със СВОЕ заглавие — вместо да пазим целия
  // отговор като едно голямо "предложение" в архива. Заглавието е важно:
  // по него потребителят по-късно разпознава коя идея е изградил, и по
  // него AI екипът се научава кое вече е готово (виж askAgentPanelForIdeas).
  // Очакван формат от prompt-а: всеки ред от нов номериран/точков елемент
  // започва с **Заглавие** (удебелено), последвано от тире/двоеточие и
  // описание — стандартен маркдаун стил, който повечето модели следват
  // естествено, а тук допълнително им го изискваме изрично в prompt-а.
  _splitIdeas(text) {
    const markerRe = /^\s*(?:\d+[.)]|[-•*])\s*\*\*(.+?)\*\*/gm;
    const marks = [...text.matchAll(markerRe)];
    if (!marks.length) {
      // Форматът не съвпадна (моделът не следва инструкцията) — по-добре
      // една идея с разумно заглавие, отколкото нищо записано в архива.
      const fallbackTitle = text.replace(/\s+/g, " ").trim().slice(0, 70) || "Идея";
      return [{ title: fallbackTitle, body: text.trim() }];
    }
    const items = [];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      const title = marks[i][1].replace(/[:\-–—]+$/, "").trim();
      const body = text.slice(start, end).trim();
      if (title && body) items.push({ title, body });
    }
    return items.length ? items : [{ title: text.trim().slice(0, 70) || "Идея", body: text.trim() }];
  },

  // Записва само РЕАЛНИ предложения (a.error е null) — не пълним архива с
  // провалени/грешни отговори. Всеки отговор се разбива на отделни идеи
  // Общ нормализатор на заглавие, ползван и от _recordIdeas, и от ръчното
  // добавяне по-долу — едно и също заглавие (без значение на главни/малки
  // букви и излишни интервали) винаги сочи към ЕДИН и същ запис в архива.
  _normTitle(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); },

  // (_splitIdeas), и всяка се дедуплицира по (agent + заглавие, без
  // главни/малки букви и излишни интервали) — не по целия текст, за да
  // разпознаваме една и съща идея дори при леко преформулирано описание.
  _recordIdeas(agentResults) {
    const list = this._loadIdeas();
    let added = 0;
    for (const a of agentResults) {
      if (a.error || !a.text) continue;
      for (const idea of this._splitIdeas(a.text)) {
        const dup = list.some(it => it.agent === a.agent && this._normTitle(it.title) === this._normTitle(idea.title));
        if (dup) continue;
        list.unshift({
          id: `${Date.now()}_${a.agent}_${Math.random().toString(36).slice(2, 7)}`,
          ts: Date.now(), agent: a.agent, label: a.label, title: idea.title, text: idea.body, built: false
        });
        added++;
      }
    }
    if (added) this._saveIdeas(list);
    return added;
  },

  // Ръчно добавяне/маркиране — за случаите, в които идеята НЕ е минала
  // първо през "🤖 Питай AI екипа" в тази инсталация (напр. предложена в
  // друг разговор с Claude, или вече записана в README, но архивът в
  // browser localStorage е бил изчистен). Ако вече има запис със СЪЩОТО
  // заглавие (без значение кой агент), просто го маркира изграден вместо
  // да дублира; иначе създава нов, директно маркиран built:true — така
  // веднага влиза в списъка "вече изградени", подаван на AI екипа.
  addManualIdea(title, text) {
    title = (title || "").trim();
    if (!title) { toast("⚠️ Трябва заглавие (точно както искаш AI екипът да го разпознава)"); return; }
    const list = this._loadIdeas();
    const existing = list.find(it => this._normTitle(it.title) === this._normTitle(title));
    if (existing) {
      existing.built = true;
      if (text && text.trim()) existing.text = text.trim();
      this._saveIdeas(list);
      toast(`✅ "${title}" вече е маркирана като изградена`);
    } else {
      list.unshift({
        id: `${Date.now()}_manual_${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(), agent: "manual", label: "Ръчно добавена", title, text: (text || "").trim() || "(без описание)", built: true
      });
      this._saveIdeas(list);
      toast(`✅ "${title}" добавена в архива като изградена`);
    }
    this.renderIdeaBacklog();
  },
  toggleIdeaBuilt(id) {
    const list = this._loadIdeas();
    const it = list.find(i => i.id === id);
    if (!it) return;
    it.built = !it.built;
    this._saveIdeas(list);
    this.renderIdeaBacklog();
  },
  deleteIdea(id) {
    this._saveIdeas(this._loadIdeas().filter(i => i.id !== id));
    this.renderIdeaBacklog();
  },
  // Заглавието е задължителен идентификатор за всяка нова идея (виж
  // _splitIdeas); стари записи от преди тази версия може да го нямат —
  // за тях просто показваме първите думи от текста вместо заглавие.
  _titleOf(it) {
    return it.title || (it.text || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Идея";
  },

  renderIdeaBacklog() {
    const el = document.getElementById("aiIdeaBacklogOut");
    if (!el) return;
    const list = this._loadIdeas();
    if (!list.length) {
      el.innerHTML = `<p class="muted">Още няма записани идеи — пусни "🤖 Питай AI екипа за нови функции" в Системен тест; всяка отделна идея (със заглавие) автоматично се записва тук.</p>`;
      return;
    }
    const q = (document.getElementById("aiIdeaSearch")?.value || "").toLowerCase().trim();
    const filtered = q ? list.filter(it => this._titleOf(it).toLowerCase().includes(q)) : list;
    const builtCount = list.filter(i => i.built).length;
    const header = `<p class="muted" style="margin:0 0 10px;">${list.length} записани общо, ${builtCount} маркирани като изградени (AI екипът вече вижда заглавията им като готови и не ги предлага пак)${q ? ` · ${filtered.length} съвпадат с търсенето` : ""}.</p>`;
    if (!filtered.length) { el.innerHTML = header + `<p class="muted">Нищо не съвпада с "${this._esc(q)}".</p>`; return; }
    el.innerHTML = header + filtered.map(it => `
      <div class="card tight" style="margin-top:8px;${it.built ? "opacity:.55;" : ""}">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;flex-wrap:wrap;">
          <div>
            <strong style="font-size:13.5px;">${it.built ? "✅ " : ""}${this._esc(this._titleOf(it))}</strong><br>
            <span class="muted" style="font-size:11px;">🤖 ${this._esc(it.label)} · ${this._fmtDate(it.ts)}</span>
          </div>
          <div class="row" style="gap:6px;flex-shrink:0;">
            <button class="btn ghost sm" onclick="SystemTest.toggleIdeaBuilt('${it.id}')">${it.built ? "↩️ Върни в опашката" : "✅ Маркирай като изградено"}</button>
            <button class="btn ghost sm" onclick="SystemTest.deleteIdea('${it.id}')">🗑️</button>
          </div>
        </div>
        <div style="margin-top:8px;white-space:pre-wrap;font-size:12.5px;line-height:1.6;">${this._esc(it.text)}</div>
      </div>`).join("");
  },

  _captureError(kind, message, detail) {
    this._errors.push({ ts: Date.now(), kind, message: String(message).slice(0, 300), detail });
    if (this._errors.length > 50) this._errors.shift(); // не расте безкрайно
  },

  init() {
    window.addEventListener("error", (e) => {
      this._captureError("js-error", e.message, `${e.filename || "?"}:${e.lineno || "?"}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this._captureError("unhandled-promise", e.reason?.message || String(e.reason), "");
    });
  },

  /* ---------- отделни проверки — всяка връща {name, status, detail} ----------
     status: "ok" | "warn" | "fail" */

  _checkStorageRoundtrip() {
    try {
      const testKey = "cdb_system_test_probe";
      const testVal = { probe: true, ts: Date.now() };
      Storage.set(testKey, testVal);
      const back = Storage.get(testKey);
      Storage.remove(testKey);
      const ok = back && back.probe === true;
      return { name: "localStorage четене/писане", status: ok ? "ok" : "fail",
        detail: ok ? "Storage.get/set/remove работят коректно" : "Записаната и прочетената стойност не съвпадат" };
    } catch (e) {
      return { name: "localStorage четене/писане", status: "fail", detail: e.message };
    }
  },

  _checkStorageSize() {
    try {
      let totalChars = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        totalChars += (k?.length || 0) + (localStorage.getItem(k)?.length || 0);
      }
      const kb = Math.round(totalChars / 1024);
      // Типичен браузърен лимит е ~5-10MB на origin — предупреждаваме отрано, не при счупване.
      const status = kb > 4000 ? "warn" : "ok";
      return { name: "Обем на localStorage", status, detail: `~${kb} KB използвани (${localStorage.length} ключа)` };
    } catch (e) {
      return { name: "Обем на localStorage", status: "fail", detail: e.message };
    }
  },

  _checkAppState() {
    try {
      const p = AppState?.data?.project;
      if (!p) return { name: "AppState цялост", status: "fail", detail: "AppState.data.project липсва" };
      const expectedKeys = ["niches", "title", "lyrics", "distrokid", "youtube"];
      const missing = expectedKeys.filter(k => !(k in p));
      return { name: "AppState цялост", status: missing.length ? "warn" : "ok",
        detail: missing.length ? `Липсващи полета: ${missing.join(", ")}` : "Всички очаквани полета присъстват" };
    } catch (e) {
      return { name: "AppState цялост", status: "fail", detail: e.message };
    }
  },

  _checkVault() {
    try {
      if (!Vault.isEnabled()) return { name: "Vault (криптиране на ключове)", status: "ok", detail: "Изключен (ключовете са чист текст — очаквано, ако не си го включил)" };
      return { name: "Vault (криптиране на ключове)", status: Vault.isUnlocked() ? "ok" : "warn",
        detail: Vault.isUnlocked() ? "Включен и отключен за тази сесия" : "Включен, но ЗАКЛЮЧЕН — AI/GitHub функции няма да работят, докато не въведеш паролата" };
    } catch (e) {
      return { name: "Vault (криптиране на ключове)", status: "fail", detail: e.message };
    }
  },

  _checkServiceWorker() {
    if (!("serviceWorker" in navigator)) return { name: "Offline (Service Worker)", status: "warn", detail: "Браузърът не поддържа Service Worker" };
    const active = !!navigator.serviceWorker.controller;
    return { name: "Offline (Service Worker)", status: active ? "ok" : "warn",
      detail: active ? "Регистриран и активен — offline достъп до черупката работи" : "Все още не е поел контрол (нормално при първо зареждане — презареди веднъж)" };
  },

  _checkRuntimeErrors() {
    if (!this._errors.length) return { name: "JS грешки в тази сесия", status: "ok", detail: "Няма прихванати грешки досега" };
    const sample = this._errors.slice(-3).map(e => `[${e.kind}] ${e.message}`).join(" · ");
    return { name: "JS грешки в тази сесия", status: "warn", detail: `${this._errors.length} прихванати — последни: ${sample}` };
  },

  async _checkApiKeys() {
    // Реално използваме съществуващия Settings.testKeys() — той вече прави
    // истински мрежови проверки за Claude/Gemini/YouTube/Spotify/GitHub и
    // връща масив от текстови редове. Няма смисъл да дублираме логиката.
    // ВАЖНО: testKeys() чете директно от input полетата в Настройки (не от
    // localStorage), а те се пълват само при посещение на този view — затова
    // първо принудително ги синхронизираме тук, за да не показваме грешно
    // "няма ключ", ако потребителят е дошъл направо в Системен тест.
    try {
      Settings.fillFields();
      const lines = await Settings.testKeys();
      const failCount = lines.filter(l => l.includes("❌")).length;
      const okCount = lines.filter(l => l.includes("✅")).length;
      const vaultNote = (Vault.isEnabled() && !Vault.isUnlocked())
        ? " ⚠️ Трезорът е заключен — резултатите по-горе може да казват грешно 'няма ключ', вместо 'заключен'."
        : "";
      return {
        name: "API ключове (Claude/Gemini/OpenRouter/YouTube/Spotify/GitHub)",
        status: failCount ? "warn" : "ok",
        detail: `${okCount} работещи, ${failCount} с грешка — пълен детайл в Настройки → API Ключове.${vaultNote}`,
        rawLines: lines
      };
    } catch (e) {
      return { name: "API ключове", status: "fail", detail: e.message };
    }
  },

  _checkAiReliability() {
    const board = [...AICallLog.getLeaderboard("claude"), ...AICallLog.getLeaderboard("gemini"), ...AICallLog.getLeaderboard("openrouter")];
    if (!board.length) return { name: "AI надеждност (исторически)", status: "ok", detail: "Все още няма история от извиквания на това устройство" };
    const worst = board.reduce((a, b) => (a.rate < b.rate ? a : b));
    const status = worst.rate < 0.5 ? "warn" : "ok";
    return { name: "AI надеждност (исторически)", status,
      detail: `Най-слаб модел: ${worst.model} (${Math.round(worst.rate * 100)}% успех от ${worst.total} опита)` };
  },

  _checkCriticalDom() {
    // Смок тест: проверява дали ключовите контейнери за всеки view съществуват
    // в DOM-а (те винаги стоят там, само се скриват/показват — виж Nav.showView).
    const ids = ["view-dashboard", "view-step1", "view-step2", "view-step3", "view-quick",
      "view-niche-toolkit", "view-validator", "view-set-keys", "view-stats-tracker", "view-system-test", "view-ai-ideas"];
    const missing = ids.filter(id => !document.getElementById(id));
    return { name: "DOM структура (всички view контейнери)", status: missing.length ? "fail" : "ok",
      detail: missing.length ? `Липсват: ${missing.join(", ")}` : `Всички ${ids.length} проверени view-а присъстват` };
  },

  /* ---------- оркестрация ---------- */

  async runAll() {
    const out = document.getElementById("systemTestOut");
    out.innerHTML = `<p class="muted">⏳ Стимулирам системата — Storage, AppState, DOM, Service Worker, после и реални мрежови проверки на ключовете (по-бавно)...</p>`;

    let results;
    try {
      const syncChecks = [
        this._checkStorageRoundtrip(),
        this._checkStorageSize(),
        this._checkAppState(),
        this._checkVault(),
        this._checkServiceWorker(),
        this._checkCriticalDom(),
        this._checkRuntimeErrors(),
        this._checkAiReliability(),
      ];
      const apiCheck = await this._checkApiKeys();
      results = [...syncChecks, apiCheck];
    } catch (e) {
      // Всяка отделна проверка вече се пази сама (връща {status:"fail"} вместо
      // да гърми), но ако нещо неочаквано все пак пропадне тук, не оставяме
      // потребителя завинаги на "⏳ Стимулирам системата..." — показваме
      // ясна грешка вместо да увисне.
      this._captureError("system-test-run", e.message, e.stack || "");
      out.innerHTML = `<div class="card tight" style="border-color:var(--red);">
        <strong>❌ Системният тест гръмна неочаквано</strong><br>
        <span class="muted">${(e.message || String(e)).slice(0, 400)}</span>
      </div>`;
      return;
    }
    this._lastResults = results;
    this._lastLogId = this._pushLogEntry(results);
    this.renderHistory();

    const icon = (s) => s === "ok" ? "✅" : s === "warn" ? "🟡" : "❌";
    const failCount = results.filter(r => r.status === "fail").length;
    const warnCount = results.filter(r => r.status === "warn").length;
    const summary = failCount ? `❌ ${failCount} провалени проверки` : warnCount ? `🟡 ${warnCount} предупреждения, нищо счупено` : "✅ Всичко изглежда наред";

    out.innerHTML = `
      <div class="card tight" style="margin-bottom:10px;border-color:${failCount ? "var(--red)" : warnCount ? "var(--amber)" : "var(--green)"};">
        <strong>${summary}</strong>
      </div>
      ${results.map(r => `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-soft);font-size:12.5px;">
          <div style="flex-shrink:0;">${icon(r.status)}</div>
          <div><strong>${this._esc(r.name)}</strong><br><span class="muted">${this._esc(r.detail)}</span></div>
        </div>`).join("")}
      <button class="btn grad" style="margin-top:14px;" onclick="guardClick(this, () => SystemTest.askAgentPanelForIdeas())">🤖 Питай AI екипа за нови функции</button>
      <div id="systemTestIdeasOut" style="margin-top:14px;"></div>`;
  },

  /* ---------- AI ОДИТ: панел от НЯКОЛКО агента едновременно ----------
     Вика паралелно всеки provider, за който има зададен ключ (Claude,
     Gemini, OpenRouter — безплатен tier), със СЪЩИЯ prompt, и показва
     всеки отговор в собствена карта. Ако липсва ключ за даден agent,
     просто се пропуска (не блокира останалите). useSearch=true за Gemini
     му дава представа за актуални тенденции в AI музикалните инструменти,
     не само model knowledge. */
  async askAgentPanelForIdeas() {
    const out = document.getElementById("systemTestIdeasOut");
    if (!this._lastResults) { toast("Първо пусни системния тест по-горе"); return; }

    const k = Keys.load();
    const agents = [
      { id: "gemini", label: "Gemini", enabled: !!k.gemini, run: (p) => callGemini(p, true) },
      { id: "claude", label: "Claude", enabled: !!k.claude, run: (p) => callClaude(p, 900) },
      { id: "openrouter", label: "OpenRouter (безплатен модел)", enabled: !!k.openrouterKey, run: (p) => callOpenRouter(p, 900) },
    ].filter(a => a.enabled);

    if (!agents.length) {
      out.innerHTML = `<p class="muted">⚠️ Няма нито един настроен AI ключ (Claude/Gemini/OpenRouter) — виж Настройки → API Ключове. OpenRouter има реален безплатен tier, ако искаш повече "гласове" без разход.</p>`;
      return;
    }

    out.innerHTML = `<p class="muted">🤖 Питам ${agents.length} AI агент${agents.length > 1 ? "а" : ""} паралелно (${agents.map(a => a.label).join(", ")})...</p>`;

    const resultsSummary = this._lastResults.map(r => `- [${r.status}] ${r.name}: ${r.detail}`).join("\n");
    const featureInventory = [
      "Стъпка 1: пазарен анализ (YouTube+AI niche score), Album Sprint, Hook Evolution Arena,",
      "концепция, текст на песен (Claude), Viral Lab (AI Music Producer анализ), Ghost Audience",
      "(синтетична фокус-група), Gemini Validator.",
      "Стъпка 2: FX конфигурация + видео визуализатор.",
      "Стъпка 3: обложка (Gemini/Nano Banana), DistroKid авто-попълване, Spotify/Apple артист текстове,",
      "YouTube A/B заглавия, upload в YouTube (unlisted).",
      "Бърз режим: качване на стара песен → авто видео → анализ → upload.",
      "Niche Toolkit: Spotify+YouTube 'Profit Niche Score', AI промпт за Suno/Udio, AI структура на",
      "текст, Release Playbook + CSV export.",
      "Инфраструктура: дневен YouTube/trend tracker (GitHub Actions), Track Record (прогноза срещу",
      "реалност), AI Call Log + класация по надеждност, Vault криптиране на ключове, offline PWA."
    ].join(" ");

    // Идеи, които потребителят вече е маркирал като "изградени" в архива
    // (виж _recordIdeas/toggleIdeaBuilt по-горе) — подават се на AI екипа
    // по ЗАГЛАВИЕ (+ кратко резюме на описанието), за да не предлага пак
    // нещо вече готово, дори преформулирано различно следващия път.
    const builtIdeas = this._loadIdeas().filter(i => i.built);
    const builtIdeasSummary = builtIdeas.length
      ? builtIdeas.map(i => `- "${this._titleOf(i)}" — ${i.text.replace(/\s+/g, " ").slice(0, 140)}${i.text.length > 140 ? "…" : ""}`).join("\n")
      : "(потребителят още не е маркирал нищо от предишни предложения като изградено)";

    const prompt = `Ти си продуктов консултант за AI-базиран музикален dashboard (изцяло клиентско, статично уеб приложение — без сървър, всички AI/YouTube/Spotify извиквания стават директно от браузъра на потребителя).

СЪЩЕСТВУВАЩИ ФУНКЦИИ (не предлагай дублиране на тези):
${featureInventory}

ФУНКЦИИ, КОИТО ПОТРЕБИТЕЛЯТ ВЕЧЕ Е ИЗГРАДИЛ ОТ ПРЕДИШНИ ТВОИ ПРЕДЛОЖЕНИЯ (НЕ ги предлагай пак, дори преформулирани):
${builtIdeasSummary}

РЕЗУЛТАТ ОТ ТОКУ-ЩО ПУСНАТ СИСТЕМЕН ТЕСТ НА ПРИЛОЖЕНИЕТО:
${resultsSummary}

Задача: предложи 3-5 КОНКРЕТНИ нови функции или подобрения, които биха донесли реална стойност на независим музикален изпълнител/продуцент, който сам управлява releases. Приоритизирай по полезност. Ако резултатите от теста намекват за конкретен проблем (напр. нещо липсва/бавно/чупливо), включи и препоръка по темата.

ФОРМАТ (ЗАДЪЛЖИТЕЛЕН): всяка идея на СВОЙ номериран ред, който започва с КРАТКО ЗАГЛАВИЕ в **удебелен** текст, после тире и описание — напр. "1. **Hook Strength Score** – кратко описание...". Заглавието е важно — по него потребителят ще разпознава коя идея е изградил, за да не му я предлагаш пак. Кратко, на български, без излишен увод.`;

    const settled = await Promise.allSettled(agents.map(a => a.run(prompt)));
    const agentResults = agents.map((a, i) => {
      const r = settled[i];
      return r.status === "fulfilled"
        ? { agent: a.id, label: a.label, text: r.value.trim(), error: null }
        : { agent: a.id, label: a.label, text: null, error: r.reason?.message || String(r.reason) };
    });

    const addedCount = this._recordIdeas(agentResults);
    const savedNote = addedCount
      ? `<p class="muted" style="margin:0 0 10px;">💾 ${addedCount} нов${addedCount === 1 ? "а идея записана" : "и идеи записани"} в <a href="#" onclick="Nav.showView('ai-ideas');return false;">🗂️ Архива на идеи</a> (с оригиналните им заглавия).</p>`
      : "";

    out.innerHTML = savedNote + agentResults.map(a => `
      <div class="card tight" style="margin-bottom:10px;">
        <strong>🤖 ${a.label}</strong>
        <div style="margin-top:8px;white-space:pre-wrap;font-size:13px;line-height:1.6;">
          ${a.error ? `<span class="muted">❌ ${this._esc(a.error)}</span>` : this._esc(a.text)}
        </div>
      </div>`).join("");

    this._attachAgentIdeas(agentResults);
    this.renderHistory();
    this.renderIdeaBacklog();
  }
};

SystemTest.init();
