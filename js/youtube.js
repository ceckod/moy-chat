/* =========================================================
   YOUTUBE — извадено от app.js (архитектурен рефакторинг, точка 4:
   youtube/). Съдържа всичко, което говори директно с YouTube Data API
   (+ неофициалния autocomplete suggest endpoint): времево-ограничено
   trending търсене (velocity-базирано), жанрово заземяване за Viral Lab,
   VidIQ-стил outlier сканиране, и keyword suggestions.

   Зависи от: js/network.js (fetchTimeout, proxied) — зареден преди този
   файл в index.html. Зависи и от Keys — дефиниран в app.js, но реално се
   ползва само ВЪТРЕ във функциите по-долу (при действително извикване
   по-късно, след като всички <script> тагове вече са заредени), затова
   редът в HTML не чупи нищо дори app.js да се зареди след този файл.

   Публичен интерфейс, ползван от останалата част на приложението:
     - fetchRecentTrendingVideos(query, opts)
     - youtubeTopTitles(query, max)
     - youtubeOutlierScan(query)
     - keywordSuggest(query)
   ========================================================= */

/* =========================================================
   YOUTUBE TRENDING POOL (споделена, времево-ограничена основа)
   ---------------------------------------------------------
   ВАЖНО — тук преди имаше бъг: старите youtubeTopTitles() и
   youtubeOutlierScan() търсеха с order=viewCount БЕЗ никакъв
   времеви филтър, което значи "най-гледаните видеа за цялото
   съществуване на YouTube" по темата — не това, което реално
   трендва СЕГА. Резултатът: стари вирусни хитове изглеждаха
   като "актуален тренд" и това пряко влизаше в контекста за
   генериране на нови песни (ViralLab genreGrounding) — грешен
   сигнал → грешни песни.

   Този helper:
   1. Търси само видеа, публикувани в скорошен прозорец от време
      (publishedAfter), НЕ цялата история на YouTube.
   2. Ако прозорецът е твърде тесен за дадена ниша (малко скорошни
      видеа), прогресивно го разширява (30 → 60 → 120 → 180 дни) —
      НИКОГА не пада обратно на "без филтър", защото точно това
      беше бъгът. Ако дори 180 дни не дадат достатъчно данни,
      връща insufficientData=true, за да може UI/промптът честно
      да каже "няма достатъчно скорошни данни", вместо тихо да
      подаде подвеждаща информация.
   3. Смята view VELOCITY (гледания / дни от публикуването) — това
      е истинският "trending сега" сигнал: видео на 3 дни с 50k
      views трендва много по-силно от видео на 2 години с 500k.
      Сортирането по velocity, не по абсолютни views, е това, което
      прави разликата между "стар хит" и "реален тренд днес".
   ========================================================= */
