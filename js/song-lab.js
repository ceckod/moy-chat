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
      status: "new",                    // new → analyzing → analyzed (бъдещи фази)
      created_at: now,
      updated_at: now,
      // Плейсхолдъри за бъдещи фази — умишлено празни/null сега (PART 10 — No Fake Data):
      analysis: null
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

  // ---------- UI: "Нова песен" форма ----------
  _pendingFile: null, // File обект, само в паметта, НИКОГА не се сериализира

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
    return { new: "🆕 нов", analyzing: "⏳ анализира се", analyzed: "✅ анализиран" }[status] || status;
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
        <p class="muted" style="margin-top:10px;">
          🚧 AI анализ (жанр, hook потенциал, TikTok/YouTube стратегия и т.н.) идва в следваща фаза
          (Фаза 2 от спецификацията) — тук ще се показват структурираните резултати.
        </p>
      </div>
    `;
  },

  _closeWorkspace() {
    const modal = document.getElementById("songlabWorkspaceOut");
    if (modal) { modal.style.display = "none"; modal.innerHTML = ""; }
  },

  // ---------- Инициализация при показване на view-а ----------
  init() {
    this.renderNewForm();
    this.render();
    this._closeWorkspace();
  }
};
