/* =========================================================
   APP LOG — централизиран, ПЕРСИСТЕНТЕН log център (различно от
   SystemLog в js/system-log.js, който е само in-memory JS-error catcher
   за текущата сесия).

   Идея: всеки модул в приложението (YouTube Discovery Engine, Visualizer,
   AI анализ и т.н.) вика AppLog.write(moduleName, line) при важни събития
   (run started/finished, грешка, резултат). Записите се групират по
   ДЕН + МОДУЛ в един растящ текстов блок — точно моделът, поискан от
   потребителя: "цъкам върху лога, който е с име днешна дата и името на
   модула, лога ми излиза и мога бързо да го копирам".

   Persistence: localStorage през съществуващия Storage wrapper (същия
   механизъм като SystemTest._loadLog()/_saveLog() в js/system-test.js —
   следвам същия установен pattern за консистентност).

   Self-cleaning: записи, чийто dateKey е по-стар от retention_days
   (настройка, по подразбиране 3 дни — виж #appLogRetentionInput),
   се трият автоматично при следващо write()/render().

   Как ДРУГИ модули да пишат тук (пример):
     AppLog.write("YouTube Discovery Engine", "▶️ Run Now стартиран");
     AppLog.write("YouTube Discovery Engine", "✅ Готово: +3 добавени, 0 грешки");

   За Visualizer (visualizer.html) — зарежда се в <iframe id="visualizerFrame">,
   САЩ same-origin (относителен път), затова МОЖЕ директно да вика:
     parent.AppLog?.write("Visualizer", "...");
   от вътрешния JS на visualizer.html. Това НЕ е добавено автоматично тук
   (visualizer.html е отделен, много голям генериран файл — извън обхвата
   на тази промяна), но интеграцията е с една реплика, ако потрябва.

   Публичен интерфейс:
     - AppLog.write(module, line)     — добавя ред към днешния лог за модула
     - AppLog.render()                — прерисува #appLogOut
     - AppLog.copy(groupKey)          — копира пълния текст на една група
     - AppLog.toggle(groupKey)        — разгъва/свива група
     - AppLog.clearGroup(groupKey)    — трие една група
     - AppLog.clearAll()              — трие всичко
     - AppLog.saveRetention()         — чете #appLogRetentionInput, записва
   ========================================================= */

