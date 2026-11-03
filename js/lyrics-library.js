/* =========================================================
   LYRICS LIBRARY — библиотека с текстовете на собствените песни
   + генератор на нова песен от всички AI агенти.

   1) Списък с песни → клик върху заглавие → виждаш текста само на
      тази песен (не всичко накуп).
   2) Базата се пази в data/lyrics/songs.json (чете се от repo-то,
      пише се през GitHub Contents API със СЪЩИЯ token/owner/repo от
      Настройки, като при distrokid-library.json в Shorts Studio).
      Локално копие в localStorage — нищо не се губи, ако записът в
      GitHub още не е направен.
   3) "Нова песен от моите текстове": всеки избран агент получава
      цялата база и пише нова история, като ползва мои редове/образи.

   Зависимости (викани само вътре в методи): Storage, Keys,
   AgentRegistry, ProjectArchive, fetchTimeout, toast.
   ========================================================= */
const LyricsLibrary = {
  KEY: "cdb_lyrics_library_v1",
  REPO_PATH: "data/lyrics/songs.json",
  selectedId: null,
  pickedAgents: null,
  running: false,
  _remoteLoaded: false,

  /* ---------- данни ---------- */
  load() { return Storage.get(this.KEY) || []; },
  save(list) { Storage.set(this.KEY, list); },
  _id() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
  _esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); },
  _norm(t) { return String(t || "").replace(/\r\n?/g, "\n").trim(); },

  // Сливане по заглавие+текст: същата песен не се добавя два пъти.
  _merge(base, incoming) {
    const seen = new Set(base.map(s => (s.title + "\n" + s.text).toLowerCase()));
    let added = 0;
    for (const s of incoming) {
      const title = String(s.title || "").trim() || "(без заглавие)";
      const text = this._norm(s.text);
      if (!text) continue;
      const k = (title + "\n" + text).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      base.push({ id: s.id || this._id(), title, text, source: s.source || "ръчно", added: s.added || new Date().toISOString() });
      added++;
    }
    return added;
  },

  add() {
    const t = document.getElementById("llTitle"), x = document.getElementById("llText");
    const list = this.load();
    if (!this._merge(list, [{ title: t.value, text: x.value }])) return toast("⚠️ Празен текст или тази песен вече я има");
    this.save(list);
    t.value = ""; x.value = "";
    this.selectedId = list[list.length - 1].id;
    toast("✅ Песента е добавена — не забравяй „Запази в GitHub“");
    this.render();
  },

  remove(id) {
    const s = this.load().find(x => x.id === id);
    if (!s || !confirm(`Изтрий „${s.title}“ от библиотеката?`)) return;
    this.save(this.load().filter(x => x.id !== id));
    if (this.selectedId === id) this.selectedId = null;
    this.render();
  },

  saveEdit(id) {
    const list = this.load(), s = list.find(x => x.id === id);
    if (!s) return;
    s.title = document.getElementById("llEditTitle").value.trim() || s.title;
    s.text = this._norm(document.getElementById("llEditText").value) || s.text;
    this.save(list);
    toast("✅ Запазено локално");
    this.render();
  },

  copy(id) {
    const s = this.load().find(x => x.id === id);
    if (s) navigator.clipboard?.writeText(s.text).then(() => toast("📋 Копирано"));
  },

  /* ---------- внос ---------- */
  async importFiles(fileList) {
    const list = this.load();
    let added = 0;
    for (const f of Array.from(fileList || [])) {
      const raw = await f.text();
      const name = f.name.replace(/\.[^.]+$/, "");
      if (/\.json$/i.test(f.name)) {
        try {
          const j = JSON.parse(raw);
          const arr = Array.isArray(j) ? j : (j.songs || j.tracks || []);
          added += this._merge(list, arr.map(s => ({ title: s.title || s.name, text: s.text || s.lyrics, source: "json: " + f.name })));
        } catch (e) { toast(`⚠️ „${f.name}“ не е валиден JSON`); }
      } else {
        added += this._merge(list, [{ title: name, text: raw, source: "файл: " + f.name }]);
      }
    }
    this.save(list);
    const inp = document.getElementById("llFileInput"); if (inp) inp.value = "";
    toast(added ? `✅ Добавени песни: ${added}` : "Нищо ново за добавяне");
    this.render();
  },

  // Автоматичен внос от вече създадените в сайта проекти (текст от Стъпка 1).
  importFromProjects() {
    const items = [];
    try {
      for (const a of ProjectArchive.load()) {
        const p = a.snapshot?.project;
        if (p?.lyrics) items.push({ title: a.title || p.title, text: p.lyrics, source: "архив на проекти" });
      }
      const cur = AppState.data?.project;
      if (cur?.lyrics) items.push({ title: cur.title || "(текущ проект)", text: cur.lyrics, source: "текущ проект" });
    } catch (e) { /* няма архив — нищо за внасяне */ }
    const list = this.load();
    const added = this._merge(list, items);
    this.save(list);
    toast(added ? `✅ От проектите: ${added} нови песни` : "Няма нови текстове в проектите");
    this.render();
  },

  exportJson() {
    const blob = new Blob([JSON.stringify(this.load(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "songs.json";
    a.click();
    URL.revokeObjectURL(a.href);
  },

  /* ---------- GitHub (четене без token от публично repo, запис с token) ---------- */
  _status(msg) { const el = document.getElementById("llStatus"); if (el) el.textContent = msg; },

  async loadRemote(force) {
    if (this._remoteLoaded && !force) return;
    const k = Keys.load();
    const urls = [`${this.REPO_PATH}?t=${Date.now()}`];
    if (k.ghOwner && k.ghRepo) urls.push(`https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${k.ghBranch || "main"}/${this.REPO_PATH}?t=${Date.now()}`);
    for (const u of urls) {
      try {
        const r = await fetchTimeout(u, {}, 12000);
        if (!r.ok) continue;
        const remote = await r.json();
        const list = this.load();
        const added = this._merge(list, Array.isArray(remote) ? remote : []);
        this.save(list);
        this._remoteLoaded = true;
        this._status(added ? `⬇️ Заредени от GitHub: ${added} песни` : "✅ Синхронизирано с GitHub");
        return;
      } catch (e) { /* пробвай следващия адрес */ }
    }
    this._status("ℹ️ В repo-то още няма data/lyrics/songs.json — ползва се локалното копие");
  },

  async saveToGitHub() {
    const list = this.load();
    if (!list.length) return toast("Библиотеката е празна");
    const k = Keys.load();
    if (!k.ghToken) return toast("❌ Липсва GitHub Token — виж Настройки → API Ключове");
    if (!k.ghOwner || !k.ghRepo) return toast("❌ Липсват GitHub потребител/repo — виж Настройки → YouTube Тракер");
    const branch = k.ghBranch || "main";
    const api = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/${this.REPO_PATH}`;
    const headers = { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json" };
    this._status("⏳ Запазвам в GitHub...");
    try {
      let sha = null;
      const cur = await fetchTimeout(`${api}?ref=${encodeURIComponent(branch)}`, { headers }, 15000);
      if (cur.ok) sha = (await cur.json()).sha;
      else if (cur.status !== 404) throw new Error(`четене (${cur.status})`);
      const body = {
        message: `🎤 Lyrics Library: ${list.length} песни`,
        content: btoa(unescape(encodeURIComponent(JSON.stringify(list, null, 2) + "\n"))),
        branch
      };
      if (sha) body.sha = sha;
      const put = await fetchTimeout(api, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }, 20000);
      if (!put.ok) throw new Error(`запис (${put.status})`);
      this._status(`✅ Запазени ${list.length} песни в ${this.REPO_PATH}`);
      toast("✅ Запазено в GitHub");
    } catch (e) {
      this._status("❌ " + (e.message || e));
      toast("❌ Неуспешен запис в GitHub: " + (e.message || e));
    }
  },

  /* ---------- екран ---------- */
  select(id) { this.selectedId = id; this.render(); },

  async render() {
    if (!document.getElementById("llList")) return;
    if (!this._remoteLoaded) { await this.loadRemote(); }
    const q = (document.getElementById("llSearch")?.value || "").toLowerCase();
    const all = this.load();
    const list = all.filter(s => !q || s.title.toLowerCase().includes(q) || s.text.toLowerCase().includes(q));
    document.getElementById("llCount").textContent = `Песни в библиотеката: ${all.length}`;
    document.getElementById("llList").innerHTML = list.length
      ? list.map(s => `<button class="nav-btn ${s.id === this.selectedId ? "active" : ""}" style="width:100%;text-align:left;" onclick="LyricsLibrary.select('${s.id}')">🎵 ${this._esc(s.title)}</button>`).join("")
      : `<p class="muted">Няма песни${q ? " по това търсене" : " — добави или внеси по-долу"}.</p>`;

    const s = all.find(x => x.id === this.selectedId);
    document.getElementById("llDetail").innerHTML = s ? `
      <div class="row" style="align-items:center;margin-bottom:8px;">
        <input type="text" id="llEditTitle" value="${this._esc(s.title)}" style="flex:1;">
        <button class="btn ghost sm" style="width:auto;" onclick="LyricsLibrary.copy('${s.id}')">📋</button>
        <button class="btn ghost sm" style="width:auto;" onclick="LyricsLibrary.remove('${s.id}')">🗑️</button>
      </div>
      <textarea id="llEditText" rows="16" style="width:100%;">${this._esc(s.text)}</textarea>
      <div class="row" style="margin-top:8px;align-items:center;">
        <button class="btn grad sm" style="width:auto;" onclick="LyricsLibrary.saveEdit('${s.id}')">💾 Запази промените</button>
        <span class="muted">Източник: ${this._esc(s.source)}</span>
      </div>` : `<p class="muted">Избери песен от списъка, за да видиш текста ѝ.</p>`;
    this._renderAgents();
  },

  /* ---------- нова песен от всички текстове ---------- */
  _renderAgents() {
    const el = document.getElementById("llAgentPicker");
    if (!el) return;
    let avail = [];
    try { avail = AgentRegistry.available(); } catch (e) { /* няма регистър */ }
    if (!this.pickedAgents) this.pickedAgents = new Set(avail.map(a => a.id));
    el.innerHTML = avail.length ? avail.map(a => `
      <label style="display:flex;gap:6px;align-items:center;margin:0;">
        <input type="checkbox" ${this.pickedAgents.has(a.id) ? "checked" : ""} onchange="LyricsLibrary.toggleAgent('${a.id}',this.checked)" style="width:auto;">
        ${a.icon || "🤖"} ${this._esc(a.name)}</label>`).join("")
      : `<p class="muted">Няма агент с ключ — добави ключове в ⚙️ API Ключове.</p>`;
  },
  toggleAgent(id, on) { on ? this.pickedAgents.add(id) : this.pickedAgents.delete(id); },

  // Подава ВСИЧКИ песни. Ако общият размер надхвърля лимита на безплатните
  // модели, всяка песен се съкращава поравно (никоя не отпада) и се показва бележка.
  buildCorpus(budget) {
    const songs = this.load();
    const total = songs.reduce((n, s) => n + s.text.length, 0);
    const per = total > budget ? Math.max(200, Math.floor(budget / Math.max(1, songs.length))) : Infinity;
    let trimmed = 0;
    const text = songs.map(s => {
      let t = s.text;
      if (t.length > per) { t = t.slice(0, per).replace(/\n[^\n]*$/, "") + "\n[…]"; trimmed++; }
      return `### ${s.title}\n${t}`;
    }).join("\n\n");
    return { text, count: songs.length, trimmed };
  },

  buildPrompt(corpus, theme) {
    return `Ти си автор на песни. По-долу е ЦЯЛАТА ми библиотека с текстове на мои песни (${corpus.count} на брой).
Задача: измисли ЕДНА нова, цялостна история и напиши по нея нова песен (куплети, припев, бридж) на български.
Правила:
- Построй песента от МОИТЕ редове, образи, рими и повтарящи се мотиви от библиотеката — взимай и преработвай реални мои редове, не измисляй чужд стил.
- Историята трябва да е нова и смислена, а старите ми редове да са вплетени в нея като нейни части.
- В края добави ред „Използвани от: “ със заглавията на песните, от които си взел редове.
${theme ? "Тема/посока: " + theme + "\n" : ""}
=== МОИТЕ ТЕКСТОВЕ ===
${corpus.text}`;
  },

  async generate() {
    if (this.running) return;
    if (!this.load().length) return toast("⚠️ Първо добави песни в библиотеката");
    const agents = [...(this.pickedAgents || [])].map(id => AgentRegistry.get(id)).filter(a => a && AgentRegistry.hasKey(a));
    if (!agents.length) return toast("⚠️ Избери поне един агент с ключ");
    const budget = Math.max(4000, parseInt(document.getElementById("llBudget").value, 10) || 24000);
    const corpus = this.buildCorpus(budget);
    const prompt = this.buildPrompt(corpus, (document.getElementById("llTheme").value || "").trim());
    const out = document.getElementById("llResults");
    this.running = true;
    document.getElementById("llGenBtn").disabled = true;
    out.innerHTML = `<p class="muted">⏳ ${agents.length} агента четат ${corpus.count} песни${corpus.trimmed ? ` (${corpus.trimmed} са съкратени, за да се поберат в лимита)` : ""}...</p>`;
    const res = await Promise.allSettled(agents.map(a => a.send(prompt, [], null)));
    out.innerHTML = res.map((r, i) => {
      const a = agents[i];
      const body = r.status === "fulfilled"
        ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0 0;">${this._esc(r.value.text)}</pre>`
        : `<p class="muted">❌ ${this._esc(r.reason?.message || "Грешка")}</p>`;
      return `<div class="card" style="margin-top:10px;"><strong>${a.icon || "🤖"} ${this._esc(a.name)}</strong>${r.status === "fulfilled" && r.value.model ? ` <span class="muted">· ${this._esc(r.value.model)}</span>` : ""}${body}</div>`;
    }).join("");
    this.running = false;
    document.getElementById("llGenBtn").disabled = false;
  }
};
