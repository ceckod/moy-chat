/* =========================================================
   LEARNING LOOP — "Past Performance → Better Future Decisions"
   Добавен 2026-08-16 (Phase 0 audit → P1, коригирана приоритизация:
   Similarity check и Cover artwork се оказаха вече реално изградени
   при по-задълбочена проверка — виж PROJECT_STATE.md запис 4 —
   Learning Loop е реалната останала P1 липса).

   НЕ Е нов data model и не пипа съществуващи storage keys. Чисто
   read-only агрегация върху вече съществуващи данни:
     - TrackRecord.load() (js/track-record.js) — прогноза vs реалност
       за всяка песен, само записите с .actual (вече публикувани и
       свързани от потребителя).
     - IdeaVault.load() (js/idea-vault.js) — идеи, маркирани "used",
       с resultingTitle → същото свързване по заглавие.

   Извежда: кои ниши и кои източници на идеи реално представят
   най-добре — не прогнози, а измерени резултати. Ако няма достатъчно
   свързани данни (typично в начален stage на проекта), казва го
   честно вместо да показва празна/подвеждаща таблица.

   Зависимости (runtime): TrackRecord, IdeaVault (глобални, четени
   read-only — не пише в тях).

   Публичен интерфейс:
     - LearningLoop.render() — прерисува #learningLoopOut
   ========================================================= */
const LearningLoop = {
  // Обобщен performance "резултат" за сортиране — не измисля числа,
  // просто превръща категоричния .perf текст (същите стойности,
  // ползвани в TrackRecord.render()) в ред за сравнение.
  _perfRank(perf) {
    return { "Отлично": 3, "Добре": 2, "Слабо": 1 }[perf] ?? 0;
  },

  _linkedTrackRecords() {
    if (typeof TrackRecord === "undefined") return [];
    try { return TrackRecord.load().filter(r => r.actual && r.niche); } catch (e) { return []; }
  },

  _byNiche(linked) {
    const groups = {};
    linked.forEach(r => {
      const key = r.niche || "(без ниша)";
      (groups[key] = groups[key] || []).push(r);
    });
    return Object.entries(groups).map(([niche, recs]) => {
      const avgPerDay = recs.reduce((s, r) => s + (r.actual.perDay || 0), 0) / recs.length;
      const avgRank = recs.reduce((s, r) => s + this._perfRank(r.actual.perf), 0) / recs.length;
      return { niche, count: recs.length, avgPerDay, avgRank };
    }).sort((a, b) => b.avgRank - a.avgRank || b.avgPerDay - a.avgPerDay);
  },

  _bySource(linked) {
    if (typeof IdeaVault === "undefined") return [];
    let ideas = [];
    try { ideas = IdeaVault.load().filter(i => i.status === "used" && i.resultingTitle); } catch (e) { return []; }
    const linkedByTitle = new Map(linked.map(r => [r.title, r]));
    const groups = {};
    ideas.forEach(idea => {
      const rec = linkedByTitle.get(idea.resultingTitle);
      if (!rec) return; // идеята е "използвана", но песента още не е свързана с реален резултат
      const key = idea.source || "(неизвестен)";
      (groups[key] = groups[key] || []).push(rec);
    });
    return Object.entries(groups).map(([source, recs]) => {
      const avgPerDay = recs.reduce((s, r) => s + (r.actual.perDay || 0), 0) / recs.length;
      const avgRank = recs.reduce((s, r) => s + this._perfRank(r.actual.perf), 0) / recs.length;
      return { source, count: recs.length, avgPerDay, avgRank };
    }).sort((a, b) => b.avgRank - a.avgRank || b.avgPerDay - a.avgPerDay);
  },

  render() {
    const el = document.getElementById("learningLoopOut");
    if (!el) return;

    const linked = this._linkedTrackRecords();
    if (linked.length < 2) {
      el.innerHTML = `<p class="muted">Все още няма достатъчно свързани резултати (нужни са поне 2 песни с ниша, свързани към реално YouTube видео в Track Record по-долу), за да извлека надежден pattern. Продължавай да пускаш Viral Lab анализи и да свързваш публикуваните песни — тук ще се появят реални изводи, не прогнози.</p>`;
      return;
    }

    const nicheStats = this._byNiche(linked);
    const sourceStats = this._bySource(linked);

    let html = `<div class="grid cols-2">`;

    html += `<div class="card tight">
      <strong>📊 По ниша (${linked.length} свързани песни)</strong>
      <table class="data" style="margin-top:8px;"><thead><tr><th>Ниша</th><th>Песни</th><th>Views/ден (ср.)</th></tr></thead>
      <tbody>${nicheStats.map(n => `<tr><td>${this._esc(n.niche)}</td><td>${n.count}</td><td>${Math.round(n.avgPerDay).toLocaleString()}</td></tr>`).join("")}</tbody></table>
    </div>`;

    html += `<div class="card tight">
      <strong>💡 По източник на идея</strong>
      ${sourceStats.length
        ? `<table class="data" style="margin-top:8px;"><thead><tr><th>Източник</th><th>Песни</th><th>Views/ден (ср.)</th></tr></thead>
           <tbody>${sourceStats.map(s => `<tr><td>${this._esc(s.source)}</td><td>${s.count}</td><td>${Math.round(s.avgPerDay).toLocaleString()}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted" style="margin-top:8px;">Няма още песни, маркирани "Използвано" в Idea Vault, свързани с реален резултат.</p>`}
    </div>`;

    html += `</div>`;

    const topNiche = nicheStats[0];
    if (topNiche) {
      html = `<div class="card tight" style="margin-bottom:12px;border-color:var(--green);">
        <strong>🎯 Препоръка</strong>
        <p class="muted" style="margin:6px 0 0;">Нишата <strong>${this._esc(topNiche.niche)}</strong> исторически представя най-добре (${Math.round(topNiche.avgPerDay).toLocaleString()} views/ден средно, ${topNiche.count} ${topNiche.count === 1 ? "песен" : "песни"}). Обмисли следващия проект в тази посока.</p>
      </div>` + html;
    }

    el.innerHTML = html;
  },

  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
};
