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

   ЗАБЕЛЕЖКА за Spotify: официалният Client Credentials flow (Client ID +
   Secret от Настройки) е предпочитан, ако е наличен — по-стабилен, по-висок
   rate limit. Ако липсва, 2026-08-10: автоматично се пробва анонимен
   web-player token (без регистрация/ключове) — неофициален, по-крехък
   endpoint, но премахва твърдата зависимост от Spotify ключове. Ако и двата
   не сработят, анализът продължава само с YouTube данни (виж
   _computeNicheScore — тежестите се преразпределят, не показва фантомна
   нула). И двата Spotify пътя минават през proxied(), защото
   accounts.spotify.com/open.spotify.com нямат CORS за browser заявки от
   чужд домейн — изисква се Proxy URL в Настройки, иначе Spotify сигналът
   просто отсъства (YouTube частта работи независимо).
   ========================================================= */

const NICHE_TOOLKIT_SCORES_KEY = "cdb_niche_toolkit_scores_v1";

const NicheToolkit = {

  /* ---------- SPOTIFY: Client Credentials + search ---------- */
  _spotifyToken: null,
  _spotifyTokenExpiresAt: 0,

  async _getSpotifyToken() {
    if (this._spotifyToken && Date.now() < this._spotifyTokenExpiresAt) return this._spotifyToken;
    const k = Keys.load();
    if (k.spotifyClientId && k.spotifyClientSecret) {
      return this._getSpotifyTokenOfficial(k);
    }
    // Fallback: анонимен web-player token — без Client ID/Secret регистрация.
    // Това е неофициален, reverse-engineered endpoint (същия, който самата
    // open.spotify.com страница ползва за нелогнати посетители) — по-крехък
    // от официалния Client Credentials flow и Spotify може да го промени по
    // всяко време без предупреждение. Затова: официалният flow (ако има
    // ключове) винаги е предпочитан; това е само за да работи "из кутията"
    // без регистрация. При провал хвърляме грешка нагоре — извикващият код
    // (_searchSpotifyTracksByGenre) я хваща и просто пропуска Spotify сигнала.
    return this._getSpotifyTokenAnonymous();
  },

  async _getSpotifyTokenOfficial(k) {
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

  async _getSpotifyTokenAnonymous() {
    const url = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player";
    const res = await fetchTimeout(proxied(url), {}, 15000);
    if (!res.ok) throw new Error("Анонимен Spotify token — грешка " + res.status + " (възможно е Spotify да е спрял/сменил този endpoint; ако имаш Client ID/Secret, добави ги в Настройки за по-стабилен достъп)");
    const data = await res.json();
    if (!data.accessToken) throw new Error("Анонимен Spotify token — неочакван отговор (endpoint вероятно е сменен от Spotify)");
    this._spotifyToken = data.accessToken;
    // accessTokenExpirationTimestampMs е абсолютен ms timestamp, ако липсва
    // (различен формат на отговора) — резервно 55 мин., типичния Spotify TTL.
    this._spotifyTokenExpiresAt = data.accessTokenExpirationTimestampMs
      ? data.accessTokenExpirationTimestampMs - 60000
      : Date.now() + 55 * 60 * 1000;
    return this._spotifyToken;
  },

  async _searchSpotifyTracksByGenre(genre, limit = 20) {
    // Fix: преди всяка грешка тук (липсващи ключове, счупен анонимен token,
    // rate limit) гърмеше и спираше ЦЕЛИЯ анализ, включително YouTube частта,
    // която няма нищо общо със Spotify. Сега хващаме грешката тук и връщаме
    // празен резултат — analyzeNiche() решава как да продължи (YouTube-only,
    // с ясна бележка "Spotify: insufficient data" вместо мълчаливо 0).
    let token;
    try {
      token = await this._getSpotifyToken();
    } catch (e) {
      console.warn("[NicheToolkit] Spotify token недостъпен:", e.message);
      return { tracks: [], error: e.message };
    }
    try {
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(`genre:"${genre}"`)}&type=track&limit=${limit}`;
      const res = await fetchTimeout(proxied(url), { headers: { "Authorization": `Bearer ${token}` } }, 15000);
      if (!res.ok) throw new Error("Spotify search грешка: " + res.status + " " + (await res.text()));
      const data = await res.json();
      return {
        tracks: (data.tracks?.items || []).map(t => ({
          id: t.id, name: t.name, artist: t.artists?.[0]?.name,
          popularity: t.popularity, previewUrl: t.preview_url, releaseDate: t.album?.release_date
        }))
      };
    } catch (e) {
      console.warn("[NicheToolkit] Spotify search неуспешен:", e.message);
      return { tracks: [], error: e.message };
    }
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
      videoId: v.id, title: v.snippet?.title, channelTitle: v.snippet?.channelTitle, channelId: v.snippet?.channelId,
      publishedAt: v.snippet?.publishedAt,
      views: parseInt(v.statistics?.viewCount || "0", 10),
      likes: parseInt(v.statistics?.likeCount || "0", 10)
    }));
  },

  /* ---------- PROFIT NICHE SCORE ----------
     Fix: преди липсващ Spotify сигнал (без ключове/счупен token) тихо
     влизаше в сметката като avgPopularity=0 * 0.35 тегло — изкуствено
     понижаваше всеки score с до 35 точки, без потребителят да разбере
     защо. Сега: ако Spotify данни липсват, тежестта му (0.35) се
     преразпределя пропорционално към YouTube views (0.4) и competition
     (0.25) сигналите, вместо да наказва score-а с фантомна нула. */
  _computeNicheScore({ spotifyPopularities = [], youtubeViews = [], competitionSignal = 50, spotifyAvailable = true }) {
    const avg = (nums) => nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
    const avgPopularity = avg(spotifyPopularities);
    const avgViews = avg(youtubeViews);
    const viewsScore = Math.min(100, (Math.log10(avgViews + 1) / 7) * 100); // log10(10M)=7
    const competitionScore = 100 - competitionSignal;

    const BASE_WEIGHTS = { popularity: 0.35, views: 0.4, competition: 0.25 };
    let w = { ...BASE_WEIGHTS };
    if (!spotifyAvailable) {
      const remaining = w.views + w.competition; // 0.65
      w = { popularity: 0, views: w.views + w.popularity * (w.views / remaining), competition: w.competition + w.popularity * (w.competition / remaining) };
    }

    const raw = avgPopularity * w.popularity + viewsScore * w.views + competitionScore * w.competition;

    // Confidence: честна оценка колко от нужните данни реално имаме —
    // не измисляме стойност, само отбелязваме колко сме сигурни в нея.
    const signalsAvailable = (spotifyAvailable ? 1 : 0) + (youtubeViews.length > 0 ? 1 : 0);
    const confidence = signalsAvailable === 2 && youtubeViews.length >= 5 ? "HIGH"
                      : signalsAvailable >= 1 ? "MEDIUM" : "LOW";

    return {
      score: Math.round(Math.min(100, Math.max(0, raw))),
      confidence,
      spotifyAvailable,
      breakdown: {
        avgSpotifyPopularity: spotifyAvailable ? Math.round(avgPopularity) : null,
        avgYoutubeViews: Math.round(avgViews),
        viewsScore: Math.round(viewsScore),
        competitionScore: Math.round(competitionScore),
        weightsUsed: { popularity: Math.round(w.popularity * 100) / 100, views: Math.round(w.views * 100) / 100, competition: Math.round(w.competition * 100) / 100 }
      }
    };
  },

  async analyzeNiche() {
    const genre = document.getElementById("ntGenre")?.value.trim();
    const out = document.getElementById("ntAnalyzeOut");
    if (!genre) return toast("Въведи жанр/поджанр първо");
    out.innerHTML = `<p class="muted">📡 Тегля данни от Spotify + YouTube за "${genre}"...</p>`;

    try {
      // Fix: YouTube частта вече не зависи от Spotify — ако Spotify
      // (ключове/анонимен token) не сработи, _searchSpotifyTracksByGenre
      // връща { tracks: [], error } вместо да хвърли грешка, затова
      // Promise.all стига (нищо повече не може да гръмне оттук).
      const [spotifyResult, videos] = await Promise.all([
        this._searchSpotifyTracksByGenre(genre),
        this._searchYoutubeByGenre(`${genre} music`)
      ]);
      const tracks = spotifyResult.tracks;
      const spotifyAvailable = tracks.length > 0;
      const spotifyPopularities = tracks.map(t => t.popularity);
      const youtubeViews = videos.map(v => v.views);
      // Груб сигнал за конкуренция: колко резултати изобщо връща YouTube за темата
      // (същата евристика като оригиналния toolkit — виж бележката в неговия README).
      const competitionSignal = Math.min(100, videos.length * 6);
      const { score, confidence, breakdown } = this._computeNicheScore({ spotifyPopularities, youtubeViews, competitionSignal, spotifyAvailable });

      // Пазим последния breakdown в паметта (не localStorage — само за
      // текущата сесия), за да може Revenue Simulator-ът по-долу да
      // предложи авто-попълване на "текущи views/popularity" вместо
      // потребителят да гадае числата ръчно.
      // Пазим ПЪЛНИЯ резултат (не само средните), за да може разширеният
      // 5-под-индекс панел (NicheToolkit.analyzeNicheExtended, 2026-08-10)
      // да построи HHI/diversity Opportunity и по-богат Demand сигнал, без
      // да праща същите Spotify/YouTube заявки втори път.
      this._lastAnalysis = { genre, avgSpotifyPopularity: breakdown.avgSpotifyPopularity, avgYoutubeViews: breakdown.avgYoutubeViews, score, tracks, videos };

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

      const confBadge = confidence === "HIGH" ? '<span class="optional-tag" style="color:var(--green,#3fb950);">Confidence: HIGH</span>'
                       : confidence === "MEDIUM" ? '<span class="optional-tag" style="color:var(--amber,#d29922);">Confidence: MEDIUM</span>'
                       : '<span class="optional-tag" style="color:var(--red,#f85149);">Confidence: LOW</span>';

      // Fix: ако Spotify не е налично, показваме честна бележка защо (вместо
      // мълчаливо да отсъства реда) — вкл. текста на грешката, за да е ясно
      // дали е липсващ ключ, счупен анонимен token, или временен rate limit.
      const spotifyNote = spotifyAvailable
        ? ""
        : `<p class="muted" style="margin-top:8px;font-size:11.5px;color:var(--amber,#d29922);">⚠️ Spotify: insufficient data (${spotifyResult.error || "няма резултати"}) — score-ът е преизчислен само от YouTube сигнали (тегла: views ${Math.round(breakdown.weightsUsed.views * 100)}%, свободна ниша ${Math.round(breakdown.weightsUsed.competition * 100)}%). За по-стабилен Spotify достъп добави Client ID/Secret в Настройки.</p>`;

      out.innerHTML = `
        ${combinedHtml}
        <div class="card tight" style="margin-bottom:10px;">
          <strong style="font-size:22px;">${score}/100 — Profit Niche Score</strong>
          ${confBadge}
          <p class="muted" style="margin-top:6px;">Прозрачна евристика (не финансов съвет): Spotify популярност ${Math.round(breakdown.weightsUsed.popularity * 100)}% + YouTube трафик потенциал ${Math.round(breakdown.weightsUsed.views * 100)}% + свободна ниша ${Math.round(breakdown.weightsUsed.competition * 100)}%.</p>
          ${spotifyAvailable ? bar("Spotify популярност", breakdown.avgSpotifyPopularity, "var(--cyan)") : ""}
          ${bar("YouTube трафик потенциал", breakdown.viewsScore, "var(--p1)")}
          ${bar("Свободна ниша (по-малко = по-задръстено)", breakdown.competitionScore, "var(--green)")}
          <p class="muted" style="margin-top:8px;font-size:11.5px;">${spotifyAvailable ? `Средно Spotify popularity: ${breakdown.avgSpotifyPopularity}/100 · ` : ""}средно YouTube views: ${breakdown.avgYoutubeViews.toLocaleString("bg-BG")}</p>
          ${spotifyNote}
        </div>
        ${spotifyAvailable ? `<div class="card tight" style="margin-bottom:10px;">
          <strong>🎵 Топ Spotify тракове в нишата</strong>
          ${tracks.slice(0, 8).map(t => `<div style="font-size:12.5px;margin:5px 0;">🎧 <strong>${t.name}</strong> — ${t.artist || "?"} <span class="muted">(popularity ${t.popularity})</span></div>`).join("")}
        </div>` : ""}
        <div class="card tight">
          <strong>📺 Топ YouTube видеа в нишата</strong>
          ${videos.slice(0, 8).map(v => `<div style="font-size:12.5px;margin:5px 0;">▶️ ${v.title} <span class="muted">— ${v.views.toLocaleString("bg-BG")} views · ${v.channelTitle || "?"}</span></div>`).join("") || '<p class="muted">Няма резултати.</p>'}
        </div>`;
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  },

  /* ---------- РАЗШИРЕН PNS (2026-08-10) ----------
     Нов, допълнителен модел върху js/niche-scoring.js — 5 обясними
     под-индекса + безключови допълнителни сигнали (js/niche-data-sources.js).
     НАРОЧНО отделен от analyzeNiche() по-горе (не го заменя) — реюзва
     последния YouTube/Spotify резултат от паметта (this._lastAnalysis),
     за да не праща същите заявки втори път. */
  async analyzeNicheExtended() {
    const out = document.getElementById("ntExtendedOut");
    const a = this._lastAnalysis;
    if (!a) { out.innerHTML = ""; return toast("Първо пусни '🎯 Анализирай нишата' по-горе поне веднъж"); }
    out.innerHTML = `<p class="muted">📡 Тегля допълнителни сигнали (Deezer/MusicBrainz/YouTube RSS) за "${a.genre}"...</p>`;

    const feasibilityRating = parseInt(document.getElementById("ntFeasibility")?.value || "3", 10);

    // Допълнителни, безключови източници — всеки връща {available:false,
    // error} при провал, никога не хвърля грешка (виж niche-data-sources.js).
    const [deezer, musicbrainz] = await Promise.all([
      NicheDataSources.fetchDeezerArtists(a.genre, 15),
      NicheDataSources.fetchMusicBrainzArtists(a.genre, 8)
    ]);

    // YouTube RSS активност на топ канала от последния YouTube резултат —
    // допълнителна, показвана информация (freshness), не участва пряко в
    // score-а (RSS дава само последните ~15 видеа на 1 канал, недостатъчно
    // представително за цялостен Momentum сигнал за нишата).
    const topChannelId = a.videos?.[0]?.channelId;
    const ytActivity = topChannelId ? await NicheDataSources.fetchYoutubeChannelActivity(topChannelId) : { available: false, error: "няма наличен канал от последния анализ" };

    /* ---------- DEMAND ---------- */
    const demand = NicheScoring.computeDemand({
      youtubeAvgViews: a.avgYoutubeViews || null,
      spotifyAvgPopularity: a.avgSpotifyPopularity ?? null,
      deezerAvgFans: deezer.available ? Math.round(deezer.artists.reduce((s, x) => s + x.fans, 0) / deezer.artists.length) : null
    });

    /* ---------- OPPORTUNITY (HHI от Deezer fans, fallback = YouTube channel diversity) ---------- */
    const youtubeChannelDiversity = a.videos?.length
      ? { unique: new Set(a.videos.map(v => v.channelId || v.channelTitle)).size, total: a.videos.length }
      : null;
    const opportunity = NicheScoring.computeOpportunity({
      topShares: deezer.available && deezer.artists.length >= 2 ? deezer.artists.map(x => x.fans) : null,
      youtubeChannelDiversity
    });

    /* ---------- MOMENTUM (от data/trends-history.json, ако нишата съвпада с проследяваните 15) ----------
       Fix спрямо track_trends.py: тук четем НЯКОЛКО snapshot-а (не само
       последния) и подаваме на classifyMomentum() за acceleration, вместо
       грубо "расте/пада" от 1 число. */
    let momentum = { value: null, trend: "UNKNOWN", confidence: "LOW" };
    try {
      const histRes = await fetchTimeout("data/trends-history.json", {}, 10000);
      if (histRes.ok) {
        const histData = await histRes.json();
        const snapshots = (histData.snapshots || []).slice(-8); // последните до 8 snapshot-а
        const points = [];
        for (const snap of snapshots) {
          const match = (snap.niches || []).find(n =>
            n.niche.toLowerCase().includes(a.genre.toLowerCase()) || a.genre.toLowerCase().includes(n.niche.toLowerCase()));
          if (match) points.push({ date: snap.date, value: match.score });
        }
        if (points.length >= 2) {
          const cls = NicheScoring.classifyMomentum(points);
          momentum = { value: NicheScoring.momentumToScore(cls), trend: cls.trend, confidence: cls.confidence, growthPct: cls.growthPct };
        }
      }
    } catch (e) { /* некритично — trends-history.json може да липсва в локална разработка */ }

    /* ---------- MONETIZATION (реюз на Revenue.RATES) ---------- */
    const estStreams = a.avgSpotifyPopularity != null ? Math.round(a.avgSpotifyPopularity * 300) : 0;
    const monetization = NicheScoring.computeMonetization({ avgViews: a.avgYoutubeViews, avgStreams: estStreams, rates: this.Revenue.RATES });

    /* ---------- FEASIBILITY (ръчна, от слайдера) ---------- */
    const feasibility = NicheScoring.computeFeasibility(feasibilityRating);

    const pns = NicheScoring.computePNS({ demand, momentum: { value: momentum.value }, opportunity, monetization, feasibility });
    const bucket = NicheScoring.opportunityBucket(pns.score);
    const rec = NicheScoring.recommendation(pns.score, pns.confidence);

    const bar = (label, val) => val == null ? `<div style="font-size:12px;margin:4px 0;color:var(--muted-2);">${label}: <em>insufficient data</em></div>` : `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px;">
        <div style="width:150px;flex-shrink:0;">${label}</div>
        <div style="flex:1;background:var(--panel-2);border-radius:5px;height:12px;overflow:hidden;"><div style="width:${Math.max(4, Math.min(100, val))}%;height:100%;background:var(--p1);"></div></div>
        <div style="width:36px;text-align:right;flex-shrink:0;">${Math.round(val)}</div>
      </div>`;

    const recColor = { ATTACK: "var(--green)", TEST: "var(--cyan)", WATCH: "var(--amber,#d29922)", AVOID: "var(--red,#f85149)" }[rec] || "var(--muted-2)";
    const confColor = { HIGH: "var(--green)", MEDIUM: "var(--amber,#d29922)", LOW: "var(--red,#f85149)" }[pns.confidence] || "var(--muted-2)";

    out.innerHTML = `
      <div class="card tight" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
          <strong style="font-size:22px;">${pns.score ?? "—"}/100 — Разширен Profit Niche Score</strong>
          <span style="font-weight:700;color:${recColor};">${rec}</span>
        </div>
        <p class="muted" style="margin-top:4px;">Opportunity: <strong>${bucket}</strong> · Confidence: <strong style="color:${confColor};">${pns.confidence}</strong> · Data coverage: <strong>${pns.dataCoveragePct}%</strong></p>
        ${bar("Demand", demand.value)}
        ${bar("Momentum" + (momentum.trend !== "UNKNOWN" ? ` (${momentum.trend})` : ""), momentum.value)}
        ${bar("Opportunity" + (opportunity.method === "hhi" ? " (HHI)" : opportunity.method === "youtube-diversity-fallback" ? " (YT diversity)" : ""), opportunity.value)}
        ${bar("Monetization", monetization.value)}
        ${bar("Feasibility (твоята оценка)", feasibility.value)}
        ${pns.missingSignals?.length ? `<p class="muted" style="margin-top:8px;font-size:11.5px;">⚠️ insufficient data: ${pns.missingSignals.join(", ")} — тегло преразпределено към наличните сигнали (виж AUDIT_PROGRESS.md за логиката).</p>` : ""}
      </div>
      <div class="card tight">
        <strong>📎 Допълнителни източници (само информативно)</strong>
        <div style="font-size:12.5px;margin-top:8px;line-height:1.7;">
          <div>🎧 Deezer: ${deezer.available ? `${deezer.artists.length} изпълнителя, средно ${Math.round(deezer.artists.reduce((s, x) => s + x.fans, 0) / deezer.artists.length).toLocaleString("bg-BG")} фена` : `<span class="muted">недостъпно (${deezer.error})</span>`}</div>
          <div>🎼 MusicBrainz: ${musicbrainz.available ? `${musicbrainz.artists.length} съвпадения · тагове: ${[...new Set(musicbrainz.artists.flatMap(x => x.tags))].slice(0, 6).join(", ") || "—"}` : `<span class="muted">недостъпно (${musicbrainz.error})</span>`}</div>
          <div>📺 YouTube RSS (топ канал): ${ytActivity.available ? `${ytActivity.videoCount} скорошни видеа, последно преди ${ytActivity.daysSinceLastUpload} дни` : `<span class="muted">недостъпно (${ytActivity.error})</span>`}</div>
        </div>
      </div>`;
  },
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
