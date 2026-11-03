/* =========================================================
   🎵 SONG INTELLIGENCE LAB — SongLab
   =========================================================
   НАРОЧНО ИЗОЛИРАН МОДУЛ (Фаза 1 от Master Project Specification).

   Изгражда се като самостоятелна система, ПАРАЛЕЛНА на съществуващото
   приложение — не чете и не пише в AppState, ProjectArchive, ViralLab,
   AgentRegistry, TrackRecord или който и да е друг стар модул/storage
   ключ. Единствените неща, които преизползва от останалия сайт, са:
     - визуалните CSS класове (.card/.section-title/.btn/...), за да
       изглежда вградено в дизайна (виж PART 5 от спецификацията);
     - Nav router-а (Nav.showView), който вече знае как да превключва
       .view контейнери — извиква се стандартно от index.html, самият
       SongLab не пипа Nav.js.
   Всичко останало (storage, състояние, рендиране) е собствено.

   ⚠️ ВАЖНО (решение на потребителя): НЕ се съхранява самото аудио
   (mp3/wav файл). Файлът е нужен само временно в паметта за анализ
   (бъдещи фази) — НИКОГА не се пази в localStorage. Пази се само
   МЕТАДАННИ за песента (заглавие, изпълнител, име на файла, времетраене,
   жанр, език, дата на издаване, статус) + бъдещи структурирани AI
   резултати. Ако потребителят презареди страницата преди анализ,
   ще трябва да качи файла отново — само това е компромисът.

   Storage: собствен ключ, различен от всички "cdb_*" ключове на
   старото приложение → "songlab_projects_v1".

   Song ID формат: SONG-YYYY-NNNN (пример: SONG-2026-0001), последователен
   брояч в рамките на годината, пазен отделно ("songlab_seq_v1").

   Публичен интерфейс:
     - SongLab.init()            — извиква се веднъж при показване на view-а
     - SongLab.createSong(meta)  — създава нов Song Project, връща записа
     - SongLab.list()            — всички Song Project записи (най-нов отгоре)
     - SongLab.get(id)           — един запис по Song ID
     - SongLab.update(id, patch) — частична промяна + updated_at
     - SongLab.remove(id)        — трайно изтриване
     - SongLab.render()          — рисува "Моите песни" списъка
     - SongLab.renderNewForm()   — рисува формата "Нова песен"
   ========================================================= */

const SONGLAB_STORAGE_KEY = "songlab_projects_v1";
const SONGLAB_SEQ_KEY = "songlab_seq_v1";

/* ---------- SUNO STYLE TAG TRUNCATOR ----------
   Suno AI's "Style of Music" полето има твърд лимит (~200 символа) —
   ако го надхвърлиш, Suno или отрязва произволно по средата на дума,
   или направо отказва генерацията. Досега това разчиташе изцяло на
   инструкция в AI промпта ("максимум 200 символа" — виж Step1.
   generateConcept()) — AI-ят НЕ винаги се съобразява точно, особено на
   безплатните fallback модели.
   formatSunoStyleTags() е детерминистична, клиентска гаранция: винаги
   ≤ maxLen (190 по подразбиране — 10 символа margin под реалния лимит на
   Suno, за разлики в broweser/API encoding и т.н.), НИКОГА не разцепва
   дума по средата — отрязва до последната пълна дума/запетая преди
   границата, после чисти увиснала запетая/интервал накрая.
   Ползва се от Step1.generateConcept() (js/step1.js) веднага след като
   AI-ят върне style_prompt, преди да влезе в UI полето/AppState — така
   ВСИЧКО надолу по веригата (copy бутон, DistroKid export и т.н.) вече
   работи с гарантирано валидна стойност, не се налага truncation на
   няколко различни места. */
function formatSunoStyleTags(text, maxLen = 190) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;

  let cut = trimmed.slice(0, maxLen);
  const lastBoundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","));
  // Само ако границата не е подозрително близо до началото (напр. едно
  // огромно "изречение" без интервали, крайно рядко на практика) — иначе
  // по-добре твърд символен срез, отколкото да върнем почти празен низ.
  if (lastBoundary > maxLen * 0.5) cut = cut.slice(0, lastBoundary);
  return cut.replace(/[,\s]+$/, "").trim();
}

