/* =========================================================
   NICHE TOOLKIT — портнато от отделния "music-niche-toolkit" Node/Express
   проект (сървърни routes/services) в чист браузърен JS, за да пасне на
   архитектурата на този сайт (статичен, без сървър, всичко директно от
   браузъра — виж README "Известни ограничения").

   Зависи от: js/network.js (fetchTimeout, proxied), js/ui/toast.js
   (toast), app.js (Keys, callAI, extractJson) — зареден СЛЕД app.js в
   index.html, защото реално ги ползва при извикване, не при зареждане.

   Съдържа 3 самостоятелни части (виж README на оригиналния toolkit):
     1. NicheToolkit.analyzeNiche()   — Spotify+YouTube "Profit Niche Score"
     2. NicheToolkit.generateAudioPrompt() / generateLyricsStructure()
        — AI промптове за Suno/Udio + структура на текст (през
        съществуващия Claude/Gemini pipeline на сайта, не отделен
        OpenAI wrapper — за консистентност с останалото приложение)
     3. NicheToolkit.Playbook.*        — Release Playbook + CSV export

   ЗАБЕЛЕЖКА за Spotify ключовете: Client Credentials flow изисква
   CLIENT_SECRET. За разлика от оригиналния toolkit (пазен в сървърен
   .env), тук стои в localStorage на твоя браузър — същия модел на
   доверие като Claude/Gemini/GitHub ключовете ти вече използват
   (личен инстанс, само твой браузър). Spotify token endpoint-ът няма
   CORS за browser заявки, затова тази функция ИЗИСКВА Proxy URL в
   Настройки (същото ограничение като keywordSuggest() в js/youtube.js).
   ========================================================= */

const NICHE_TOOLKIT_SCORES_KEY = "cdb_niche_toolkit_scores_v1";

