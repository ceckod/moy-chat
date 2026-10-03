/* =========================================================
   YT CHANNEL CONSULTANT — отделен Dashboard модул (раздел "Статистика")

   Какво прави (всичко в браузъра, без нови ключове и без backend):
     1. Audit    — публичен анализ на канала: абонати/views, последни 30
                   дни, Shorts vs Long, outliers (видеа ≥ 3× медианата).
     2. Заглавия — оценка 0-100 на заглавия спрямо keyword таблицата.
     3. Keywords — ранг "търсене / конкуренция".
     4. AI отчет — стратегически анализ през callAI() (Claude/Gemini/
                   OpenRouter/ModelFinder — същата верига като останалия
                   сайт). Включва ръст от data/stats-history.json и
                   ниши от data/trends-history.json, ако ги има.

   Keywords: "Търсене" е ръчна оценка (YouTube няма API за честота на
   търсене). "Конкуренция" се мери жива — брой видеа последните 30 дни
   през search.list (100 quota ед. на дума, кеш 24ч, макс 10 на натискане).
   Предложения: keywordSuggest() от js/youtube.js (иска Proxy URL).

   Ключове: САМО вече въведените в Настройки → API Ключове
   (Keys.load().ytApiKey за YouTube; AI през callAI()). Нищо ново.

   НЕ включва (умишлено): private Analytics (OAuth), Telegram/Email
   известия, Stability thumbnails — изискват ключове/сървър, които
   dashboard-ът няма.

   Зависимости (runtime): Keys, Storage, fetchTimeout, proxied, callAI, toast, keywordSuggest,
   YouTubeDiscovery._fetchJson (по избор — за stats/trends история).
   Ползва се от: Nav.showView("yt-consultant") → Consultant.render().
   Чистата логика е в ConsultantCore (тествана в test/consultant.test.mjs).
   ========================================================= */

const CONSULTANT_CHANNEL_KEY = "cdb_consultant_channel_v1";
const CONSULTANT_KEYWORDS_KEY = "cdb_consultant_keywords_v1";
const CONSULTANT_LIVE_KEY = "cdb_consultant_live_v1";
const CONSULTANT_LIVE_TTL_MS = 24 * 3600 * 1000; // кеш, за да не горим quota (100 ед. на дума)
const CONSULTANT_LIVE_MAX_PER_RUN = 10;

