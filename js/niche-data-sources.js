/* =========================================================
   NICHE DATA SOURCES — допълнителни, БЕЗКЛЮЧОВИ сигнали за
   js/niche-scoring.js. Разширение на js/niche-toolkit.js
   (Spotify+YouTube), договорено с потребителя преди
   имплементацията — виж AUDIT_PROGRESS.md за пълния контекст.

   Зависи от: js/network.js (fetchTimeout, proxied) — зареден
   ПРЕДИ този файл в index.html.

   ВСЕКИ извикване тук НИКОГА не хвърля грешка нагоре — връща
   { available: false, error } при провал (мрежа, CORS, празен
   резултат), точно както _searchSpotifyTracksByGenre() в
   niche-toolkit.js вече прави. Целта: един счупен източник
   никога не бива да спира целия анализ — само намалява
   data coverage / confidence на крайния резултат.

   CORS бележка по източник (важно за proxied() решенията по-долу):
   - Deezer (api.deezer.com): официално НЕ връща CORS хедъри за
     browser заявки от чужд домейн (потвърдено, 2026) → изисква proxied().
   - iTunes Search API (itunes.apple.com/search): проектиран за
     клиентска употреба, историческа поддръжка на CORS → директен fetch,
     без proxy, с graceful catch при провал.
   - MusicBrainz (musicbrainz.org/ws/2): документирано CORS-enabled
     webservice → директен fetch. Rate limit 1 заявка/сек — виж
     bg твоя браузър конзола, ако видиш 503, изчакай и пробвай пак.
   - YouTube RSS (youtube.com/feeds/videos.xml): БЕЗ CORS хедъри →
     изисква proxied() (същото ограничение като keywordSuggest() в
     js/youtube.js).
   ========================================================= */

const NicheDataSources = {

  /* ---------- DEEZER: артисти по име + fan count (без ключ) ---------- */
  async fetchDeezerArtists(query, limit = 10) {
    try {
      const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await fetchTimeout(proxied(url), {}, 12000);
      if (!res.ok) return { available: false, error: `Deezer HTTP ${res.status}` };
      const data = await res.json();
      const items = data.data || [];
      if (!items.length) return { available: false, error: "Deezer: няма резултати за тази заявка" };
      return {
        available: true,
        artists: items.map(a => ({ id: a.id, name: a.name, fans: a.nb_fan || 0, link: a.link }))
      };
    } catch (e) {
      return { available: false, error: "Deezer: " + e.message };
    }
  },

  /* ---------- iTunes SEARCH API: тракове/чарт позиции по термин (без ключ) ----------
     ЗАБЕЛЕЖКА: това е iTunes Search API (itunes.apple.com/search), НЕ
     rss.itunes.apple.com чарт feed-а — последният няма гъвкав филтър по
     термин/жанр, само фиксирани "топ N" listи по категория. Search API
     дава по-директно съответствие с въведения от потребителя жанр/ниша. */
  async fetchItunesTracks(term, { country = "us", limit = 25 } = {}) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}&country=${encodeURIComponent(country)}`;
      const res = await fetchTimeout(url, {}, 12000); // без proxy — виж CORS бележката горе
      if (!res.ok) return { available: false, error: `iTunes HTTP ${res.status}` };
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) return { available: false, error: "iTunes: няма резултати за тази заявка" };
      return {
        available: true,
        tracks: results.map(r => ({
          trackName: r.trackName, artistName: r.artistName, collectionName: r.collectionName,
          releaseDate: r.releaseDate, primaryGenreName: r.primaryGenreName
        }))
      };
    } catch (e) {
      return { available: false, error: "iTunes: " + e.message };
    }
  },

  /* ---------- MUSICBRAINZ: метаданни/таксономия по артист (без ключ) ----------
     Полезно за: изчистване на "вселената" от изпълнители в нишата (виж
     по-ранната дискусия за n8n workflow — тук същата идея, но директно
     от браузъра) + жанр таговете помагат за под-ниши. */
  async fetchMusicBrainzArtists(query, limit = 10) {
    try {
      const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
      const res = await fetchTimeout(url, {}, 12000); // без proxy — виж CORS бележката горе
      if (!res.ok) return { available: false, error: `MusicBrainz HTTP ${res.status}` };
      const data = await res.json();
      const artists = data.artists || [];
      if (!artists.length) return { available: false, error: "MusicBrainz: няма резултати за тази заявка" };
      return {
        available: true,
        artists: artists.map(a => ({
          id: a.id, name: a.name, score: a.score,
          tags: (a.tags || []).map(t => t.name),
          country: a.country || null
        }))
      };
    } catch (e) {
      return { available: false, error: "MusicBrainz: " + e.message };
    }
  },

  /* ---------- YOUTUBE RSS: честота на публикуване на канал (без API ключ) ----------
     За разлика от js/youtube.js (videos.list, изисква ytApiKey), RSS
     feed-ът дава последните ~15 видеа на канала БЕЗ API ключ — полезно
     като лек, безплатен сигнал "колко активно публикува топ канала в
     нишата" без да харчи YouTube Data API quota. */
  async fetchYoutubeChannelActivity(channelId) {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
      const res = await fetchTimeout(proxied(url), {}, 12000);
      if (!res.ok) return { available: false, error: `YouTube RSS HTTP ${res.status}` };
      const text = await res.text();
      const dates = [...text.matchAll(/<published>([^<]+)<\/published>/g)].map(m => new Date(m[1])).filter(d => !isNaN(d));
      if (!dates.length) return { available: false, error: "YouTube RSS: няма видеа в емисията" };
      dates.sort((a, b) => b - a); // най-скорошно първо
      const daysSinceLastUpload = Math.round((Date.now() - dates[0].getTime()) / 86400000);
      return { available: true, videoCount: dates.length, lastPublished: dates[0].toISOString(), daysSinceLastUpload };
    } catch (e) {
      return { available: false, error: "YouTube RSS: " + e.message };
    }
  }
};