const SongLab = {
  // ---------- вътрешен сурово storage слой (собствен, не Storage от storage.js) ----------
  _readAll() {
    try {
      const raw = localStorage.getItem(SONGLAB_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn("SongLab: повредени данни в localStorage, връщам празен списък.", e);
      return [];
    }
  },
  _writeAll(list) {
    try {
      localStorage.setItem(SONGLAB_STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      console.error("SongLab: неуспешен запис (вероятно localStorage quota).", e);
      return false;
    }
  },

  // ---------- Song ID генератор ----------
  _nextId() {
    const year = new Date().getFullYear();
    let seq = {};
    try {
      seq = JSON.parse(localStorage.getItem(SONGLAB_SEQ_KEY) || "{}");
    } catch (e) { seq = {}; }
    const n = (seq[year] || 0) + 1;
    seq[year] = n;
    localStorage.setItem(SONGLAB_SEQ_KEY, JSON.stringify(seq));
    return `SONG-${year}-${String(n).padStart(4, "0")}`;
  },

  // ---------- CRUD ----------
  list() {
    return this._readAll().sort((a, b) => b.created_at - a.created_at);
  },

  get(id) {
    return this._readAll().find(s => s.id === id) || null;
  },

  createSong({ title, artist, filename, duration, genre, language, releaseDate }) {
    const now = Date.now();
    const song = {
      id: this._nextId(),
      title: (title || "").trim() || "(без заглавие)",
      artist: (artist || "").trim(),
      filename: filename || null,       // само името, НЕ самият файл
      duration: duration ?? null,       // секунди, ако е известно
      genre: genre || "",
      language: language || "",
      release_date: releaseDate || "",
      status: "new",                    // new → analyzing → analyzed
      created_at: now,
      updated_at: now,
      lyrics: "",                        // само текст, по избор, споделен между Фаза 2/3
      analysis: null,                    // попълва се от Фаза 2 (analyzeSong)
      agents: {}                         // попълва се от Фаза 3 (runAgent) — { [roleId]: {output, generated_at, method} }
    };
    const list = this._readAll();
    list.push(song);
    const ok = this._writeAll(list);
    if (!ok) return null;
    return song;
  },

  update(id, patch) {
    const list = this._readAll();
    const idx = list.findIndex(s => s.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, updated_at: Date.now() };
    this._writeAll(list);
    return list[idx];
  },

  remove(id) {
    if (!confirm("Да изтрия ли този Song Project безвъзвратно? Това не може да се върне.")) return;
    const list = this._readAll().filter(s => s.id !== id);
    this._writeAll(list);
    this.render();
    if (typeof toast === "function") toast("Song Project изтрит.");
  },

  saveLyrics(id) {
    const val = document.getElementById("songlabLyricsInput")?.value || "";
    this.update(id, { lyrics: val });
    if (typeof toast === "function") toast("💾 Текстът е запазен в Song Project-а.");
  },

  // ---------- UI: "Нова песен" форма ----------
  _pendingFile: null, // File обект, само в паметта, НИКОГА не се сериализира
  _sessionFiles: {},  // { songId: File } — само за текущата сесия/таб, губи се при презареждане (умишлено, виж бележката в началото на файла)

  onFileSelected(input) {
    const f = input.files && input.files[0];
    this._pendingFile = f || null;
    const label = document.getElementById("songlabFileLabel");
    if (label) {
      label.textContent = f
        ? `🎵 ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB) — само за анализ, няма да бъде запазен`
        : "Няма избран файл";
    }
  },

  submitNew() {
    const title = document.getElementById("songlabTitle")?.value || "";
    const artist = document.getElementById("songlabArtist")?.value || "";
    const genre = document.getElementById("songlabGenre")?.value || "";
    const language = document.getElementById("songlabLanguage")?.value || "";
    const releaseDate = document.getElementById("songlabReleaseDate")?.value || "";
    const filename = this._pendingFile ? this._pendingFile.name : null;

    if (!title.trim() && !filename) {
      if (typeof toast === "function") toast("Добави поне заглавие или аудио файл.");
      else alert("Добави поне заглавие или аудио файл.");
      return;
    }

    // Времетраене (ако браузърът може да го прочете бързо от файла) — best-effort, не блокира.
    const finish = (duration) => {
      const song = this.createSong({ title, artist, filename, duration, genre, language, releaseDate });
      if (!song) {
        if (typeof toast === "function") toast("Грешка при запис (localStorage пълен?).");
        return;
      }
      // Пазим File обекта само в паметта (сесийно), обвързан към Song ID —
      // позволява реален audio анализ веднага след създаване, БЕЗ да
      // сериализираме самия файл никъде. Изчезва при презареждане.
      if (this._pendingFile) this._sessionFiles[song.id] = this._pendingFile;
      this._pendingFile = null;
      // изчистване на формата
      ["songlabTitle", "songlabArtist", "songlabGenre", "songlabLanguage", "songlabReleaseDate"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      const fileInput = document.getElementById("songlabFileInput");
      if (fileInput) fileInput.value = "";
      const label = document.getElementById("songlabFileLabel");
      if (label) label.textContent = "Няма избран файл";

      if (typeof toast === "function") toast(`✅ Създаден ${song.id}`);
      this.render();
      this._showWorkspace(song.id);
    };

    if (this._pendingFile) {
      try {
        const audio = document.createElement("audio");
        audio.preload = "metadata";
        const url = URL.createObjectURL(this._pendingFile);
        audio.src = url;
        audio.onloadedmetadata = () => {
          const d = Math.round(audio.duration) || null;
          URL.revokeObjectURL(url);
          finish(d);
        };
        audio.onerror = () => { URL.revokeObjectURL(url); finish(null); };
      } catch (e) {
        finish(null);
      }
    } else {
      finish(null);
    }
  },

  renderNewForm() {
    const el = document.getElementById("songlabNewFormOut");
    if (!el) return;
    el.innerHTML = `
      <div class="row" style="margin-top:10px;">
        <input type="text" id="songlabTitle" placeholder="Заглавие на песента" style="flex:1;">
        <input type="text" id="songlabArtist" placeholder="Изпълнител" style="flex:1;">
      </div>
      <div class="row" style="margin-top:10px;">
        <input type="text" id="songlabGenre" placeholder="Жанр (по избор)" style="flex:1;">
        <input type="text" id="songlabLanguage" placeholder="Език (по избор)" style="flex:1;">
        <input type="date" id="songlabReleaseDate" style="flex:1;">
      </div>
      <div class="row" style="margin-top:10px;align-items:center;">
        <label class="btn" style="cursor:pointer;">
          🎵 Избери аудио файл
          <input type="file" id="songlabFileInput" accept="audio/*" style="display:none;" onchange="SongLab.onFileSelected(this)">
        </label>
        <span class="muted" id="songlabFileLabel">Няма избран файл</span>
      </div>
      <p class="muted" style="margin-top:8px;">
        ⚠️ Файлът се използва само временно за анализ (следващи фази) — НЕ се съхранява.
        Пази се само информацията за песента (заглавие, изпълнител, жанр, времетраене и т.н.).
      </p>
      <div class="row" style="margin-top:12px;">
        <button class="btn grad" onclick="SongLab.submitNew()">➕ Създай Song Project</button>
      </div>
    `;
  },

  // ---------- UI: "Моите песни" списък ----------
  render() {
    const el = document.getElementById("songlabListOut");
    if (!el) return;
    const list = this.list();
    if (!list.length) {
      el.innerHTML = `<p class="muted">Все още няма нито един Song Project. Създай първия отгоре.</p>`;
      return;
    }
    el.innerHTML = list.map(s => `
      <div class="copy-field">
        <span>
          <strong>${this._esc(s.title)}</strong>
          <span class="muted"> · ${this._esc(s.artist) || "—"} · ${s.id}</span><br>
          <span class="muted">
            ${s.genre ? this._esc(s.genre) + " · " : ""}${s.language ? this._esc(s.language) + " · " : ""}
            ${s.duration ? this._fmtDuration(s.duration) + " · " : ""}
            статус: ${this._statusLabel(s.status)} · създаден: ${new Date(s.created_at).toLocaleDateString("bg-BG")}
          </span>
        </span>
        <button onclick="SongLab.openWorkspace('${s.id}')">📂 Отвори</button>
        <button onclick="SongLab.remove('${s.id}')">🗑️</button>
      </div>
    `).join("");
  },

  _statusLabel(status) {
    return {
      new: "🆕 нов",
      analyzing: "⏳ анализира се",
      analyzed: "✅ анализиран",
      analysis_failed: "⚠️ анализът гръмна"
    }[status] || status;
  },

  _fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  },

  _esc(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  // ---------- UI: единичен Song Workspace ----------
  openWorkspace(id) {
    this._showWorkspace(id);
  },

  _showWorkspace(id) {
    const song = this.get(id);
    if (!song) return;
    const modal = document.getElementById("songlabWorkspaceOut");
    if (!modal) return;
    modal.style.display = "block";
    modal.innerHTML = `
      <div class="card" style="margin-top:16px;">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <strong>🎵 ${this._esc(song.title)} <span class="muted">— ${song.id}</span></strong>
          <button onclick="SongLab._closeWorkspace()">✖ Затвори</button>
        </div>
        <p class="muted" style="margin:8px 0 0;">
          Изпълнител: ${this._esc(song.artist) || "—"} ·
          Жанр: ${this._esc(song.genre) || "—"} ·
          Език: ${this._esc(song.language) || "—"} ·
          Времетраене: ${song.duration ? this._fmtDuration(song.duration) : "—"}<br>
          Файл: ${this._esc(song.filename) || "—"} (не се съхранява) ·
          Дата на издаване: ${song.release_date || "—"} ·
          Статус: ${this._statusLabel(song.status)}
        </p>

        <div class="section-title" style="font-size:15px;margin-top:14px;">📝 Текст на песента (по избор)</div>
        <p class="muted" style="margin:0 0 6px;">Пази се като част от Song Project-а (само текст, не аудио) — споделя се между анализа и специализираните агенти по-долу.</p>
        <textarea id="songlabLyricsInput" rows="4" style="width:100%;" placeholder="Пейстни текста на песента тук (по избор)...">${this._esc(song.lyrics)}</textarea>
        <div class="row" style="margin-top:6px;">
          <button onclick="SongLab.saveLyrics('${song.id}')">💾 Запази текста</button>
        </div>

        <div class="section-title" style="font-size:15px;margin-top:14px;">📊 AI Анализ</div>
        ${this._renderAnalysisBlock(song)}

        <div class="section-title" style="font-size:15px;margin-top:18px;">🤖 Специализирани агенти</div>
        <p class="muted" style="margin:0 0 8px;">Всяка роля е отделна, специализирана задача — извиква се индивидуално чрез съществуващата AI инфраструктура (Фаза 4 ще добави умен избор на модел между тях, засега всяка използва подразбиращата се верига).</p>
        ${this._renderAgentsBlock(song)}
      </div>
    `;
  },

  _closeWorkspace() {
    const modal = document.getElementById("songlabWorkspaceOut");
    if (modal) { modal.style.display = "none"; modal.innerHTML = ""; }
  },

  // =========================================================
  // ФАЗА 2 — BASIC SONG ANALYSIS
  // =========================================================
  // Използва СЪЩЕСТВУВАЩАТА AI инфраструктура на сайта за самото
  // извикване (callAI / callGeminiMultimodal / extractJson от
  // js/ai-helpers.js и js/providers/gemini.js) — но резултатът се пази
  // ИЗЦЯЛО в собственото storage на SongLab (song.analysis), никога в
  // старите AppState/ViralLab структури.
  //
  // Два режима, избрани честно според наличните данни (PART 10 — No Fake
  // Data — никога не се преструваме, че сме "чули" песен, която нямаме):
  //   1) AUDIO режим — файлът все още е в паметта (this._sessionFiles[id],
  //      само ако анализираш веднага след качване, в същата сесия) →
  //      реален multimodal анализ през Gemini (callGeminiMultimodal),
  //      изисква Gemini ключ.
  //   2) TEXT режим — файлът НЕ е наличен (нова сесия / презареждане) →
  //      анализ само от наличните метаданни + по избор пейстнат текст на
  //      песента (textarea в работното пространство) → callAI() (Claude/
  //      Gemini/OpenRouter/ModelFinder fallback верига). Резултатът се
  //      маркира изрично като "текстов анализ, без чуто аудио".

  _ANALYSIS_SCHEMA_HINT: `Върни ЕДИНСТВЕНО валиден JSON обект (без коментари, без markdown code fence) с точно тези полета:
{
  "genre": "string",
  "subgenre": "string",
  "mood": "string",
  "emotional_character": "string",
  "audience": "string",
  "strengths": ["string", "..."],
  "weaknesses": ["string", "..."],
  "hook_potential": number (0-100),
  "replay_potential": number (0-100),
  "short_form_potential": number (0-100),
  "visual_potential": number (0-100),
  "positioning": "string",
  "overall_score": number (0-100),
  "biggest_strength": "string",
  "biggest_weakness": "string",
  "recommended_direction": "string",
  "next_action": "string"
}
Ако някое поле реално не може да се прецени от наличната информация, върни за него "Недостатъчно данни" (за текстовите полета) или null (за числата) — НИКОГА не измисляй правдоподобно звучаща стойност.`,

  async analyzeSong(id) {
    const song = this.get(id);
    if (!song) return;

    this.update(id, { status: "analyzing" });
    this._showWorkspace(id);

    const file = this._sessionFiles[id] || null;
    const lyricsHint = (song.lyrics || "").trim();

    const baseContext = `
Заглавие: ${song.title}
Изпълнител: ${song.artist || "неизвестен"}
Жанр (посочен от потребителя, по избор): ${song.genre || "не е посочен"}
Език (посочен от потребителя, по избор): ${song.language || "не е посочен"}
Времетраене: ${song.duration ? this._fmtDuration(song.duration) : "неизвестно"}
${lyricsHint ? `Текст на песента (пейстнат от потребителя):\n${lyricsHint}` : "Текст на песента: не е предоставен."}`;

    try {
      let raw, method;

      if (file) {
        // AUDIO режим — реален multimodal анализ
        const prompt = `Ти си музикален анализатор. Изслушай приложения аудио файл на песента и я анализирай за нуждите на дигитален release/маркетинг план.\n${baseContext}\n\n${this._ANALYSIS_SCHEMA_HINT}`;
        const base64 = await fileToBase64(file);
        raw = await callGeminiMultimodal(prompt, base64, file.type || "audio/mpeg", false);
        method = "audio";
      } else {
        // TEXT режим — честно казано, само по метаданни/текст, БЕЗ да сме чули песента
        const prompt = `Ти си музикален анализатор. НЯМАШ достъп до самото аудио на песента — само до текстовата информация по-долу. Анализирай доколкото е реалистично базирано САМО на тази информация, и изрично отбележи в текстовите полета, когато нещо не може да се прецени без да чуеш песента.\n${baseContext}\n\n${this._ANALYSIS_SCHEMA_HINT}`;
        raw = await callAI(prompt, 1500);
        method = "text";
      }

      const parsed = extractJson(raw);
      const analysis = {
        ...parsed,
        method,                    // "audio" | "text" — честно за произхода на анализа
        analyzed_at: Date.now()
      };
      this.update(id, { status: "analyzed", analysis });
      if (typeof toast === "function") {
        toast(method === "audio" ? "✅ Анализът е готов (реално изслушано аудио)." : "✅ Анализът е готов (текстов режим — без чуто аудио).");
      }
    } catch (e) {
      console.error("SongLab.analyzeSong грешка:", e);
      this.update(id, { status: "analysis_failed" });
      if (typeof toast === "function") toast(`❌ Анализът гръмна: ${e.message}`);
      else alert(`Анализът гръмна: ${e.message}`);
    }

    this.render();
    this._showWorkspace(id);
  },

  // Рендира структурираните резултати (или honest "няма още" state).
  _renderAnalysisBlock(song) {
    if (song.status === "analyzing") {
      return `<p class="muted" style="margin-top:10px;">⏳ Анализира се... (не затваряй раздела)</p>`;
    }
    if (song.status === "analysis_failed") {
      return `<p class="muted" style="margin-top:10px;">⚠️ Последният опит за анализ гръмна — виж toast съобщението за причината (напр. липсващ AI ключ). Опитай пак.</p>`;
    }
    const a = song.analysis;
    if (!a) {
      return `
        <p class="muted">${this._sessionFiles[song.id] ? "🎧 Аудио файлът е все още в паметта — анализът ще го изслуша реално." : "ℹ️ Аудио файлът не е наличен в тази сесия — анализът ще е само по текст/метаданни, изрично отбелязано като такъв."}</p>
        <div class="row" style="margin-top:10px;">
          <button class="btn grad" onclick="SongLab.analyzeSong('${song.id}')">🔍 Анализирай</button>
        </div>`;
    }
    const bar = (label, val) => `
      <div style="margin:6px 0;">
        <div class="muted" style="font-size:12px;">${label}: ${val == null ? "Недостатъчно данни" : val + "/100"}</div>
        ${val != null ? `<div style="background:var(--panel-2);border-radius:5px;height:10px;overflow:hidden;"><div style="width:${Math.max(2, val)}%;height:100%;background:var(--accent, #7c5cff);"></div></div>` : ""}
      </div>`;
    return `
      <div style="margin-top:10px;">
        <span class="muted">Метод: ${a.method === "audio" ? "🎧 реално изслушано аудио" : "📝 текстов анализ (без чуто аудио)"} · ${new Date(a.analyzed_at).toLocaleString("bg-BG")}</span>
      </div>
      <div class="row" style="margin-top:8px;gap:24px;flex-wrap:wrap;">
        <div style="flex:1;min-width:220px;">
          ${bar("Hook потенциал", a.hook_potential)}
          ${bar("Replay потенциал", a.replay_potential)}
          ${bar("Short-form потенциал", a.short_form_potential)}
          ${bar("Визуален потенциал", a.visual_potential)}
        </div>
        <div style="flex:1;min-width:220px;">
          <div><strong>Общ резултат:</strong> ${a.overall_score == null ? "Недостатъчно данни" : a.overall_score + "/100"}</div>
          <div class="muted" style="margin-top:4px;">Жанр/подстил: ${this._esc(a.genre)} / ${this._esc(a.subgenre)}</div>
          <div class="muted">Настроение: ${this._esc(a.mood)}</div>
          <div class="muted">Аудитория: ${this._esc(a.audience)}</div>
        </div>
      </div>
      <div style="margin-top:12px;">
        <div>🔥 <strong>Най-силна страна:</strong> ${this._esc(a.biggest_strength)}</div>
        <div style="margin-top:4px;">⚠️ <strong>Най-слаба страна:</strong> ${this._esc(a.biggest_weakness)}</div>
        <div style="margin-top:4px;">🧭 <strong>Препоръчана посока:</strong> ${this._esc(a.recommended_direction)}</div>
        <div style="margin-top:4px;">👉 <strong>NEXT ACTION:</strong> ${this._esc(a.next_action)}</div>
      </div>
      <div class="row" style="margin-top:12px;">
        <button onclick="SongLab.analyzeSong('${song.id}')">🔄 Анализирай отново</button>
      </div>`;
  },

  // =========================================================
  // ФАЗА 3 — SPECIALIZED SONG AGENTS
  // =========================================================
  // Разделя анализа на специализирани TASK ROLES (не са трайно
  // обвързани с конкретен модел — просто различни промптове/схеми,
  // изпълнявани през СЪЩАТА подразбираща се AI верига като Фаза 2;
  // истинският model-routing идва във Фаза 4 — AI Agent Orchestrator).
  // Всяка роля пише резултата си в song.agents[roleId], структуриран
  // JSON, никога в старите модули.

  AGENT_ROLES: [
    {
      id: "audio_analyst", name: "Audio Analyst", icon: "🎧", audioCapable: true,
      instruction: "Ти си Audio Analyst — фокусирай се строго върху звуковите характеристики: темпо/усещане, ниво на енергия, инструментариум, качество на продукцията, звуково \"подписно\" звучене, и ключови моменти във времето (ако можеш да ги прецениш).",
      schema: `{"tempo_feel":"string","energy_level":"string (нисък/среден/висок)","instrumentation":"string","production_quality":"string","sonic_signature":"string","key_moments":[{"timestamp_hint":"string","description":"string"}],"notes":"string"}`
    },
    {
      id: "hook_analyst", name: "Hook Analyst", icon: "🪝",
      instruction: "Ти си Hook Analyst — намери и опиши най-силния hook на песента: първите 3/5/10 секунди, хук в припева, и алтернативни hook кандидати.",
      schema: `{"strongest_hook_location":"string","hook_description":"string","hook_strength":number(0-100)|null,"first_3_sec":"string","first_5_sec":"string","first_10_sec":"string","chorus_hook":"string","alternative_hooks":["string","..."]}`
    },
    {
      id: "market_analyst", name: "Market Analyst", icon: "📈",
      instruction: "Ти си Market Analyst — прецени пазарна ниша, целева аудитория, реална пазарна възможност (Opportunity, не гарантирана вирусност), ниво на конкуренция, сравними изпълнители, и къде има позиционна пролука.",
      schema: `{"niche":"string","target_audience":"string","market_opportunity":"string","competition_level":"string","comparable_artists":["string","..."],"positioning_gap":"string"}`
    },
    {
      id: "positioning_agent", name: "Positioning Agent", icon: "🎯",
      instruction: "Ти си Positioning Agent — определи уникалното предложение (USP), брандинг ъгъла, няколко tagline опции, и капани, които трябва да се избягват в позиционирането.",
      schema: `{"unique_selling_point":"string","brand_angle":"string","tagline_options":["string","..."],"avoid_pitfalls":["string","..."]}`
    },
    {
      id: "youtube_strategist", name: "YouTube Strategist", icon: "▶️",
      instruction: "Ти си YouTube Strategist — предложи няколко варианта на заглавие, чернова на описание, ключови думи, hashtags, Shorts концепции, и посока за thumbnail.",
      schema: `{"title_options":["string","..."],"description_draft":"string","keywords":["string","..."],"hashtags":["string","..."],"shorts_concepts":["string","..."],"thumbnail_direction":"string"}`
    },
    {
      id: "tiktok_strategist", name: "TikTok Strategist", icon: "📱",
      instruction: "Ти си TikTok Strategist — предложи няколко конкретни content концепции (hook + caption + CTA всяка), намек за най-добрия аудио сегмент, и hashtags. Използвай термини като \"Viral Potential\"/\"Opportunity\", никога не обещавай гарантирана вирусност.",
      schema: `{"content_concepts":[{"hook":"string","caption":"string","cta":"string"}],"best_audio_segment_hint":"string","hashtags":["string","..."]}`
    },
    {
      id: "visual_director", name: "AI Visual Director", icon: "🎬",
      instruction: "Ти си AI Visual Director. ВАЖНО: изпълнителят НЯМА да се появява във видеата — визуалите са изцяло AI-генерирани (fictional characters, cinematic/abstract сцени, animation и т.н., БЕЗ lip-sync по подразбиране). Предложи визуална тема, ключови думи за mood board, идеи за сцени, цветова палитра, и стил на камерата.",
      schema: `{"visual_theme":"string","mood_board_keywords":["string","..."],"scene_ideas":["string","..."],"color_palette":"string","camera_style":"string"}`
    },
    {
      id: "shortform_director", name: "Short-Form Content Director", icon: "🎞️",
      instruction: "Ти си Short-Form Content Director — предложи Instagram Reels концепции, препоръки за формат, и бележки за темпо/pacing на клиповете.",
      schema: `{"reels_concepts":["string","..."],"format_recommendations":"string","pacing_notes":"string"}`
    },
    {
      id: "hook_evolution", name: "Hook Evolution Agent", icon: "🧬",
      instruction: "Ти си Hook Evolution Agent — предложи няколко варианта (версии) на текстовия/визуалния hook, всеки с кратка обосновка, и посочи кой е препоръчаният победител.",
      schema: `{"hook_variations":[{"version":"string","text":"string","rationale":"string"}],"recommended_winner":"string"}`
    },
    {
      id: "metadata_seo", name: "Metadata / SEO Agent", icon: "🏷️",
      instruction: "Ти си Metadata/SEO Agent — предложи SEO заглавие, SEO описание, тагове, и вероятни търсени фрази от реални потребители.",
      schema: `{"seo_title":"string","seo_description":"string","tags":["string","..."],"search_terms":["string","..."]}`
    },
    {
      id: "ghost_audience", name: "Ghost Audience", icon: "👻",
      instruction: "Ти си Ghost Audience — симулирай реакции на 3-5 различни реалистични слушателски персони (различни вкусове/навици) към тази песен. Бъди честен, не всички реакции трябва да са позитивни. Посочи общото усещане и най-голямото възражение.",
      schema: `{"simulated_reactions":[{"persona":"string","reaction":"string","would_share":"string (да/не/може би)"}],"overall_sentiment":"string","biggest_objection":"string"}`
    },
    {
      id: "red_team", name: "Red Team", icon: "⚔️",
      instruction: "Ти си Red Team — предизвикай текущата стратегия максимално критично: слабо intro, генерично съдържание/позициониране, неясна аудитория, пренаситена ниша, нисък replay, слаб емоционален ефект. Бъди директен, не смекчавай.",
      schema: `{"weaknesses_found":["string","..."],"risks":["string","..."],"harshest_critique":"string","oversaturation_check":"string"}`
    },
    {
      id: "final_judge", name: "Final Judge", icon: "🏆",
      instruction: "Ти си Final Judge — синтезирай ВСИЧКИ налични резултати по-долу (основен анализ + другите агенти, ако са изпълнени) в единна финална присъда. Ако дадена категория няма достатъчно данни (агентът не е изпълнен), сложи null за нейния резултат, НЕ измисляй. Дай overall_score, verdict (\"GO\"/\"MODIFY\"/\"HOLD\"), biggest_opportunity, biggest_risk, и next_action.",
      schema: `{"scores":{"audio":number|null,"hook":number|null,"replay":number|null,"market":number|null,"tiktok":number|null,"youtube":number|null,"visual":number|null,"audience":number|null,"search":number|null,"monetization":number|null,"differentiation":number|null},"overall_score":number|null,"verdict":"GO"|"MODIFY"|"HOLD","biggest_opportunity":"string","biggest_risk":"string","next_action":"string"}`,
      usesAllAgents: true
    }
  ],

  _agentRole(roleId) {
    return this.AGENT_ROLES.find(r => r.id === roleId) || null;
  },

  // Контекст, споделен от всички роли — метаданни + основен анализ (Фаза 2) +
  // текст на песента, ако е запазен. Ролята "final_judge" получава и всички
  // вече изпълнени агентски резултати (usesAllAgents).
  _buildRoleContext(song, role) {
    let ctx = `Заглавие: ${song.title}
Изпълнител: ${song.artist || "неизвестен"}
Жанр (посочен от потребителя): ${song.genre || "не е посочен"}
Език: ${song.language || "не е посочен"}
Времетраене: ${song.duration ? this._fmtDuration(song.duration) : "неизвестно"}
${song.lyrics ? `Текст на песента:\n${song.lyrics}` : "Текст на песента: не е предоставен."}`;

    if (song.analysis) {
      ctx += `\n\nОсновен AI анализ (Фаза 2, метод: ${song.analysis.method === "audio" ? "реално чуто аудио" : "текстов"}):\n${JSON.stringify(song.analysis, null, 0)}`;
    } else {
      ctx += `\n\nОсновен AI анализ: все още не е изпълнен.`;
    }

    if (role.usesAllAgents) {
      const done = Object.entries(song.agents || {}).filter(([k]) => k !== "final_judge");
      if (done.length) {
        ctx += `\n\nРезултати от специализираните агенти, изпълнени досега:\n` +
          done.map(([k, v]) => `— ${k}: ${JSON.stringify(v.output)}`).join("\n");
      } else {
        ctx += `\n\nНито един специализиран агент не е изпълнен още — присъдата ти трябва честно да отрази това (повечето резултати ще са null).`;
      }
    }
    return ctx;
  },

  async runAgent(id, roleId) {
    const song = this.get(id);
    const role = this._agentRole(roleId);
    if (!song || !role) return;

    const agents = { ...(song.agents || {}) };
    agents[roleId] = { ...(agents[roleId] || {}), status: "running" };
    this.update(id, { agents });
    this._showWorkspace(id);

    const ctx = this._buildRoleContext(song, role);
    const schemaHint = `Върни ЕДИНСТВЕНО валиден JSON обект (без коментари, без markdown code fence), точно с тази форма:\n${role.schema}\nАко реално не можеш да прецениш дадено поле от наличната информация, върни null (за числа) или "Недостатъчно данни" (за текст) — НИКОГА не измисляй правдоподобна стойност.`;

    try {
      let raw, method;
      const file = role.audioCapable ? (this._sessionFiles[id] || null) : null;
      if (file) {
        const prompt = `${role.instruction}\nИзслушай приложения аудио файл.\n${ctx}\n\n${schemaHint}`;
        const base64 = await fileToBase64(file);
        raw = await callGeminiMultimodal(prompt, base64, file.type || "audio/mpeg", false);
        method = "audio";
      } else {
        const audioNote = role.audioCapable ? "\nНЯМАШ достъп до самото аудио в момента — работи само с текстовата информация по-долу и отбележи честно ограниченията." : "";
        const prompt = `${role.instruction}${audioNote}\n${ctx}\n\n${schemaHint}`;
        raw = await callAI(prompt, 1400);
        method = "text";
      }
      const parsed = extractJson(raw);
      const finalAgents = { ...(this.get(id).agents || {}) };
      finalAgents[roleId] = { output: parsed, method, status: "done", generated_at: Date.now() };
      this.update(id, { agents: finalAgents });
      if (typeof toast === "function") toast(`✅ ${role.icon} ${role.name} готов.`);
    } catch (e) {
      console.error(`SongLab.runAgent(${roleId}) грешка:`, e);
      const finalAgents = { ...(this.get(id).agents || {}) };
      finalAgents[roleId] = { ...(finalAgents[roleId] || {}), status: "failed", error: e.message };
      this.update(id, { agents: finalAgents });
      if (typeof toast === "function") toast(`❌ ${role.icon} ${role.name} гръмна: ${e.message}`);
    }
    this._showWorkspace(id);
  },

  _renderAgentsBlock(song) {
    const agents = song.agents || {};
    return `<div>` + this.AGENT_ROLES.map(role => {
      const rec = agents[role.id];
      const status = rec?.status || "idle";
      let body;
      if (status === "running") {
        body = `<span class="muted">⏳ изпълнява се...</span>`;
      } else if (status === "failed") {
        body = `<span class="muted">⚠️ гръмна: ${this._esc(rec.error)}</span> <button onclick="SongLab.runAgent('${song.id}','${role.id}')">🔄 Опитай пак</button>`;
      } else if (status === "done") {
        body = `
          <span class="muted">${rec.method === "audio" ? "🎧 аудио" : "📝 текст"} · ${new Date(rec.generated_at).toLocaleString("bg-BG")}</span>
          <button onclick="SongLab.runAgent('${song.id}','${role.id}')">🔄 Изпълни отново</button>
          <pre style="white-space:pre-wrap;font-size:12px;background:var(--panel-2);padding:8px;border-radius:6px;margin-top:6px;">${this._esc(JSON.stringify(rec.output, null, 2))}</pre>`;
      } else {
        body = `<button onclick="SongLab.runAgent('${song.id}','${role.id}')">▶ Изпълни</button>`;
      }
      return `
        <div class="copy-field" style="display:block;">
          <div><strong>${role.icon} ${role.name}</strong></div>
          <div style="margin-top:6px;">${body}</div>
        </div>`;
    }).join("") + `</div>`;
  },

  // ---------- Инициализация при показване на view-а ----------
  init() {
    this.renderNewForm();
    this.render();
    this._closeWorkspace();
  }
};