const ConsultantCore = {
  // Статични приблизителни стойности (не са живи данни) — редактирай от UI.
  DEFAULT_KEYWORDS: [
    { term: "чалга", volume: 17330, competition: 33 },
    { term: "кючек", volume: 11506, competition: 28 },
    { term: "българска музика", volume: 9449, competition: 22 },
    { term: "поп фолк", volume: 4744, competition: 22 },
    { term: "купон", volume: 4148, competition: 19 },
    { term: "чалга 2026", volume: 5392, competition: 29 },
    { term: "български песни", volume: 3878, competition: 12 },
    { term: "любовни песни", volume: 4742, competition: 22 },
    { term: "фолк", volume: 13473, competition: 31 },
    { term: "bulgarian music", volume: 17999, competition: 13 },
  ],
  OUTLIER_THRESHOLD: 3,
  SHORTS_MAX_SECONDS: 180, // Shorts вече могат да са до 3 мин.

  parseDuration(iso) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
    if (!m) return 0;
    return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  },

  isShort(video) {
    return this.parseDuration(video.contentDetails?.duration) <= this.SHORTS_MAX_SECONDS;
  },

  views(v) { return parseInt(v.statistics?.viewCount || "0", 10) || 0; },

  median(nums) {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },

  recentVideos(videos, days = 30, now = Date.now()) {
    const cutoff = now - days * 86400000;
    return videos.filter(v => Date.parse(v.snippet?.publishedAt) >= cutoff);
  },

  findOutliers(videos, threshold = this.OUTLIER_THRESHOLD) {
    if (!videos.length) return { median: 0, totalViews: 0, outliers: [] };
    const views = videos.map(v => this.views(v));
    const median = this.median(views);
    const total = views.reduce((a, b) => a + b, 0);
    const outliers = [];
    videos.forEach(v => {
      const vv = this.views(v);
      if (median > 0 && vv >= threshold * median) {
        outliers.push({
          id: v.id, title: v.snippet.title, views: vv,
          multiple: Math.round(vv / median * 10) / 10,
          shareOfTotal: total ? Math.round(vv / total * 10000) / 100 : 0,
          isShort: this.isShort(v),
        });
      }
    });
    outliers.sort((a, b) => b.views - a.views);
    return { median, totalViews: total, outliers };
  },

  shortsVsLong(videos) {
    const shorts = videos.filter(v => this.isShort(v));
    const longs = videos.filter(v => !this.isShort(v));
    const avg = vs => vs.length ? Math.round(vs.reduce((a, v) => a + this.views(v), 0) / vs.length) : 0;
    return { shortsCount: shorts.length, shortsAvgViews: avg(shorts), longCount: longs.length, longAvgViews: avg(longs) };
  },

  verdict(score) {
    if (score >= 75) return "Отлично — пускай";
    if (score >= 60) return "Добре — може да се подобри";
    if (score >= 45) return "Слабо — преработи";
    return "Лошо — смени подхода";
  },

  scoreTitle(title, keywords) {
    const t = title.toLowerCase();
    const matched = [];
    let kw = 0;
    for (const k of keywords) {
      if (t.includes(k.term.toLowerCase())) {
        matched.push(k.term);
        const vol = k.volume || 0, comp = k.competition ?? 50;
        if (vol > 0) { kw += Math.min(20, vol / 1000); kw -= comp / 20; }
      }
    }
    const breakdown = { keyword: Math.round(Math.max(0, Math.min(40, kw)) * 10) / 10 };
    const n = [...title].length; // Unicode-aware дължина (емоджита = 1)
    breakdown.length = (n >= 30 && n <= 70) ? 20 : (n >= 20 && n <= 80) ? 14 : 6;
    let appeal = 0;
    if (/\d{4}/.test(title)) appeal += 8;
    if (/[🔥💃⭐❗]/u.test(title)) appeal += 7;
    if (["нов", "топ", "най-", "хит"].some(w => t.includes(w))) appeal += 5;
    if (title.includes("|") || title.includes("—")) appeal += 5;
    breakdown.appeal = Math.min(25, appeal);
    const words = title.trim().split(/\s+/).filter(Boolean).length;
    breakdown.specificity = (words >= 5 && words <= 12) ? 15 : 8;
    const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0));
    return { title, score, breakdown, matched, verdict: this.verdict(score) };
  },

  scoreMany(titles, keywords) {
    return titles.map(t => this.scoreTitle(t, keywords)).sort((a, b) => b.score - a.score);
  },

  // Жива конкуренция (брой видеа последните 30 дни от YouTube) → индекс 1..100 (лог. скала,
  // защото броят варира от стотици до милиони). Ползва се САМО ако всички оценявани
  // keywords имат live стойност — иначе смесването на две скали би подвеждало.
  liveCompetitionIndex(rated, live) {
    if (!live || !rated.length || !rated.every(k => live[k.term] && Number.isFinite(live[k.term].count))) return null;
    const logs = rated.map(k => Math.log(live[k.term].count + 1));
    const lo = Math.min(...logs), hi = Math.max(...logs);
    const out = {};
    rated.forEach((k, i) => { out[k.term] = hi === lo ? 50 : Math.round(1 + 99 * (logs[i] - lo) / (hi - lo)); });
    return out;
  },

  findOpportunities(keywords, minVolume = 1000, live = null) {
    const rated = keywords.filter(k => (k.volume || 0) >= minVolume);
    if (!rated.length) return [];
    const idx = this.liveCompetitionIndex(rated, live);
    const list = rated.map(k => {
      const comp = idx ? idx[k.term] : (k.competition ?? 50);
      return {
        term: k.term, volume: k.volume, competition: comp,
        compSource: idx ? "live" : "manual",
        liveVideos30d: live?.[k.term]?.count ?? null,
        raw: k.volume / (comp + 1),
      };
    });
    const max = Math.max(...list.map(x => x.raw));
    list.forEach(x => { x.score = Math.round(x.raw / max * 100); });
    return list.sort((a, b) => b.score - a.score);
  },

  // Keywords без ръчно търсене (напр. добавени от YouTube предложения): само жива конкуренция,
  // подредени от най-малко видеа нагоре. Без число за търсене няма и смислен score.
  unrated(keywords, minVolume = 1000, live = null) {
    return keywords
      .filter(k => (k.volume || 0) < minVolume)
      .map(k => ({ term: k.term, liveVideos30d: live?.[k.term]?.count ?? null }))
      .sort((a, b) => (a.liveVideos30d ?? Infinity) - (b.liveVideos30d ?? Infinity));
  },

  // Ръст между последния snapshot и най-близкия преди ~daysBack дни (формат на stats-history.json).
  growth(history, daysBack = 7) {
    const snaps = [...(history?.snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));
    if (snaps.length < 2) return null;
    const latest = snaps[snaps.length - 1];
    const targetMs = Date.parse(latest.date) - daysBack * 86400000;
    const older = snaps.slice(0, -1).filter(s => Date.parse(s.date) <= targetMs);
    const base = older.length ? older[older.length - 1] : snaps[0];
    const prev = new Map((base.videos || []).map(v => [v.video_id, v]));
    const movers = [];
    (latest.videos || []).forEach(v => {
      const p = prev.get(v.video_id);
      if (p) movers.push({ title: v.title, viewsGained: (v.views || 0) - (p.views || 0) });
    });
    movers.sort((a, b) => b.viewsGained - a.viewsGained);
    const lc = latest.channel || {}, bc = base.channel || {};
    return {
      from: base.date, to: latest.date,
      subscribersDelta: (lc.subscribers || 0) - (bc.subscribers || 0),
      viewsDelta: (lc.total_views || 0) - (bc.total_views || 0),
      topMovers: movers.slice(0, 10),
    };
  },
};