const AppLog = {
  _KEY: "cdb_app_log_v1",
  _RETENTION_KEY: "cdb_app_log_retention_days",
  _DEFAULT_RETENTION_DAYS: 3,
  // Максимален брой редове, пазени в ЕДНА група (ден+модул) — виж write()
  // по-долу. Пазенето по дни (_prune) не е достатъчно само по себе си: ако
  // даден модул пише стотици редове В РАМКИТЕ на 1 ден (напр. дълъг
  // автоматизиран run на YouTube Discovery Engine), lines масивът расте
  // неограничено ПРЕДИ да остарее по дата — а ЦЕЛИЯТ обект се сериализира
  // и записва в localStorage при ВСЕКИ write() (виж this._save(data) по-
  // долу), значи расте и цената на всеки следващ запис. Ограничението пази
  // последните MAX_LINES реда — най-новите, най-полезните за дебъгване.
  _MAX_LINES_PER_GROUP: 500,
  _expanded: new Set(),

  _todayKey() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  _fmtDateKey(dateKey) {
    const [y, m, d] = dateKey.split("-");
    return `${d}.${m}.${y}`;
  },

  _groupKey(dateKey, module) {
    return `${dateKey}__${module}`;
  },

  _load() {
    return Storage.get(this._KEY) || {};
  },
  _save(data) {
    Storage.set(this._KEY, data);
  },

  getRetentionDays() {
    return Storage.get(this._RETENTION_KEY) || this._DEFAULT_RETENTION_DAYS;
  },
  saveRetention() {
    const val = parseInt(document.getElementById("appLogRetentionInput")?.value, 10);
    if (!val || val < 1) { toast("⚠️ Въведи валиден брой дни (мин. 1)"); return; }
    Storage.set(this._RETENTION_KEY, val);
    toast(`✅ Логовете сега се пазят ${val} дни`);
    this._prune();
    this.render();
  },

  // Трие групи, по-стари от retention_days — сравнява по createdAt (ts на
  // ПЪРВИЯ запис в деня), не по calendar diff на dateKey стринга, за да е
  // точно дори около полунощ/часова зона.
  _prune() {
    const retentionMs = this.getRetentionDays() * 24 * 60 * 60 * 1000;
    const data = this._load();
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(data)) {
      if (now - data[key].createdAt > retentionMs) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) this._save(data);
  },

  write(module, line) {
    this._prune();
    const dateKey = this._todayKey();
    const key = this._groupKey(dateKey, module);
    const data = this._load();
    if (!data[key]) {
      data[key] = { dateKey, module, createdAt: Date.now(), updatedAt: Date.now(), lines: [] };
    }
    const time = new Date().toLocaleTimeString("bg-BG");
    data[key].lines.push(`[${time}] ${line}`);
    if (data[key].lines.length > this._MAX_LINES_PER_GROUP) {
      data[key].lines = data[key].lines.slice(-this._MAX_LINES_PER_GROUP);
    }
    data[key].updatedAt = Date.now();
    this._save(data);
    this.render();
  },

  _fullText(entry) {
    return `${entry.module} — ${this._fmtDateKey(entry.dateKey)}\n${"─".repeat(40)}\n${entry.lines.join("\n")}`;
  },

  copy(groupKey) {
    const data = this._load();
    const entry = data[groupKey];
    if (!entry) return;
    navigator.clipboard.writeText(this._fullText(entry))
      .then(() => toast(`📋 Логът "${entry.module}" е копиран`))
      .catch(() => toast("⚠️ Неуспешно копиране — браузърът отказа достъп до clipboard"));
  },

  toggle(groupKey) {
    if (this._expanded.has(groupKey)) this._expanded.delete(groupKey);
    else this._expanded.add(groupKey);
    this.render();
  },

  clearGroup(groupKey) {
    const data = this._load();
    delete data[groupKey];
    this._save(data);
    this.render();
  },

  clearAll() {
    if (!confirm("Изтрий ВСИЧКИ логове (за всички дни и модули)?")) return;
    this._save({});
    this._expanded.clear();
    this.render();
    toast("🧹 Логовете са изчистени");
  },

  _esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  },

  render() {
    const el = document.getElementById("appLogOut");
    if (!el) return;
    this._prune();
    const data = this._load();
    const groups = Object.entries(data).sort((a, b) => b[1].updatedAt - a[1].updatedAt);

    const retentionInput = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
        <label class="muted" style="font-size:12.5px;">Пази логовете за</label>
        <input type="number" id="appLogRetentionInput" min="1" style="width:70px;" value="${this.getRetentionDays()}">
        <span class="muted" style="font-size:12.5px;">дни</span>
        <button class="btn ghost sm" onclick="AppLog.saveRetention()">💾 Запази</button>
        <button class="btn ghost sm" onclick="AppLog.clearAll()">🧹 Изчисти всичко</button>
      </div>`;

    if (!groups.length) {
      el.innerHTML = retentionInput + `<p class="muted">Още няма записани логове. Модулите (напр. 🎧 YouTube Discovery Engine) пишат тук автоматично при важни събития (Run Now, грешки, резултати).</p>`;
      return;
    }

    // групирано визуално по дата (най-новата отгоре), после по модул вътре в деня
    const byDate = {};
    for (const [key, entry] of groups) {
      byDate[entry.dateKey] = byDate[entry.dateKey] || [];
      byDate[entry.dateKey].push([key, entry]);
    }
    const dateKeys = Object.keys(byDate).sort().reverse();

    el.innerHTML = retentionInput + dateKeys.map(dateKey => `
      <div class="section-title" style="margin-top:16px;font-size:13px;">📅 ${this._fmtDateKey(dateKey)}</div>
      ${byDate[dateKey].map(([key, entry]) => {
        const isOpen = this._expanded.has(key);
        return `<div class="card" style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;" onclick="AppLog.toggle('${key}')">
            <span><strong>📋 ${this._esc(entry.module)}</strong> <span class="muted" style="font-size:11.5px;">— ${entry.lines.length} реда</span></span>
            <span class="muted" style="font-size:11px;">${isOpen ? "свий ▴" : "разгъни ▾"}</span>
          </div>
          ${isOpen ? `
            <div style="margin-top:10px;font-family:var(--font-mono);font-size:11.5px;white-space:pre-wrap;max-height:320px;overflow-y:auto;background:var(--bg);border-radius:8px;padding:10px;">${this._esc(entry.lines.join("\n"))}</div>
            <div style="margin-top:10px;display:flex;gap:8px;">
              <button class="btn ghost sm" onclick="event.stopPropagation();AppLog.copy('${key}')">📋 Копирай</button>
              <button class="btn ghost sm" onclick="event.stopPropagation();AppLog.clearGroup('${key}')">🗑️ Изтрий</button>
            </div>` : ""}
        </div>`;
      }).join("")}
    `).join("");
  },
};
