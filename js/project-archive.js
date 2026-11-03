/* =========================================================
   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, трета итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   Storage, AppState, GeminiValidator, Stats, toast().
   ========================================================= */
/* =========================================================
   PROJECT ARCHIVE — история от предишни песни
   "Нов проект" вече не изтрива безвъзвратно — старият проект се
   архивира автоматично. Може и ръчно да запазиш текущия по всяко
   време, за да сравняваш Viral Score между песни във времето.
   ========================================================= */
const ARCHIVE_STORAGE = "cdb_dashboard_archive_v1";
const ProjectArchive = {
  load() {
    return Storage.get(ARCHIVE_STORAGE) || [];
  },
  saveAll(list) {
    Storage.set(ARCHIVE_STORAGE, list.slice(0, 30));
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