const CONSULTANT_SYSTEM = `You are a proactive YouTube growth consultant and AI music strategist.
You lead with data, interpret (don't just report), and prescribe ONE clear action + reason.
Never invent numbers. If data is missing, label as estimate. Reply in Bulgarian.
Use emojis at section breaks. Keep it direct and actionable.
Structure: 1) biggest finding, 2) outlier analysis, 3) demand vs positioning gap,
4) one clear prescription (action + reason), 5) next 3 videos with titles.
If 'growth' or 'nicheTrends' are present, use them in findings 1 and 3.`;

const Consultant = {
  _audit: null, // последният audit (за AI отчета)

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },
  _fmt(n) { return Number(n || 0).toLocaleString("bg-BG"); },
  _out(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; },

  keywords() {
    const saved = Storage.get(CONSULTANT_KEYWORDS_KEY);
    return Array.isArray(saved) && saved.length ? saved : ConsultantCore.DEFAULT_KEYWORDS;
  },

  async _defaultChannel() {
    const saved = Storage.get(CONSULTANT_CHANNEL_KEY);
    if (saved) return saved;
    try {
      const res = await fetchTimeout("config.json", {}, 5000);
      if (res.ok) { const c = await res.json(); return c.youtube_channel_id || c.CHANNEL_ID || ""; }
    } catch (e) { /* няма config.json — оставяме празно */ }
    return "";
  },

  async render() {
    const input = document.getElementById("consultantChannel");
    if (input && !input.value) input.value = await this._defaultChannel();
    const kws = document.getElementById("consultantKeywords");
    if (kws && !kws.value) kws.value = this.keywords().map(k => `${k.term}, ${k.volume}, ${k.competition}`).join("\n");
    this.showKeywords();
  },

  // ---------- YouTube API ----------
  async _yt(path, params) {
    const k = Keys.load();
    if (!k.ytApiKey) throw new Error("Липсва YouTube API ключ — виж Настройки → API Ключове.");
    const qs = new URLSearchParams({ ...params, key: k.ytApiKey });
    const res = await fetchTimeout(proxied(`https://www.googleapis.com/youtube/v3/${path}?${qs}`), {}, 20000);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`YouTube API ${res.status}: ${body.slice(0, 160)}`);
    }
    return res.json();
  },

  async _loadChannelVideos(ref, maxVideos = 200) {
    const parts = "snippet,statistics,contentDetails";
    const isId = /^UC[\w-]{22}$/.test(ref);
    const ch = await this._yt("channels", isId ? { part: parts, id: ref } : { part: parts, forHandle: ref.replace(/^@/, "") });
    if (!ch.items?.length) throw new Error(`Каналът ${ref} не е намерен.`);
    const channel = ch.items[0];
    const uploads = channel.contentDetails.relatedPlaylists.uploads;
    const ids = [];
    let pageToken = "";
    while (ids.length < maxVideos) {
      const page = await this._yt("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
      (page.items || []).forEach(i => ids.push(i.contentDetails.videoId));
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    const videos = [];
    const wanted = ids.slice(0, maxVideos);
    for (let i = 0; i < wanted.length; i += 50) {
      const r = await this._yt("videos", { part: "statistics,contentDetails,snippet", id: wanted.slice(i, i + 50).join(",") });
      videos.push(...(r.items || []));
    }
    return { channel, videos };
  },

  // ---------- Audit ----------
  async runAudit() {
    const ref = (document.getElementById("consultantChannel")?.value || "").trim();
    if (!ref) return toast("❌ Въведи @handle или Channel ID");
    Storage.set(CONSULTANT_CHANNEL_KEY, ref);
    this._out("consultantAuditOut", `<p class="muted">⏳ Тегля данни от YouTube...</p>`);
    try {
      const { channel, videos } = await this._loadChannelVideos(ref);
      const s = channel.statistics;
      const recent = ConsultantCore.recentVideos(videos, 30);
      const svl = ConsultantCore.shortsVsLong(recent);
      const out = ConsultantCore.findOutliers(videos);
      this._audit = {
        channel: { title: channel.snippet.title, subs: +s.subscriberCount || 0, views: +s.viewCount || 0, videos: +s.videoCount || 0 },
        videosAnalyzed: videos.length, videosLast30d: recent.length, shortsVsLong30d: svl, outliers: out,
      };
      const a = this._audit;
      const rows = out.outliers.map(o => `<tr><td>${this._esc(o.title.slice(0, 60))}${o.isShort ? " 📱" : ""}</td><td style="text-align:right">${this._fmt(o.views)}</td><td style="text-align:right">${o.multiple}×</td><td style="text-align:right">${o.shareOfTotal}%</td></tr>`).join("");
      this._out("consultantAuditOut", `
        <div class="card" style="margin-top:12px;">
          <strong>📊 ${this._esc(a.channel.title)}</strong>
          <p class="muted" style="margin-top:6px;">Абонати: <b>${this._fmt(a.channel.subs)}</b> · Общо гледания: <b>${this._fmt(a.channel.views)}</b> · Видеа: <b>${this._fmt(a.channel.videos)}</b> (анализирани ${a.videosAnalyzed})</p>
          <p class="muted" style="margin-top:6px;">📅 Последни 30 дни: <b>${a.videosLast30d}</b> видеа · 📱 Shorts: ${svl.shortsCount} (avg ${this._fmt(svl.shortsAvgViews)}) · 🎬 Long: ${svl.longCount} (avg ${this._fmt(svl.longAvgViews)})</p>
          <p class="muted" style="margin-top:6px;">🎯 Медиана: ${this._fmt(out.median)} гледания</p>
          ${rows ? `<div style="overflow-x:auto;margin-top:8px;"><table style="width:100%;font-size:12.5px;"><thead><tr><th style="text-align:left">🔥 Outliers (≥3× медиана)</th><th>Views</th><th>×</th><th>% от всичко</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted" style="margin-top:8px;">Няма видеа ≥ 3× медианата.</p>`}
        </div>`);
    } catch (e) {
      this._out("consultantAuditOut", `<p style="color:#e66;">❌ ${this._esc(e.message)}</p>`);
    }
  },

  // ---------- Заглавия ----------
  scoreTitles() {
    const titles = (document.getElementById("consultantTitles")?.value || "").split("\n").map(t => t.trim()).filter(Boolean);
    if (!titles.length) return toast("❌ Въведи поне едно заглавие (по едно на ред)");
    const res = ConsultantCore.scoreMany(titles, this.keywords());
    this._out("consultantTitlesOut", `<div style="overflow-x:auto;margin-top:10px;"><table style="width:100%;font-size:12.5px;"><thead><tr><th style="text-align:left">Заглавие</th><th>Score</th><th style="text-align:left">Оценка</th></tr></thead><tbody>${
      res.map(r => `<tr><td>${this._esc(r.title)}<div class="muted" style="font-size:11px;">kw ${r.breakdown.keyword} · дължина ${r.breakdown.length} · привлекателност ${r.breakdown.appeal} · конкретност ${r.breakdown.specificity}${r.matched.length ? " · съвпада: " + this._esc(r.matched.join(", ")) : ""}</div></td><td style="text-align:center"><b>${r.score}</b></td><td>${this._esc(r.verdict)}</td></tr>`).join("")
    }</tbody></table></div>`);
  },

  // ---------- Keywords ----------
  _live() { return Storage.get(CONSULTANT_LIVE_KEY) || {}; },

  _fresh(entry) { return entry && Date.now() - Date.parse(entry.at) < CONSULTANT_LIVE_TTL_MS; },

  showKeywords() {
    const live = this._live();
    const kws = this.keywords();
    const opps = ConsultantCore.findOpportunities(kws, 1000, live);
    const unrated = ConsultantCore.unrated(kws, 1000, live);
    const anyLive = opps.some(o => o.compSource === "live");
    const compLabel = anyLive ? "Конкуренция (жива)" : "Конкуренция (ръчна)";
    const rows = opps.map(o => `<tr><td>${this._esc(o.term)}</td><td style="text-align:right">${this._fmt(o.volume)}</td><td style="text-align:right">${o.competition}${o.liveVideos30d != null ? `<div class="muted" style="font-size:10.5px;">${this._fmt(o.liveVideos30d)} видеа/30д</div>` : ""}</td><td style="text-align:right"><b>${o.score}</b></td></tr>`).join("");
    const un = unrated.length ? `<p class="muted" style="margin-top:10px;">Без ръчно търсене (само жива конкуренция, по-малко видеа = по-свободна ниша):</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">${unrated.map(u => `<span class="badge">${this._esc(u.term)} · ${u.liveVideos30d != null ? this._fmt(u.liveVideos30d) + " видеа" : "не е измерено"}</span>`).join("")}</div>` : "";
    const stale = kws.filter(k => !this._fresh(live[k.term])).length;
    this._out("consultantKeywordsOut", `<div style="overflow-x:auto;"><table style="width:100%;font-size:12.5px;"><thead><tr><th style="text-align:left">Keyword</th><th>Търсене (ръчно)</th><th>${compLabel}</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table></div>${un}
      <p class="muted" style="margin-top:8px;font-size:11.5px;">${anyLive ? "Конкуренцията е индекс 1–100 по брой видеа последните 30 дни (лог. скала)." : "Все още се ползва ръчната конкуренция — натисни 'Обнови конкуренцията', за да се измери от YouTube."} ${stale ? `Остарели/неизмерени: ${stale}.` : "Всички са пресни (кеш 24ч)."}</p>`);
  },

  async refreshLive() {
    const kws = this.keywords();
    const live = this._live();
    const todo = kws.filter(k => !this._fresh(live[k.term])).slice(0, CONSULTANT_LIVE_MAX_PER_RUN);
    if (!todo.length) return toast("✅ Всичко е пресно (кеш 24ч)");
    const cost = todo.length * 100;
    if (!confirm(`Ще измеря ${todo.length} keywords ≈ ${cost} от ~10 000 дневни YouTube quota единици. Продължавам?`)) return;
    const after = new Date(Date.now() - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    let ok = 0;
    for (const k of todo) {
      try {
        const r = await this._yt("search", { part: "id", q: k.term, type: "video", publishedAfter: after, maxResults: 1 });
        live[k.term] = { count: r.pageInfo?.totalResults ?? 0, at: new Date().toISOString() };
        ok++;
      } catch (e) {
        toast("❌ " + e.message, 5000);
        break; // най-често квота/ключ — няма смисъл да продължаваме
      }
    }
    Storage.set(CONSULTANT_LIVE_KEY, live);
    this.showKeywords();
    if (ok) toast(`✅ Измерени: ${ok}${ok < kws.length ? " (останалите — при следващо натискане)" : ""}`);
  },

  async suggest() {
    const seed = (document.getElementById("consultantSeed")?.value || "").trim();
    if (!seed) return toast("❌ Въведи начална дума");
    this._out("consultantSuggestOut", `<p class="muted">⏳ Питам YouTube автодовършването...</p>`);
    try {
      const list = await keywordSuggest(seed);
      if (!list.length) return this._out("consultantSuggestOut", `<p class="muted">Няма предложения.</p>`);
      this._out("consultantSuggestOut", `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${
        list.map(t => `<button class="btn ghost" style="padding:4px 9px;" data-term="${this._esc(t)}" onclick="Consultant.addSuggestion(this.dataset.term)">➕ ${this._esc(t)}</button>`).join("")
      }</div><p class="muted" style="margin-top:6px;font-size:11.5px;">Това са реални търсения на хора, но без число. Добавените влизат с търсене 0 и се оценяват само по жива конкуренция.</p>`);
    } catch (e) {
      this._out("consultantSuggestOut", `<p style="color:#e66;">❌ ${this._esc(e.message)}</p>`);
    }
  },

  addSuggestion(term) {
    const list = this.keywords();
    if (list.some(k => k.term.toLowerCase() === term.toLowerCase())) return toast("Вече е в списъка");
    list.push({ term, volume: 0, competition: 50 });
    Storage.set(CONSULTANT_KEYWORDS_KEY, list);
    const ta = document.getElementById("consultantKeywords");
    if (ta) ta.value = list.map(k => `${k.term}, ${k.volume}, ${k.competition}`).join("\n");
    this.showKeywords();
    toast("➕ Добавено — натисни 'Обнови конкуренцията'");
  },

  saveKeywords() {
    const lines = (document.getElementById("consultantKeywords")?.value || "").split("\n").map(l => l.trim()).filter(Boolean);
    const list = [];
    for (const l of lines) {
      const [term, vol, comp] = l.split(",").map(x => x.trim());
      if (term) list.push({ term, volume: parseInt(vol, 10) || 0, competition: Number.isFinite(parseInt(comp, 10)) ? parseInt(comp, 10) : 50 });
    }
    if (!list.length) return toast("❌ Няма валидни редове (формат: дума, търсене, конкуренция)");
    Storage.set(CONSULTANT_KEYWORDS_KEY, list);
    this.showKeywords();
    toast("✅ Keywords запазени");
  },

  resetKeywords() {
    Storage.remove(CONSULTANT_KEYWORDS_KEY);
    const ta = document.getElementById("consultantKeywords");
    if (ta) ta.value = ConsultantCore.DEFAULT_KEYWORDS.map(k => `${k.term}, ${k.volume}, ${k.competition}`).join("\n");
    this.showKeywords();
    toast("↩️ Върнати са стойностите по подразбиране");
  },

  // ---------- AI отчет ----------
  async runReport() {
    if (!this._audit) await this.runAudit();
    if (!this._audit) return;
    this._out("consultantReportOut", `<p class="muted">⏳ AI анализира данните...</p>`);
    try {
      const bundle = {
        channel: this._audit.channel,
        videosAnalyzed: this._audit.videosAnalyzed,
        shortsVsLong30d: this._audit.shortsVsLong30d,
        outliers: this._audit.outliers,
        keywordOpportunities: ConsultantCore.findOpportunities(this.keywords(), 1000, this._live()).slice(0, 10),
      };
      if (typeof YouTubeDiscovery !== "undefined" && YouTubeDiscovery._fetchJson) {
        const [stats, trends] = await Promise.all([
          YouTubeDiscovery._fetchJson("stats-history.json", null),
          YouTubeDiscovery._fetchJson("trends-history.json", null),
        ]);
        const g = ConsultantCore.growth(stats);
        if (g) bundle.growth = g;
        const lastTrend = trends?.snapshots?.[trends.snapshots.length - 1];
        if (lastTrend?.niches) bundle.nicheTrends = lastTrend.niches.slice(0, 8);
      }
      const prompt = `${CONSULTANT_SYSTEM}\n\nНаправи стратегически анализ на този YouTube канал.\n\nДАННИ:\n${JSON.stringify(bundle, null, 2)}`;
      const text = await callAI(prompt, 2500);
      Storage.set("cdb_consultant_last_report_v1", { at: new Date().toISOString(), text });
      this._out("consultantReportOut", `<div class="card" style="margin-top:12px;white-space:pre-wrap;line-height:1.5;">${this._esc(text)}</div>
        <button class="btn ghost" style="margin-top:8px;" onclick="Consultant.copyReport()">📋 Копирай</button>`);
    } catch (e) {
      this._out("consultantReportOut", `<p style="color:#e66;">❌ ${this._esc(e.message)}</p>`);
    }
  },

  copyReport() {
    const r = Storage.get("cdb_consultant_last_report_v1");
    if (!r) return;
    navigator.clipboard?.writeText(r.text).then(() => toast("📋 Копирано"), () => toast("❌ Не мога да копирам"));
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ConsultantCore };
}