async function fetchRecentTrendingVideos(query, opts = {}) {
  const k = Keys.load();
  const maxResults = opts.maxResults || 25;
  const minResults = opts.minResults || 6;
  if (!k.ytApiKey) return { videos: [], windowDays: null, insufficientData: true, noKey: true };

  const windows = [30, 60, 120, 180]; // дни — прогресивно разширяване, никога "без филтър"
  let items = [];
  let usedWindow = windows[windows.length - 1];

  for (const days of windows) {
    const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=${maxResults}&publishedAfter=${encodeURIComponent(publishedAfter)}&q=${encodeURIComponent(query)}&key=${k.ytApiKey}`;
    const sRes = await fetchTimeout(proxied(searchUrl));
    if (!sRes.ok) throw new Error("YouTube search грешка: " + (await sRes.text()));
    const sData = await sRes.json();
    items = sData.items || [];
    usedWindow = days;
    if (items.length >= minResults) break;
  }

  if (!items.length) return { videos: [], windowDays: usedWindow, insufficientData: true };

  // YouTube понякога връща search резултати за вече изтрити/private видеа —
  // такива items идват БЕЗ snippet (или без id.videoId). Филтрираме ги тук,
  // за да не гърми целият Niche Discovery с TypeError по-надолу.
  items = items.filter(i => i?.id?.videoId && i?.snippet);
  const videoIds = items.map(i => i.id.videoId).filter(Boolean);
  const channelIds = [...new Set(items.map(i => i.snippet?.channelId).filter(Boolean))];
  if (!videoIds.length) return { videos: [], windowDays: usedWindow, insufficientData: true };

  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds.join(",")}&key=${k.ytApiKey}`;
  const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds.join(",")}&key=${k.ytApiKey}`;
  const [vRes, cRes] = await Promise.all([fetchTimeout(proxied(videosUrl)), fetchTimeout(proxied(channelsUrl))]);
  if (!vRes.ok) throw new Error("YouTube videos.list грешка: " + (await vRes.text()));
  if (!cRes.ok) throw new Error("YouTube channels.list грешка: " + (await cRes.text()));
  const vData = await vRes.json();
  const cData = await cRes.json();

  const statsById = {};
  (vData.items || []).forEach(v => statsById[v.id] = v);
  const subsById = {};
  (cData.items || []).forEach(c => subsById[c.id] = parseInt(c.statistics?.subscriberCount || "0", 10));

  const now = Date.now();
  const videos = items.map(i => {
    const stat = statsById[i.id?.videoId];
    const views = parseInt(stat?.statistics?.viewCount || "0", 10);
    const publishedAt = stat?.snippet?.publishedAt || i.snippet?.publishedAt || new Date().toISOString();
    // мин. 0.5 дни, за да не гърми velocity до безкрайност за видеа отпреди часове
    const ageDays = Math.max((now - new Date(publishedAt).getTime()) / 86400000, 0.5);
    const subs = subsById[i.snippet?.channelId] || 0;
    return {
      videoId: i.id?.videoId || null,
      title: i.snippet?.title || "(без заглавие)",
      channel: i.snippet?.channelTitle || "(неизвестен канал)",
      channelId: i.snippet?.channelId || null,
      // search.list НЕ връща tags в snippet-а — само videos.list (stat) ги дава.
      tags: stat?.snippet?.tags || [],
      views, subs,
      publishedAt,
      ageDays: Math.round(ageDays * 10) / 10,
      velocity: Math.round(views / ageDays), // гледания/ден — реалният "трендва СЕГА" сигнал
      ratio: views / Math.max(subs, 1),
    };
  });

  videos.sort((a, b) => b.velocity - a.velocity);
  return { videos, windowDays: usedWindow, insufficientData: videos.length < minResults };
}

/* Жанрово заземяване за ViralLab: заглавия на видеа, които РЕАЛНО
   набират инерция точно сега (по velocity), не всички-времена топ. */
async function youtubeTopTitles(query, max = 12) {
  try {
    const { videos } = await fetchRecentTrendingVideos(query, { maxResults: max, minResults: 5 });
    return videos.slice(0, max).map(v => v.title).filter(Boolean);
  } catch (e) {
    return []; // тихо пропускаме — ViralLab пада обратно на model knowledge
  }
}

/* VidIQ-стил "outlier": малък канал (<10k абонати), чието скорошно
   видео вече расте непропорционално бързо — реален сигнал за
   органичен пробив СЕГА, изчислен само от скорошния прозорец. */
async function youtubeOutlierScan(query) {
  const k = Keys.load();
  if (!k.ytApiKey) throw new Error("Няма YouTube Data API Key (виж Настройки)");

  const { videos, windowDays, insufficientData } = await fetchRecentTrendingVideos(query, { maxResults: 25, minResults: 6 });
  if (!videos.length) return { outliers: [], totalChecked: 0, windowDays, insufficientData: true };

  const outliers = videos
    .filter(v => (v.ratio > 15 && v.views > 3000) || (v.subs < 10000 && v.views > 20000))
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 5);

  return { outliers, totalChecked: videos.length, windowDays, insufficientData };
}

/* =========================================================
   KEYWORD SUGGESTIONS (musicalSEO-подобен ефект)
   Ползва неофициалния Google/YouTube autocomplete suggest
   endpoint — показва какво реално дописва/търси аудиторията.
   ИЗИСКВА Proxy URL в Настройки (endpoint-ът няма CORS хедъри).
   ========================================================= */
async function keywordSuggest(query) {
  const k = Keys.load();
  if (!k.proxyUrl) throw new Error("Изисква се Proxy URL в Настройки за тази функция (виж бележката в Настройки)");
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
  const res = await fetchTimeout(proxied(url));
  if (!res.ok) throw new Error("Suggest заявка неуспешна: " + res.status);
  const data = await res.json();
  return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 10) : [];
}
