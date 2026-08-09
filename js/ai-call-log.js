/* =========================================================
   AI CALL LOG — диагностичен лог кой provider/модел РЕАЛНО е
   отговорил на всяко извикване (и кои опити са гръмнали по пътя).
   Полезно е за да се вижда напр. "Gemini flash-lite гръмна → падна на
   flash → отговори". Пази се отделно от проекта (не се export-ва с него),
   само последните AI_CALL_LOG_MAX записа.
   ========================================================= */
const AI_CALL_LOG_KEY = "cdb_ai_call_log_v1";
const AI_CALL_LOG_MAX = 40;

const AICallLog = {
  record({ provider, model, ok, note }) {
    let log = [];
    try { log = Storage.get(AI_CALL_LOG_KEY) || []; } catch (e) { /* счупен лог, пренапиши */ }
    log.unshift({ ts: Date.now(), provider, model, ok: !!ok, note: note || "" });
    log = log.slice(0, AI_CALL_LOG_MAX);
    Storage.set(AI_CALL_LOG_KEY, log);
    this._renderIfVisible();
  },
  get() {
    try { return Storage.get(AI_CALL_LOG_KEY) || []; } catch (e) { return []; }
  },
  clear() {
    Storage.remove(AI_CALL_LOG_KEY);
    this._renderIfVisible();
  },
  _renderIfVisible() {
    if (document.getElementById("aiCallLogOut")) this.render();
    if (document.getElementById("aiLeaderboardOut")) this.renderLeaderboard();
  },
  render() {
    const el = document.getElementById("aiCallLogOut");
    if (!el) return;
    const log = this.get();
    if (!log.length) { el.textContent = "Все още няма записани извиквания в тази сесия/устройство."; return; }
    el.textContent = log.map(e => {
      const time = new Date(e.ts).toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const providerLabel = e.provider === "claude" ? "Claude" : e.provider === "gemini" ? "Gemini" : e.provider === "openrouter" ? "OpenRouter" : e.provider === "modelfinder" ? "AI Model Finder" : e.provider;
      return `${time} ${e.ok ? "✅" : "❌"} ${providerLabel} · ${e.model}${e.note ? " — " + e.note : ""}`;
    }).join("\n");
  },

  // ---------- Leaderboard по надеждност ----------
  // Смята процент успех за всеки provider+модел от последните записи в лога.
  // Ползва се от Settings.testKeys(), за да пробва първо моделите, които
  // исторически са работили най-добре на това устройство, вместо сляпо да
  // следва статичния fallback ред всеки път.
  getLeaderboard(provider) {
    const log = this.get().filter(e => e.provider === provider);
    const stats = {};
    for (const e of log) {
      if (!stats[e.model]) stats[e.model] = { ok: 0, total: 0, lastTs: 0 };
      stats[e.model].total++;
      if (e.ok) stats[e.model].ok++;
      stats[e.model].lastTs = Math.max(stats[e.model].lastTs, e.ts);
    }
    return Object.entries(stats)
      .map(([model, s]) => ({ model, rate: s.ok / s.total, total: s.total, lastTs: s.lastTs }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total || b.lastTs - a.lastTs);
  },

  // Подрежда models[] по историческа надеждност (най-добрите отпред);
  // модели без история остават по края в оригиналния си ред.
  sortByReliability(provider, models) {
    const board = this.getLeaderboard(provider);
    const rank = new Map(board.map((b, i) => [b.model, i]));
    return [...models].sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a) : Infinity;
      const rb = rank.has(b) ? rank.get(b) : Infinity;
      if (ra === rb) return 0;
      return ra - rb;
    });
  },

  renderLeaderboard() {
    const el = document.getElementById("aiLeaderboardOut");
    if (!el) return;
    const rows = [];
    for (const provider of ["claude", "gemini", "openrouter"]) {
      const board = this.getLeaderboard(provider);
      if (!board.length) continue;
      const label = provider === "claude" ? "Claude" : provider === "gemini" ? "Gemini" : "OpenRouter";
      rows.push(`<div style="font-size:11px;opacity:.7;margin:8px 0 4px;">${label}:</div>`);
      for (const b of board) {
        const pct = Math.round(b.rate * 100);
        const color = pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--amber)" : "var(--red)";
        rows.push(`<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;">
          <div style="width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${b.model}</div>
          <div style="flex:1;background:var(--panel-2);border-radius:5px;height:12px;overflow:hidden;">
            <div style="width:${Math.max(4, pct)}%;height:100%;background:${color};"></div>
          </div>
          <div style="width:70px;text-align:right;flex-shrink:0;">${pct}% (${b.total})</div>
        </div>`);
      }
    }
    el.innerHTML = rows.length ? rows.join("") : "Още няма достатъчно история за класация.";
  }
};
