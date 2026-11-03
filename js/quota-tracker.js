/* =========================================================
   QUOTA TRACKER — извадено от app.js (Стъпка 8 от одита: по-нататъшно
   разбиване на app.js по namespace обект, едно на итерация).

   Приблизителен, ЛОКАЛЕН брояч на извиквания на ден, по provider+модел.
   Google/Anthropic не връщат "оставаща квота" през API-то, затова това е
   само груба ориентация (не официална бройка) — нулира се условно "на нов
   ден" по UTC дата на устройството.

   Зареден е като обикновен classic <script> (НЕ module) ПРЕДИ app.js в
   index.html. Единствената зависимост е глобалният `Storage` (дефиниран в
   app.js) — `_load()`/`_save()` се извикват само при реално record()/
   render(), не на топ ниво при зареждане, затова редът не чупи нищо.

   Grep-потвърдено (преди извеждането): QUOTA_TRACKER_KEY се ползва само
   вътре в QuotaTracker. Външни извиквания: QuotaTracker.record() от
   js/providers/fallback-loop.js (вътре в функция, не на топ ниво — редът
   спрямо fallback-loop.js е без значение) и QuotaTracker.render() от
   onclick в index.html (view "set-keys").

   Зависимости: Storage (глобален, остава в app.js).

   Публичен интерфейс:
     - QuotaTracker.record(provider, model) — вика се от fallback-loop.js
       след всяко успешно AI извикване
     - QuotaTracker.summary() — връща { "provider · model": count }
     - QuotaTracker.render() — прерисува #quotaTrackerOut
   ========================================================= */
const QUOTA_TRACKER_KEY = "cdb_quota_tracker_v1";

const QuotaTracker = {
  _today() { return new Date().toISOString().slice(0, 10); },
  _load() {
    try { return Storage.get(QUOTA_TRACKER_KEY) || {}; } catch (e) { return {}; }
  },
  _save(data) { Storage.set(QUOTA_TRACKER_KEY, data); },

  record(provider, model) {
    const data = this._load();
    const day = this._today();
    if (data.day !== day) { data.day = day; data.counts = {}; } // нов ден — чист брояч
    data.counts = data.counts || {};
    const key = provider + " · " + model;
    data.counts[key] = (data.counts[key] || 0) + 1;
    this._save(data);
    this._renderIfVisible();
  },

  summary() {
    const data = this._load();
    if (data.day !== this._today()) return {};
    return data.counts || {};
  },

  _renderIfVisible() {
    if (document.getElementById("quotaTrackerOut")) this.render();
  },

  render() {
    const el = document.getElementById("quotaTrackerOut");
    if (!el) return;
    const counts = this.summary();
    const keys = Object.keys(counts);
    if (!keys.length) { el.textContent = "Още няма извиквания днес на това устройство."; return; }
    const max = Math.max(...keys.map(k => counts[k]));
    el.innerHTML = '<div style="font-size:11px;opacity:.7;margin-bottom:8px;">Днес (приблизително, локален брояч — не официална квота):</div>' +
      keys.sort((a, b) => counts[b] - counts[a]).map(k => {
        const v = counts[k];
        const pct = Math.max(4, Math.round((v / max) * 100));
        return `<div style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px;">
          <div style="width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${k}</div>
          <div style="flex:1;background:var(--panel-2);border-radius:5px;height:14px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:var(--grad);"></div>
          </div>
          <div style="width:26px;text-align:right;flex-shrink:0;">${v}</div>
        </div>`;
      }).join("");
  }
};
