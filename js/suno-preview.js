/* =========================================================
   SUNO AUDIO PREVIEW PLAYER — нов инструмент (добавен 2026-08-13)

   Цел: преглед на Suno AI output директно в браузъра, без сваляне —
   или чрез paste на директен audio линк (Suno share страницата дава
   пряк CDN .mp3 линк — "копирай адреса на аудиото"), или чрез
   локален файл, ако вече е свален. Стандартен HTML5 <audio controls>
   — нативна поддръжка на mp3/wav/ogg във всеки браузър, без нужда
   от VLC или друга външна библиотека.

   Двата режима:
   - URL режим: audio.src = директния линк → нула download на
     устройството, чист streaming preview.
   - Файл режим: URL.createObjectURL(file) → инстантен локален preview.
     ВАЖНО: Object URL-и НЕ надживяват презареждане на страницата
     (браузърно ограничение) — затова локалните записи в историята
     пазят само име/дата, не самия звук; при "▶️" от историята за
     локален запис просто подканваме потребителя да избере файла пак.

   История: последните SUNO_PREVIEW_HISTORY_MAX прегледа, пазени през
   Storage (виж js/storage.js) под собствен localStorage ключ.

   Изолиран модул (виж MODULE-MAP.md) — НЕ чете/пише AppState.data.project,
   не е обвързан с текущата песен/проект. Единствени зависимости:
   Storage (js/storage.js) и toast() (глобален helper). Затова е
   безопасен за пипане сам по себе си, без риск за други модули.
   ========================================================= */

const SUNO_PREVIEW_HISTORY_KEY = "cdb_suno_preview_history_v1";
const SUNO_PREVIEW_HISTORY_MAX = 20;

const SunoPreview = {
  _activeTab: "url",
  _currentObjectUrl: null, // пази се, за да се revoke-не при смяна на локален файл (памет)

  switchTab(tab) {
    this._activeTab = tab;
    const panelUrl = document.getElementById("spPanelUrl");
    const panelFile = document.getElementById("spPanelFile");
    const btnUrl = document.getElementById("spTabUrlBtn");
    const btnFile = document.getElementById("spTabFileBtn");
    if (panelUrl) panelUrl.style.display = tab === "url" ? "block" : "none";
    if (panelFile) panelFile.style.display = tab === "file" ? "block" : "none";
    if (btnUrl) btnUrl.className = "btn " + (tab === "url" ? "grad" : "ghost");
    if (btnFile) btnFile.className = "btn " + (tab === "file" ? "grad" : "ghost");
  },

  loadFromUrl() {
    const input = document.getElementById("spUrlInput");
    const url = (input?.value || "").trim();
    if (!url) { toast("Постави линк към Suno аудио файла първо."); return; }
    if (!/^https?:\/\//i.test(url)) { toast("Линкът трябва да започва с http:// или https://"); return; }
    this._play(url, url, /*isLocal*/ false);
  },

  onFileSelected(inputEl) {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;
    if (this._currentObjectUrl) URL.revokeObjectURL(this._currentObjectUrl);
    const objUrl = URL.createObjectURL(file);
    this._currentObjectUrl = objUrl;
    this._play(objUrl, file.name, /*isLocal*/ true);
  },

  _play(src, label, isLocal) {
    const audio = document.getElementById("spAudio");
    const wrap = document.getElementById("spPlayerWrap");
    const nowPlaying = document.getElementById("spNowPlaying");
    if (!audio || !wrap) return;
    audio.src = src;
    audio.play().catch(() => { /* автоплей може да е блокиран от браузъра — плейърът пак е готов за ръчен старт */ });
    wrap.style.display = "block";
    if (nowPlaying) nowPlaying.textContent = `🎵 ${label}`;
    this._addToHistory(label, isLocal ? null : src, isLocal);
  },

  _addToHistory(label, url, isLocal) {
    let hist = Storage.get(SUNO_PREVIEW_HISTORY_KEY) || [];
    hist.unshift({ label, url, isLocal, time: new Date().toLocaleString("bg-BG") });
    hist = hist.slice(0, SUNO_PREVIEW_HISTORY_MAX);
    Storage.set(SUNO_PREVIEW_HISTORY_KEY, hist);
    this.render();
  },

  replay(i) {
    const hist = Storage.get(SUNO_PREVIEW_HISTORY_KEY) || [];
    const entry = hist[i];
    if (!entry) return;
    if (entry.isLocal) {
      toast("Локален файл — избери го отново от 📁 Локален файл (браузърът не пази достъп между сесии).");
      this.switchTab("file");
      return;
    }
    this.switchTab("url");
    const input = document.getElementById("spUrlInput");
    if (input) input.value = entry.url;
    this._play(entry.url, entry.label, false);
  },

  removeFromHistory(i) {
    let hist = Storage.get(SUNO_PREVIEW_HISTORY_KEY) || [];
    hist.splice(i, 1);
    Storage.set(SUNO_PREVIEW_HISTORY_KEY, hist);
    this.render();
  },

  clearHistory() {
    Storage.remove(SUNO_PREVIEW_HISTORY_KEY);
    this.render();
    toast("Историята е изчистена.");
  },

  render() {
    const el = document.getElementById("spHistoryOut");
    if (!el) return;
    const hist = Storage.get(SUNO_PREVIEW_HISTORY_KEY) || [];
    if (!hist.length) { el.innerHTML = `<p class="muted">Все още няма преслушани песни.</p>`; return; }
    el.innerHTML = hist.map((h, i) => `
      <div class="copy-field">
        <span><strong>${h.isLocal ? "📁" : "🔗"} ${h.label}</strong> <span class="muted">· ${h.time}</span></span>
        <span>
          <button onclick="SunoPreview.replay(${i})">▶️</button>
          <button onclick="SunoPreview.removeFromHistory(${i})">🗑️</button>
        </span>
      </div>`).join("");
  }
};