const NicheToolkit = {

  /* ---------- SPOTIFY: Client Credentials + search ---------- */
  _spotifyToken: null,
  _spotifyTokenExpiresAt: 0,

  async _getSpotifyToken() {
    if (this._spotifyToken && Date.now() < this._spotifyTokenExpiresAt) return this._spotifyToken;
    const k = Keys.load();
    if (!k.spotifyClientId || !k.spotifyClientSecret) {
      throw new Error("Липсват Spotify Client ID / Client Secret (виж Настройки → API Ключове)");
    }
    if (!k.proxyUrl) {
      throw new Error("Spotify token endpoint-ът няма CORS за браузър заявки — изисква се Proxy URL в Настройки");
    }
    const basic = btoa(`${k.spotifyClientId}:${k.spotifyClientSecret}`);
    const res = await fetchTimeout(proxied("https://accounts.spotify.com/api/token"), {
      method: "POST",
      headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    }, 15000);
    if (!res.ok) throw new Error("Spotify token грешка: " + res.status + " " + (await res.text()));
    const data = await res.json();
    this._spotifyToken = data.access_token;
    this._spotifyTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this._spotifyToken;
  },

  async _searchSpotifyTracksByGenre(genre, limit = 20) {
    const token = await this._getSpotifyToken();
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(`genre:"${genre}"`)}&type=track&limit=${limit}`;
    const res = await fetchTimeout(proxied(url), { headers: { "Authorization": `Bearer ${token}` } }, 15000);
    if (!res.ok) throw new Error("Spotify search грешка: " + res.status + " " + (await res.text()));
    const data = await res.json();
    return (data.tracks?.items || []).map(t => ({
      id: t.id, name: t.name, artist: t.artists?.[0]?.name,
      popularity: t.popularity, previewUrl: t.preview_url, releaseDate: t.album?.release_date
    }));
  },

  /* ---------- YOUTUBE: проста версия (без velocity/времеви прозорец) ----------
     НАРОЧНО отделна от fetchRecentTrendingVideos() в js/youtube.js — тази
     версия пресъздава точно оригиналната формула на toolkit-а (обикновени
     топ резултати по релевантност + брой резултати като груб конкуренция
     сигнал), не velocity-базирания подход, който ползва ViralLab. */
  async _searchYoutubeByGenre(query, maxResults = 15) {
    const k = Keys.load();
    if (!k.ytApiKey) throw new Error("Липсва YouTube Data API Key (виж Настройки)");
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${k.ytApiKey}`;
    const sRes = await fetchTimeout(proxied(searchUrl), {}, 15000);
    if (!sRes.ok) throw new Error("YouTube search грешка: " + (await sRes.text()));
    const sData = await sRes.json();
    const ids = (sData.items || []).map(i => i.id.videoId).filter(Boolean);
    if (!ids.length) return [];
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids.join(",")}&key=${k.ytApiKey}`;
    const stRes = await fetchTimeout(proxied(statsUrl), {}, 15000);
    if (!stRes.ok) throw new Error("YouTube videos.list грешка: " + (await stRes.text()));
    const stData = await stRes.json();
    return (stData.items || []).map(v => ({
      videoId: v.id, title: v.snippet?.title, channelTitle: v.snippet?.channelTitle,
      publishedAt: v.snippet?.publishedAt,
      views: parseInt(v.statistics?.viewCount || "0", 10),
      likes: parseInt(v.statistics?.likeCount || "0", 10)
    }));
  },

  /* ---------- PROFIT NICHE SCORE (портната формула, 1:1 със сървърната) ---------- */
  _computeNicheScore({ spotifyPopularities = [], youtubeViews = [], competitionSignal = 50 }) {
    const avg = (nums) => nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
    const avgPopularity = avg(spotifyPopularities);
    const avgViews = avg(youtubeViews);
    const viewsScore = Math.min(100, (Math.log10(avgViews + 1) / 7) * 100); // log10(10M)=7
    const competitionScore = 100 - competitionSignal;
    const raw = avgPopularity * 0.35 + viewsScore * 0.4 + competitionScore * 0.25;
    return {
      score: Math.round(Math.min(100, Math.max(0, raw))),
      breakdown: {
        avgSpotifyPopularity: Math.round(avgPopularity),
        avgYoutubeViews: Math.round(avgViews),
        viewsScore: Math.round(viewsScore),
        competitionScore: Math.round(competitionScore)
      }
    };
  },

  async analyzeNiche() {
    const genre = document.getElementById("ntGenre")?.value.trim();
    const out = document.getElementById("ntAnalyzeOut");
    if (!genre) return toast("Въведи жанр/поджанр първо");
    out.innerHTML = `<p class="muted">📡 Тегля данни от Spotify + YouTube за "${genre}"...</p>`;

    try {
      const [tracks, videos] = await Promise.all([
        this._searchSpotifyTracksByGenre(genre),
        this._searchYoutubeByGenre(`${genre} music`)
      ]);
      const spotifyPopularities = tracks.map(t => t.popularity);
      const youtubeViews = videos.map(v => v.views);
      // Груб сигнал за конкуренция: колко резултати изобщо връща YouTube за темата
      // (същата евристика като оригиналния toolkit — виж бележката в неговия README).
      const competitionSignal = Math.min(100, videos.length * 6);
      const { score, breakdown } = this._computeNicheScore({ spotifyPopularities, youtubeViews, competitionSignal });

      // Пазим последния breakdown в паметта (не localStorage — само за
      // текущата сесия), за да може Revenue Simulator-ът по-долу да
      // предложи авто-попълване на "текущи views/popularity" вместо
      // потребителят да гадае числата ръчно.
      this._lastAnalysis = { genre, avgSpotifyPopularity: breakdown.avgSpotifyPopularity, avgYoutubeViews: breakdown.avgYoutubeViews, score };

      // Пазим последния Spotify-базиран score по жанр, за да може Стъпка 1
      // (чисто YouTube+AI сигнал) да го покаже като допълнителен, различен
      // поглед до собствения си резултат за същата ниша — виж combined блока
      // по-долу и Step1._renderNicheResults() в app.js.
      try {
        const scores = Storage.get(NICHE_TOOLKIT_SCORES_KEY) || {};
        scores[genre.toLowerCase()] = { score, ts: Date.now() };
        Storage.set(NICHE_TOOLKIT_SCORES_KEY, scores);
      } catch (e) { /* некритично — просто не се кешира */ }

      // Ако текущо избраната ниша от Стъпка 1 съвпада (грубо, по подниз) с
      // въведения тук жанр, показваме двата сигнала един до друг с кратък
      // извод дали се съгласуват — вместо потребителят сам да ги сравнява.
      const p = AppState?.data?.project;
      let combinedHtml = "";
      if (p?.chosenNiche && p?.nicheScore != null) {
        const a = p.chosenNiche.toLowerCase(), b = genre.toLowerCase();
        if (a.includes(b) || b.includes(a)) {
          const diff = Math.abs(p.nicheScore - score);
          const verdict = diff <= 15
            ? "✅ Двата сигнала се съгласуват — по-сигурен избор."
            : diff <= 30
              ? "🟡 Частично разминаване — провери breakdown-а по-долу преди да продължиш."
              : "⚠️ Голямо разминаване между сигналите — YouTube+AI и Spotify+YouTube не са единодушни за тази ниша.";
          combinedHtml = `<div class="card tight" style="margin-bottom:10px;border-color:var(--cyan);">
            <strong>🔗 Комбиниран поглед за "${p.chosenNiche}"</strong>
            <div style="display:flex;gap:18px;margin-top:8px;flex-wrap:wrap;">
              <div><span class="muted" style="font-size:11px;">Стъпка 1 (YouTube+AI)</span><br><strong style="font-size:18px;">${p.nicheScore}/100</strong></div>
              <div><span class="muted" style="font-size:11px;">Niche Toolkit (Spotify+YouTube)</span><br><strong style="font-size:18px;">${score}/100</strong></div>
            </div>
            <p class="muted" style="margin-top:8px;">${verdict}</p>
          </div>`;
        }
      }

      const bar = (label, val, color) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px;">
          <div style="width:170px;flex-shrink:0;">${label}</div>
          <div style="flex:1;background:var(--panel-2);border-radius:5px;height:12px;overflow:hidden;">
            <div style="width:${Math.max(4, Math.min(100, val))}%;height:100%;background:${color};"></div>
          </div>
          <div style="width:40px;text-align:right;flex-shrink:0;">${Math.round(val)}</div>
        </div>`;

      out.innerHTML = `
        ${combinedHtml}
        <div class="card tight" style="margin-bottom:10px;">
          <strong style="font-size:22px;">${score}/100 — Profit Niche Score</strong>
          <p class="muted" style="margin-top:6px;">Прозрачна евристика (не финансов съвет): Spotify популярност 35% + YouTube трафик потенциал 40% + свободна ниша 25%.</p>
          ${bar("Spotify популярност", breakdown.avgSpotifyPopularity, "var(--cyan)")}
          ${bar("YouTube трафик потенциал", breakdown.viewsScore, "var(--p1)")}
          ${bar("Свободна ниша (по-малко = по-задръстено)", breakdown.competitionScore, "var(--green)")}
          <p class="muted" style="margin-top:8px;font-size:11.5px;">Средно Spotify popularity: ${breakdown.avgSpotifyPopularity}/100 · средно YouTube views: ${breakdown.avgYoutubeViews.toLocaleString("bg-BG")}</p>
        </div>
        <div class="card tight" style="margin-bottom:10px;">
          <strong>🎵 Топ Spotify тракове в нишата</strong>
          ${tracks.slice(0, 8).map(t => `<div style="font-size:12.5px;margin:5px 0;">🎧 <strong>${t.name}</strong> — ${t.artist || "?"} <span class="muted">(popularity ${t.popularity})</span></div>`).join("") || '<p class="muted">Няма резултати.</p>'}
        </div>
        <div class="card tight">
          <strong>📺 Топ YouTube видеа в нишата</strong>
          ${videos.slice(0, 8).map(v => `<div style="font-size:12.5px;margin:5px 0;">▶️ ${v.title} <span class="muted">— ${v.views.toLocaleString("bg-BG")} views · ${v.channelTitle || "?"}</span></div>`).join("") || '<p class="muted">Няма резултати.</p>'}
        </div>`;
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  },

  /* ---------- AI: промпт за Suno/Udio ---------- */
  async generateAudioPrompt() {
    const subgenre = document.getElementById("ntSubgenre")?.value.trim();
    const mood = document.getElementById("ntMood")?.value.trim();
    const bpm = document.getElementById("ntBpm")?.value.trim();
    const instruments = document.getElementById("ntInstruments")?.value.trim();
    const out = document.getElementById("ntPromptOut");
    if (!subgenre) return toast("Въведи поджанр първо");
    out.textContent = "⏳ Генерирам...";

    const prompt = [
      "Ти си продуцентски асистент, специализиран в писане на кратки, точни промптове за AI аудио генератори (тип Suno/Udio). Върни САМО готовия промпт текст — стил, BPM диапазон, ключови инструменти и настроение — без обяснения около него, без markdown.",
      `Поджанр: ${subgenre}`,
      mood ? `Настроение: ${mood}` : null,
      bpm ? `Целеви BPM: ${bpm}` : null,
      instruments ? `Предпочитани инструменти: ${instruments}` : null,
      "Генерирай един готов промпт (макс 60 думи)."
    ].filter(Boolean).join("\n");

    try {
      const text = await callAI(prompt, 300);
      out.textContent = text.trim();
    } catch (e) {
      out.textContent = "❌ " + e.message;
    }
  },

  /* ---------- AI: структура на текст (verse/chorus/bridge/vocabulary) ---------- */
  async generateLyricsStructure() {
    const subgenre = document.getElementById("ntLyricsSubgenre")?.value.trim();
    const theme = document.getElementById("ntLyricsTheme")?.value.trim();
    const out = document.getElementById("ntLyricsOut");
    if (!subgenre) return toast("Въведи поджанр първо");
    out.innerHTML = `<p class="muted">⏳ Генерирам...</p>`;

    const prompt = `Ти си текстописец. Генерираш структура на песен (стих/припев/мост) и специфичен вокален речник за дадена музикална ниша. Върни отговора СТРОГО като валиден JSON обект с полета: {"verse": "...", "chorus": "...", "bridge": "...", "vocabulary": ["..."]}. Без markdown кодови блокове, само чист JSON.
Поджанр: ${subgenre}
Тема: ${theme || "по твой избор, съобразена с нишата"}
Генерирай структура на песен.`;

    try {
      const raw = await callAI(prompt, 900);
      let parsed;
      try { parsed = extractJson(raw); } catch (e) { parsed = { raw }; }
      if (parsed.raw) {
        out.innerHTML = `<p class="muted">Моделът не върна строг JSON, суров отговор:</p><pre style="white-space:pre-wrap;font-size:12px;">${parsed.raw}</pre>`;
      } else {
        out.innerHTML = `
          <div style="font-size:13px;line-height:1.6;">
            <strong>Verse</strong><p style="white-space:pre-wrap;">${parsed.verse || "—"}</p>
            <strong>Chorus</strong><p style="white-space:pre-wrap;">${parsed.chorus || "—"}</p>
            <strong>Bridge</strong><p style="white-space:pre-wrap;">${parsed.bridge || "—"}</p>
            <strong>Речник на нишата</strong><p>${(parsed.vocabulary || []).join(", ") || "—"}</p>
          </div>`;
      }
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  },

  /* ---------- RELEASE PLAYBOOK + CSV export ---------- */
  Playbook: {
    rows: [{ title: "", tags: "", description: "", genre: "" }],

    addRow() {
      this.rows.push({ title: "", tags: "", description: "", genre: "" });
      this.renderRows();
    },
    removeRow(i) {
      this.rows.splice(i, 1);
      if (!this.rows.length) this.rows.push({ title: "", tags: "", description: "", genre: "" });
      this.renderRows();
    },
    updateRow(i, field, value) {
      this.rows[i][field] = value;
    },

    renderRows() {
      const el = document.getElementById("ntPlaybookRows");
      if (!el) return;
      el.innerHTML = this.rows.map((r, i) => `
        <div class="row" style="margin-top:8px;align-items:flex-start;">
          <input type="text" placeholder="Заглавие" value="${r.title.replace(/"/g, "&quot;")}" style="flex:2;" onchange="NicheToolkit.Playbook.updateRow(${i},'title',this.value)">
          <input type="text" placeholder="Жанр" value="${r.genre.replace(/"/g, "&quot;")}" style="flex:1;" onchange="NicheToolkit.Playbook.updateRow(${i},'genre',this.value)">
          <input type="text" placeholder="Тагове (сепарирани със запетая)" value="${r.tags.replace(/"/g, "&quot;")}" style="flex:2;" onchange="NicheToolkit.Playbook.updateRow(${i},'tags',this.value)">
          <button class="btn ghost sm" onclick="NicheToolkit.Playbook.removeRow(${i})">🗑️</button>
        </div>`).join("");
    },

    _addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; },

    build() {
      const startDate = document.getElementById("ntPlaybookStart")?.value || new Date().toISOString().slice(0, 10);
      const cadenceDays = parseInt(document.getElementById("ntPlaybookCadence")?.value || "14", 10);
      const tracks = this.rows.filter(r => r.title.trim());
      const out = document.getElementById("ntPlaybookOut");
      if (!tracks.length) { toast("Добави поне едно заглавие в списъка"); return; }

      const start = new Date(startDate);
      this._schedule = tracks.map((track, i) => {
        const releaseDate = this._addDays(start, i * cadenceDays);
        const tags = (track.tags || "").split(",").map(t => t.trim()).filter(Boolean);
        return {
          order: i + 1,
          title: track.title,
          releaseDate: releaseDate.toISOString().slice(0, 10),
          tags,
          description: track.description || `${track.title} — сингъл, част ${i + 1} от предстоящ проект.`,
          genre: track.genre || ""
        };
      });

      out.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px;">
          <thead><tr style="text-align:left;border-bottom:1px solid var(--border);">
            <th style="padding:6px 4px;">#</th><th style="padding:6px 4px;">Заглавие</th>
            <th style="padding:6px 4px;">Дата на пускане</th><th style="padding:6px 4px;">Тагове</th>
          </tr></thead>
          <tbody>${this._schedule.map(s => `<tr style="border-bottom:1px solid var(--border-soft);">
            <td style="padding:6px 4px;">${s.order}</td>
            <td style="padding:6px 4px;">${s.title}</td>
            <td style="padding:6px 4px;">${s.releaseDate}</td>
            <td style="padding:6px 4px;">${s.tags.join(", ")}</td>
          </tr>`).join("")}</tbody>
        </table>
        <button class="btn ghost" style="margin-top:10px;" onclick="NicheToolkit.Playbook.downloadCsv()">⬇️ Свали CSV</button>`;
    },

    downloadCsv() {
      if (!this._schedule || !this._schedule.length) return toast("Първо построй графика по-горе");
      const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const header = "order,title,releaseDate,tags,description\n";
      const rows = this._schedule.map(s =>
        [s.order, esc(s.title), s.releaseDate, esc(s.tags.join("; ")), esc(s.description)].join(",")
      ).join("\n");
      const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "release-playbook.csv";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast("📥 CSV свален");
    }
  },

  /* ---------- REVENUE & STREAM PROJECTION SIMULATOR ----------
     Изцяло клиентска аритметика (без AI/API извиквания — не пести
     Gemini/Claude квота). Прозрачна евристика с публично известни
     ориентировъчни RPM диапазони за независими артисти (не финансов
     съвет, не гарантирани стойности — реалните ставки варират по
     страна/дистрибутор/период и не са публично фиксирани от Spotify/
     YouTube/TikTok). Целта е груба ориентация "струва ли си нишата",
     не точна финансова прогноза. */
  Revenue: {
    // Ориентировъчни диапазони — $ на 1 стрийм/view (консервативно/оптимистично).
    // Източник: широко цитирани публични оценки за независими артисти (без
    // major label дял) — виж README за бележка и линкове.
    RATES: {
      spotify:  { lo: 0.003, hi: 0.005, unit: "стрийм" },
      youtube:  { lo: 0.0005, hi: 0.002, unit: "view (monetized)" },
      tiktok:   { lo: 0.00002, hi: 0.00004, unit: "view (Creator Fund)" },
    },

    // Предлага авто-попълване от последния "🎯 Анализирай нишата" резултат
    // в същата сесия (avgYoutubeViews директно; Spotify populatity → груба
    // месечна стрийм оценка чрез евристика popularity*multiplier).
    prefillFromLastAnalysis() {
      const a = NicheToolkit._lastAnalysis;
      if (!a) return toast("Първо пусни '🎯 Анализирай нишата' по-горе поне веднъж в тази сесия");
      // Груба евристика: Spotify popularity (0-100) → примерни месечни стрийми
      // за нов independent single в тази ниша (НЕ официална Spotify формула —
      // Spotify не публикува такава връзка; произволен, но прозрачен множител).
      document.getElementById("revStreamsSpotify").value = Math.round(a.avgSpotifyPopularity * 300);
      document.getElementById("revViewsYoutube").value = Math.round(a.avgYoutubeViews * 0.05);
      toast(`Попълнено от последния анализ на "${a.genre}"`);
    },

    calculate() {
      const streams = Number(document.getElementById("revStreamsSpotify").value) || 0;
      const views = Number(document.getElementById("revViewsYoutube").value) || 0;
      const tiktokViews = Number(document.getElementById("revViewsTiktok").value) || 0;
      const out = document.getElementById("revOut");

      const row = (label, count, rate, unit) => {
        const lo = count * rate.lo, hi = count * rate.hi;
        return { label, lo, hi, line: `<div style="display:flex;justify-content:space-between;font-size:13px;margin:5px 0;">
          <span>${label} <span class="muted">(${count.toLocaleString("bg-BG")} ${unit})</span></span>
          <strong>$${lo.toFixed(2)} – $${hi.toFixed(2)}</strong></div>` };
      };

      const rSpotify = row("🎵 Spotify", streams, this.RATES.spotify, "стрийма/мес.");
      const rYoutube = row("▶️ YouTube (monetized)", views, this.RATES.youtube, "views/мес.");
      const rTiktok = row("🎬 TikTok Creator Fund", tiktokViews, this.RATES.tiktok, "views/мес.");
      const totalLo = rSpotify.lo + rYoutube.lo + rTiktok.lo;
      const totalHi = rSpotify.hi + rYoutube.hi + rTiktok.hi;

      out.innerHTML = `
        <div class="card tight" style="margin-top:10px;">
          <strong>💰 Прогнозен месечен приход (консервативно – оптимистично)</strong>
          ${rSpotify.line}${rYoutube.line}${rTiktok.line}
          <hr style="margin:8px 0;">
          <div style="display:flex;justify-content:space-between;font-size:15px;">
            <strong>Общо / месец</strong><strong>$${totalLo.toFixed(2)} – $${totalHi.toFixed(2)}</strong>
          </div>
          <p class="muted" style="margin-top:10px;font-size:11.5px;">⚠️ Груба ориентировъчна оценка с публично известни диапазони за независими артисти — НЕ финансов съвет, НЕ гаранция. Реалните ставки варират по страна, период и дистрибутор и не се публикуват официално от платформите.</p>
        </div>`;
    }
  }
};
