/* =========================================================
   STATS — YouTube Тракер: dashboard/analytics статистика от GitHub
   repo (data/stats-history.json, data/trends-history.json), Top
   Movers, трендващи ниши, графики (Chart.js).

   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, първа/най-нискорискова итерация) —
   логиката не е променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   Vault, Keys, fetchTimeout(), toast(), Nav, Chart (external CDN).
   ========================================================= */
const Stats = {
  cache: null,

  saveRepoConfig() {
    if (Vault.isEnabled() && !Vault.isUnlocked()) { toast("🔒 Отключи трезора първо в Настройки → API Ключове"); return; }
    const prev = Keys.load();
    Keys.save({
      ...prev,
      ghOwner: document.getElementById("gh_owner").value.trim(),
      ghRepo: document.getElementById("gh_repo").value.trim(),
      ghBranch: document.getElementById("gh_branch").value.trim() || "main",
    });
    toast("Запазено — зареждам статистика...");
    this.cache = null;
    this.renderDashboard();
    this.renderAnalytics();
  },

  dataUrl() {
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) return null;
    const branch = k.ghBranch || "main";
    return `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/stats-history.json`;
  },

  async fetchData() {
    if (this.cache) return this.cache;
    const url = this.dataUrl();
    if (!url) return null;
    try {
      const res = await fetchTimeout(url);
      if (!res.ok) return null;
      this.cache = await res.json();
      return this.cache;
    } catch (e) {
      return null;
    }
  },

  trendsCache: null,
  trendsUrl() {
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) return null;
    const branch = k.ghBranch || "main";
    return `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/trends-history.json`;
  },
  async fetchTrendsData() {
    if (this.trendsCache) return this.trendsCache;
    const url = this.trendsUrl();
    if (!url) return null;
    try {
      const res = await fetchTimeout(url);
      if (!res.ok) return null;
      this.trendsCache = await res.json();
      return this.trendsCache;
    } catch (e) {
      return null;
    }
  },

  // Сравнява последните ДВА snapshot-а по video_id и връща видеата с най-голям
  // прираст на гледания между тях — реален сигнал "какво расте точно сега",
  // за разлика от абсолютните гледания в таблицата "Всички видеа".
  _computeTopMovers(snaps) {
    if (!snaps || snaps.length < 2) return null;
    const latest = snaps[snaps.length - 1];
    const prev = snaps[snaps.length - 2];
    const prevMap = new Map((prev.videos || []).map(v => [v.video_id, v]));
    return (latest.videos || [])
      .map(v => {
        const old = prevMap.get(v.video_id);
        if (!old) return null; // ново видео от последния snapshot — няма база за сравнение още
        const delta = (v.views || 0) - (old.views || 0);
        if (delta <= 0) return null;
        return { title: v.title, views: v.views || 0, delta, deltaPct: old.views ? (delta / old.views * 100) : null };
      })
      .filter(Boolean)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 8);
  },

  async renderTopMovers() {
    const el = document.getElementById("topMoversCard");
    if (!el) return;
    const data = await this.fetchData();
    const snaps = data?.snapshots || [];
    if (snaps.length < 2) {
      el.innerHTML = `<strong>📈 Top Movers (най-бързо растящи видеа)</strong>
        <p class="muted" style="margin-top:8px;">Трябват поне 2 дневни snapshot-а, за да се смята прираст — тракерът тепърва трупа история (текущо: ${snaps.length}).</p>`;
      return;
    }
    const movers = this._computeTopMovers(snaps);
    if (!movers || !movers.length) {
      el.innerHTML = `<strong>📈 Top Movers (най-бързо растящи видеа)</strong>
        <p class="muted" style="margin-top:8px;">Няма видеа с прираст спрямо предишния snapshot.</p>`;
      return;
    }
    el.innerHTML = `<strong>📈 Top Movers (най-бързо растящи видеа спрямо предния snapshot)</strong>
      <table class="data" style="margin-top:10px;"><thead><tr><th>Видео</th><th>Гледания</th><th>+ От вчера</th></tr></thead>
      <tbody>${movers.map(m =>
        `<tr><td>${m.title}</td><td>${m.views.toLocaleString()}</td><td>+${m.delta.toLocaleString()}${m.deltaPct != null ? ` (${m.deltaPct.toFixed(1)}%)` : ""}</td></tr>`).join("")}
      </tbody></table>`;
  },

  async renderTrendNiches() {
    const el = document.getElementById("trendNichesCard");
    if (!el) return;
    const data = await this.fetchTrendsData();
    const snaps = data?.snapshots || [];
    if (!snaps.length) {
      el.innerHTML = `<strong>🔥 Трендващи ниши</strong>
        <p class="muted" style="margin-top:8px;">Няма данни още — виж <strong>YouTube Тракер</strong> за setup на дневния trend snapshot.</p>`;
      return;
    }
    const latest = snaps[snaps.length - 1];
    const niches = (latest.niches || []).slice(0, 6);
    if (!niches.length) {
      el.innerHTML = `<strong>🔥 Трендващи ниши</strong><p class="muted" style="margin-top:8px;">Последният snapshot няма ниши с данни.</p>`;
      return;
    }
    el.innerHTML = `<strong>🔥 Трендващи ниши</strong> <span class="muted">· snapshot от ${latest.date}</span>
      ${niches.map(n => {
        const color = n.score > 75 ? "🟢" : n.score > 50 ? "🟡" : "⚪";
        return `<div class="copy-field"><span>${color} <strong>${n.niche}</strong> — ${n.score}/100<br>
          <span class="muted">Търсене: ${n.search_signal || "—"} · Конкуренция: ${n.competition_signal || "—"}</span></span></div>`;
      }).join("")}`;
  },

  async renderDashboard() {
    const el = document.getElementById("dashStatsArea");
    if (!el) return;
    const data = await this.fetchData();
    if (!data || !data.snapshots || !data.snapshots.length) {
      el.innerHTML = `<div class="card muted">Все още няма данни. Настрой <strong>YouTube Тракер</strong> в Настройки (GitHub repo + Actions), за да видиш статистика тук.
        <br><button class="btn ghost sm" style="margin-top:10px;" onclick="Nav.showView('stats-tracker')">Настрой сега →</button></div>`;
      return;
    }
    const snaps = data.snapshots;
    const latest = snaps[snaps.length - 1];
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : latest;
    const ch = latest.channel || {};
    const chPrev = prev.channel || {};
    const delta = (a, b) => (a - b >= 0 ? "+" : "") + (a - b).toLocaleString();

    el.innerHTML = `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Абонати</div><div class="value">${(ch.subscribers || 0).toLocaleString()}</div><div class="delta">${delta(ch.subscribers || 0, chPrev.subscribers || 0)}</div></div>
        <div class="kpi"><div class="label">Общо гледания</div><div class="value">${(ch.total_views || 0).toLocaleString()}</div><div class="delta">${delta(ch.total_views || 0, chPrev.total_views || 0)}</div></div>
        <div class="kpi"><div class="label">Общо видеа</div><div class="value">${ch.video_count || 0}</div></div>
        <div class="kpi"><div class="label">Последно обновено</div><div class="value" style="font-size:14px;">${latest.date}</div></div>
      </div>
      <div class="card" style="margin-top:14px;height:260px;"><canvas id="dashGrowthChart"></canvas></div>
      <div class="card" style="margin-top:14px;">
        <strong>Последни видеа</strong>
        <table class="data" style="margin-top:10px;"><thead><tr><th>Видео</th><th>Гледания</th><th>👍</th><th>💬</th></tr></thead>
        <tbody>${(latest.videos || []).slice(0, 6).map(v =>
          `<tr><td>${v.title}</td><td>${(v.views || 0).toLocaleString()}</td><td>${(v.likes || 0).toLocaleString()}</td><td>${(v.comments || 0).toLocaleString()}</td></tr>`).join("")}
        </tbody></table>
      </div>`;

    this._drawChart("dashGrowthChart", snaps);
  },

  async renderAnalytics() {
    const el = document.getElementById("analyticsArea");
    if (!el) return;
    const data = await this.fetchData();
    if (!data || !data.snapshots || !data.snapshots.length) {
      el.innerHTML = `<div class="card muted">Няма данни още — виж <strong>YouTube Тракер</strong> за setup.
        <button class="btn ghost sm" style="margin-left:8px;" onclick="Nav.showView('stats-tracker')">Настрой →</button></div>`;
      return;
    }
    const snaps = data.snapshots;
    const latest = snaps[snaps.length - 1];
    const videos = latest.videos || [];

    // Performance Check: сравнява views/ден-от-качване спрямо медианата на канала
    const rates = videos.map(v => {
      const days = Math.max(1, (new Date(latest.date) - new Date(v.published_at)) / 86400000);
      return { ...v, perDay: (v.views || 0) / days };
    });
    const sortedRates = [...rates].map(r => r.perDay).sort((a, b) => a - b);
    const median = sortedRates[Math.floor(sortedRates.length / 2)] || 1;

    el.innerHTML = `
      <div class="card" style="height:300px;"><canvas id="analyticsChart"></canvas></div>
      <div class="card" style="margin-top:14px;">
        <strong>Всички видеа — Performance Check</strong>
        <table class="data" style="margin-top:10px;"><thead><tr><th>Видео</th><th>Гледания</th><th>Views/ден</th><th>Perf.</th></tr></thead>
        <tbody>${rates.map(v => {
          const ratio = v.perDay / median;
          const chip = ratio > 1.3 ? '<span class="chip green">Отлично</span>' : ratio > 0.8 ? '<span class="chip cyan">Добре</span>' : '<span class="chip amber">Средно</span>';
          return `<tr><td>${v.title}</td><td>${(v.views || 0).toLocaleString()}</td><td>${v.perDay.toFixed(0)}</td><td>${chip}</td></tr>`;
        }).join("")}
        </tbody></table>
      </div>
      <div class="card" id="topMoversCard" style="margin-top:14px;">⏳ Зареждам Top Movers...</div>
      <div class="card" id="trendNichesCard" style="margin-top:14px;">⏳ Зареждам трендващи ниши...</div>`;
    this._drawChart("analyticsChart", snaps);
    this.renderTopMovers();
    this.renderTrendNiches();
  },

  _drawChart(canvasId, snaps) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === "undefined") return;
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    canvas._chartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels: snaps.map(s => s.date),
        datasets: [
          { label: "Абонати", data: snaps.map(s => s.channel?.subscribers || 0), borderColor: "#8b5cf6", backgroundColor: "transparent", tension: .35 },
          { label: "Гледания", data: snaps.map(s => s.channel?.total_views || 0), borderColor: "#22d3ee", backgroundColor: "transparent", tension: .35, yAxisID: "y1" }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { ticks: { color: "#8b8fb0" }, grid: { color: "#25263f" } },
          y1: { position: "right", ticks: { color: "#8b8fb0" }, grid: { display: false } },
          x: { ticks: { color: "#8b8fb0" }, grid: { color: "#1d1e35" } }
        },
        plugins: { legend: { labels: { color: "#eef0fb" } } }
      }
    });
  }
};
