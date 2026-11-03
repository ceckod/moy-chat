/* =========================================================
   PROJECT DASHBOARD — aggregation layer ("текущ проект / next action")
   Добавен 2026-08-16 (Phase 0 audit → P0).

   Не е нов data model. Чете съществуващите namespace-и (AppState,
   ProjectArchive, TrackRecord, QuotaTracker) и извежда derived изглед:
   "Кой е текущият проект, на кой етап е, каква е следващата стъпка."
   Не мести/променя нито един storage key.

   Зависимости (runtime, вътре в методи — редът на <script> тагове не е
   критичен, но зареден е след AppState/ProjectArchive/TrackRecord/
   QuotaTracker в index.html по конвенция): AppState, ProjectArchive,
   TrackRecord, QuotaTracker, Storage (глобален).

   Кой го ползва: Nav.showView("dashboard") вика ProjectDashboard.render()
   (виж js/nav.js), редом до съществуващия Stats.renderDashboard()
   (YouTube channel stats — различна отговорност, не се пипа).

   Публичен интерфейс:
     - ProjectDashboard.render() — прерисува #projectNextAction
   ========================================================= */
const ProjectDashboard = {
  // 7-степенен pipeline по Master Prompt т.4. "done" се извежда от
  // реални данни в AppState.project — не от неизползваното поле
  // AppState.data.status (потвърдено grep-нато като мъртво, никой
  // модул не го чете/пише към момента на писане на този файл).
  _stages(p) {
    return [
      { key: "research", label: "Проучване", view: "step1", done: !!p.chosenNiche,
        hint: "Избери ниша от Пазарен анализ (Стъпка 1)." },
      { key: "concept", label: "Концепция", view: "step1", done: !!(p.title && p.stylePrompt),
        hint: "Генерирай заглавие + Style Prompt." },
      { key: "song", label: "Текст", view: "step1", done: !!p.lyrics,
        hint: "Генерирай текста на песента." },
      { key: "visual", label: "Визуал", view: "step2", done: !!p.fxConfig,
        hint: "Конфигурирай FX и Видео1→Видео2 прехода във визуализатора." },
      { key: "cover", label: "Обложка", view: "step3", done: !!(p.coverImageUrl || p.coverPrompt),
        hint: "Генерирай обложка за песента." },
      { key: "publish", label: "Публикуване", view: "step3", done: this._isPublished(p),
        hint: "Попълни DistroKid/Spotify/YouTube метаданни и качи." },
      { key: "track", label: "Проследяване", view: "stats-analytics", done: this._isTracked(p),
        hint: "Свържи публикуваното видео в Track Record (Стъпка 1 → Viral Lab → Track Record), за да следиш реалното представяне." }
    ];
  },

  _isPublished(p) {
    return !!(p.youtube && (p.youtube.videoId || p.youtube.published));
  },

  _isTracked(p) {
    if (!p.title || typeof TrackRecord === "undefined") return false;
    try {
      return TrackRecord.load().some(r => r.title === p.title && r.actual);
    } catch (e) { return false; }
  },

  render() {
    const el = document.getElementById("projectNextAction");
    if (!el) return;
    if (typeof AppState === "undefined" || !AppState.data) return;
    const p = AppState.data.project || {};

    const stages = this._stages(p);
    const nextIdx = stages.findIndex(s => !s.done);
    const next = nextIdx === -1 ? null : stages[nextIdx];

    const pipelineHtml = stages.map((s, i) => {
      const icon = s.done ? "✓" : (i === nextIdx ? "●" : "○");
      const cls = s.done ? "green" : (i === nextIdx ? "cyan" : "");
      return `<span class="chip ${cls}" style="margin:2px 4px 2px 0;">${icon} ${s.label}</span>`;
    }).join("");

    const projectName = p.title || "(без заглавие — нов проект)";

    const nextActionHtml = next
      ? `<strong>Следваща стъпка: ${next.label}</strong>
         <p class="muted" style="margin:6px 0 0;">${next.hint}</p>
         <button class="btn grad sm" style="margin-top:10px;" onclick="Nav.showView('${next.view}')">Продължи →</button>`
      : `<strong>🎉 Всички етапи готови</strong>
         <p class="muted" style="margin:6px 0 0;">Проектът е преминал целия pipeline. Архивирай го и започни следващ.</p>
         <button class="btn grad sm" style="margin-top:10px;" onclick="ProjectArchive.saveCurrent()">💾 Архивирай проекта</button>`;

    el.innerHTML = `
      <div class="card" style="background:var(--grad);border:none;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
          <div>
            <span style="color:rgba(255,255,255,.75);font-size:12px;">ТЕКУЩ ПРОЕКТ</span>
            <h3 style="margin:2px 0 0;color:#fff;">${this._esc(projectName)}</h3>
          </div>
          <div>${pipelineHtml}</div>
        </div>
      </div>
      <div class="card" style="margin-top:10px;">${nextActionHtml}</div>
      <div class="grid cols-3" style="margin-top:10px;" id="projectTodayCards"></div>
    `;

    this._renderToday();
  },

  _renderToday() {
    const el = document.getElementById("projectTodayCards");
    if (!el) return;
    let totalCalls = 0;
    try {
      if (typeof QuotaTracker !== "undefined") {
        totalCalls = Object.values(QuotaTracker.summary()).reduce((a, b) => a + b, 0);
      }
    } catch (e) { /* остави 0 */ }

    let archiveCount = 0;
    try {
      if (typeof ProjectArchive !== "undefined") archiveCount = ProjectArchive.load().length;
    } catch (e) { /* остави 0 */ }

    const step = (AppState.data.currentStep || 1);

    el.innerHTML = `
      <div class="kpi"><div class="label">AI извиквания днес</div><div class="value">${totalCalls}</div></div>
      <div class="kpi"><div class="label">Архивирани песни</div><div class="value">${archiveCount}</div></div>
      <div class="kpi"><div class="label">Текуща стъпка</div><div class="value">${step}/4</div></div>
    `;
  },

  // Малка utility — заглавието на проекта идва от потребителски вход
  // (AI-генерирано или ръчно), затова escape-ваме преди innerHTML.
  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
};
