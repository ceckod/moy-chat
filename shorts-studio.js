/* =========================================================
   Header коментар (виж ARCHITECTURE.md, "Правила за бъдеща работа" т.3):
   Зависимости (всички runtime, вътре в методи):
   fileToBase64(), callGeminiMultimodal(), callAI(), extractJson(),
   toast(), guardClick() (само от index.html onclick), Step4.uploadVideo()
   (само от uploadAll — не пипа Step4, само го извиква), AppState (по избор,
   за да прочете текущото име на песента от активния проект).
   Кой го ползва: само index.html (view-shorts-studio, бутони + input-и).
   Собствен namespace — не пипа app.js/QuickUpload/Step4 отвътре, само
   извиква публичните им методи.
   ========================================================= */
/* =========================================================
   AI SHORTS STUDIO — "качи 1 песен → получи N различни Shorts,
   готови за YouTube"
   Pipeline: аудио → (Gemini, multimodal) анализ + избор на N различни
   "hook" момента (timestamp диапазони) → (Claude) уникално заглавие/
   описание/хаштагове за всеки момент → визуализаторът (собствен скрит
   iframe, презарежда се за всеки клип) изрязва точно този диапазон
   във вертикално (9:16) видео → преглед/редакция → 1 бутон качва
   всички последователно в YouTube (unlisted, като останалата част
   от dashboard-а).

   Линкове за стрийминг (Spotify/Apple Music/DistroKid) в описанието:
   AI-ят НИКОГА не измисля URL — генерира описанието с литерални токени
   ({{SPOTIFY_LINK}} и т.н.), а findLinks()/_injectLinks() ги заменят
   ДЕТЕРМИНИРАНО с реални стойности (или трият целия ред, ако линкът е
   празен). Spotify/Apple Music се търсят автоматично (Spotify през
   NicheToolkit._getSpotifyToken(), Apple през публичния iTunes Search
   API) — DistroKid няма публичен search, остава ръчно поле.
   ========================================================= */
const ShortsStudio = {
  audioFile: null,
  items: [],          // [{ index, start, end, hookReason, hookText, title, description, tags, videoBlob, fileName, status }]
  analysis: null,      // {genre, mood, energy, language, language_code, lyrics}
  _msgBound: false,
  _renderQueueBusy: false,

  onAudioSelected(input) {
    const f = input.files[0];
    const infoEl = document.getElementById("ssAudioInfo");
    if (!f) { if (infoEl) infoEl.textContent = ""; this.audioFile = null; return; }
    this.audioFile = f;
    if (infoEl) infoEl.textContent = `Избрано: ${f.name} (${Math.round(f.size / 1024 / 1024 * 10) / 10} MB)`;
    const nameEl = document.getElementById("ssSongName");
    if (nameEl && !nameEl.value.trim()) {
      nameEl.value = f.name.replace(/\.[^/.]+$/, "").replace(/[_\-]+/g, " ").trim();
    }
    const artistEl = document.getElementById("ssArtistName");
    const savedArtist = localStorage.getItem("cdb_artist_name_v1");
    if (artistEl && !artistEl.value.trim() && savedArtist) artistEl.value = savedArtist;
    this._loadSavedLinks();
    document.getElementById("ssStartBtn").disabled = false;
  },

  saveArtistName(v) { if (v && v.trim()) localStorage.setItem("cdb_artist_name_v1", v.trim()); },

  // --- DistroKid библиотека (пейстнат списък от "My Music") -------------
  // Всяка песен в DistroKid си има СОБСТВЕНА HyperFollow страница (различна
  // от общата hyperfollow.com/{юзърнейм}) — затова пазим целия списък
  // {artist, song, url}, вместо да гадаем 1 общ линк за всички клипове.
  importDistrokidLibrary() {
    const raw = document.getElementById("ssDistrokidLibraryPaste")?.value || "";
    const entries = this._parseDistrokidLibrary(raw);
    const statusEl = document.getElementById("ssDistrokidLibStatus");
    if (!entries.length) {
      if (statusEl) statusEl.textContent = "⚠️ Не намерих нито един разпознаваем ред (заглавие + hyperfollow линк). Провери формата на пейстнатия текст.";
      return;
    }
    try { localStorage.setItem("cdb_distrokid_library_v1", JSON.stringify(entries)); } catch (e) { /* тихо, не е фатално */ }
    // Ако юзърнеймът все още е празен, вземаме го от библиотеката (удобство).
    const hfEl = document.getElementById("ssHyperfollowUsername");
    if (hfEl && !hfEl.value.trim() && entries[0].username) {
      hfEl.value = entries[0].username;
      localStorage.setItem("cdb_hyperfollow_username_v1", entries[0].username);
    }
    if (statusEl) statusEl.textContent = `✅ Импортирани ${entries.length} песни. При "Опитай да намеря..." ще пасва точния линк по име на песента.`;
    this.log(`📥 Импортирана DistroKid библиотека: ${entries.length} песни.`);
  },

  _loadDistrokidLibrary() {
    try { return JSON.parse(localStorage.getItem("cdb_distrokid_library_v1") || "[]"); }
    catch (e) { return []; }
  },

  // Минава през ЦЯЛАТА импортирана DistroKid библиотека (не само текущата
  // песен). Приоритет 1: чете директно HyperFollow страницата на всяка
  // песен (entry.url) и извлича ВСИЧКИ вградени платформени линкове наведнъж
  // (Spotify/Apple/Deezer/Tidal/iHeart/... — виж _PLATFORM_PATTERNS) —
  // гарантирано точна песен, без риск от грешно съвпадение. Приоритет 2
  // (fallback само за платформи, които страницата НЕ съдържа): Spotify Web
  // API / iTunes Search API / YouTube Data API търсене по име. Резултатите
  // се записват обратно в библиотеката (localStorage), за да не се търсят
  // повторно следващия път.
  async enrichLibrary() {
    const lib = this._loadDistrokidLibrary();
    if (!lib.length) return toast("Първо импортирай DistroKid библиотеката по-горе");
    const statusEl = document.getElementById("ssLibEnrichStatus");
    const resultsEl = document.getElementById("ssLibEnrichResults");
    resultsEl.innerHTML = "";
    const total = lib.length;

    let spotifyToken = null;
    try { spotifyToken = await NicheToolkit._getSpotifyToken(); }
    catch (e) { this.log("⚠️ Spotify token: " + e.message + " — Spotify fallback търсенето няма да работи (страницата пак може да го намери)."); }
    const ytKey = Keys.load().ytApiKey;
    if (!ytKey) this.log("⚪ Няма YouTube API Key в Настройки — YouTube fallback търсенето е изключено (страницата пак може да съдържа YouTube линк).");

    for (let i = 0; i < total; i++) {
      const e = lib[i];
      if (statusEl) statusEl.textContent = `⏳ ${i + 1}/${total}: ${e.song}...`;
      e.platforms = e.platforms || {};

      // Приоритет 1 — четем реалната HyperFollow страница на песента.
      if (e.url) {
        const found = await this._fetchPlatformLinksFromPage(e.url);
        Object.assign(e.platforms, found); // не трием вече намерени от преди, само допълваме
      }

      // Приоритет 2 — fallback търсене по име, само за платформи, които
      // страницата не съдържаше.
      if (!e.platforms.spotify && spotifyToken) {
        try {
          const q = `track:${e.song} artist:${e.artist}`;
          const res = await fetchTimeout(proxied(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`), {
            headers: { "Authorization": `Bearer ${spotifyToken}` }
          }, 15000);
          if (res.ok) { const d = await res.json(); const u = d.tracks?.items?.[0]?.external_urls?.spotify; if (u) e.platforms.spotify = u; }
        } catch (err) { /* тихо — просто оставаме без Spotify за тази песен */ }
      }
      if (!e.platforms.apple) {
        try {
          const term = `${e.artist} ${e.song}`;
          const res = await fetchTimeout(proxied(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`), {}, 15000);
          if (res.ok) { const d = await res.json(); const u = d.results?.[0]?.trackViewUrl; if (u) e.platforms.apple = u; }
        } catch (err) { /* тихо */ }
      }
      if (!e.platforms.youtube && ytKey) {
        try {
          const q = `${e.artist} ${e.song}`;
          const res = await fetchTimeout(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(q)}&key=${ytKey}`, {}, 15000);
          if (res.ok) {
            const d = await res.json();
            const vid = d.items?.[0]?.id?.videoId;
            if (vid) e.platforms.youtube = `https://www.youtube.com/watch?v=${vid}`;
          }
        } catch (err) { /* тихо */ }
      }

      // Обратна съвместимост с по-стари полета, ако другаде в кода/данните
      // все още се четат директно (напр. стар импорт от преди тази версия).
      e.spotifyUrl = e.platforms.spotify || e.spotifyUrl || "";
      e.appleUrl = e.platforms.apple || e.appleUrl || "";
      e.youtubeUrl = e.platforms.youtube || e.youtubeUrl || "";

      resultsEl.innerHTML += this._enrichRowHtml(e);
      resultsEl.scrollTop = resultsEl.scrollHeight;
      // Кратка пауза между песните — по-щадящо към API квотите.
      await new Promise(r => setTimeout(r, 300));
    }

    try { localStorage.setItem("cdb_distrokid_library_v1", JSON.stringify(lib)); } catch (err) { /* не е фатално */ }
    const counts = {};
    for (const key of Object.keys(this._PLATFORM_LABELS)) counts[key] = lib.filter(e => e.platforms?.[key]).length;
    const summary = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${this._platformLabel(k)} ${n}/${total}`).join(" · ");
    if (statusEl) statusEl.textContent = `✅ Готово: ${summary || "нищо не се намери"}.`;
    this.log(`🔍 Обогатяване на библиотеката готово — ${summary || "нищо не се намери"}.`);
  },

  _enrichRowHtml(e) {
    const platforms = e.platforms || {};
    const chips = Object.keys(this._PLATFORM_LABELS)
      .filter(key => platforms[key])
      .map(key => `<a href="${this._escAttr(platforms[key])}" target="_blank" rel="noopener">${this._platformLabel(key)} ✅</a>`)
      .join(" · ");
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
      <strong>${this._esc(e.song)}</strong><br>
      ${chips || '<span class="muted">— нищо намерено —</span>'}
    </div>`;
  },

  _parseDistrokidLibrary(text) {
    const NOISE = /^(©|English|Help|Support Center|Company|DistroKid Blog|Nail Clippers|Artists For Change|Careers|Influencer|Product|Plans|Bandzoogle|Instant Share|Mixea|DistroVid|HyperFollow|Direct|Mobile App|DistroKid for|Privacy policy|Cookie|Terms of use|Sitemap|Distribution agreement|Upload|My Music|Stats|Splits|Upgrade|Bank|HyperFollow is the easiest)/i;
    const lines = text.split(/\r?\n/).map(l => l.trim());
    const entries = [];
    let lastTitleLine = null;
    for (const line of lines) {
      if (!line) continue;
      const urlMatch = line.match(/^https?:\/\/distrokid\.com\/hyperfollow\/([^/\s]+)\/(\S+)$/i);
      if (urlMatch) {
        if (lastTitleLine) {
          const dashIdx = lastTitleLine.indexOf(" - ");
          const artist = dashIdx >= 0 ? lastTitleLine.slice(0, dashIdx).trim() : "";
          const song = dashIdx >= 0 ? lastTitleLine.slice(dashIdx + 3).trim() : lastTitleLine;
          entries.push({ artist, song, username: urlMatch[1], url: line });
        }
        lastTitleLine = null;
        continue;
      }
      if (/\d+\s*views?|presave/i.test(line)) continue; // статистика реда - прескачаме
      if (NOISE.test(line)) continue; // навигация/футър шум от копирания текст
      lastTitleLine = line; // кандидат за "Артист - Заглавие" реда
    }
    return entries;
  },

  // Нормализира заглавие за сравнение: маха (feat. ...), пунктуация, регистър.
  _normalizeSongTitle(s) {
    return (s || "").toString().toLowerCase()
      .replace(/\(feat\.[^)]*\)/gi, "")
      .replace(/feat\.[^-]*$/gi, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  },

  // Намира най-доброто съвпадение в библиотеката по име на текущата песен.
  // Връща {artist, song, username, url} или null.
  _findDistrokidLink(songName) {
    const lib = this._loadDistrokidLibrary();
    const target = this._normalizeSongTitle(songName);
    if (!target || !lib.length) return null;
    for (const e of lib) { if (this._normalizeSongTitle(e.song) === target) return e; } // точно съвпадение
    for (const e of lib) { // частично съвпадение като резервен вариант
      const norm = this._normalizeSongTitle(e.song);
      if (norm && (norm.includes(target) || target.includes(norm))) return e;
    }
    return null;
  },

  // Линковете се пазят локално по (артист + песен), за да не търсиш наново
  // всеки път — веднъж намерени/въведени, автоматично се презареждат.
  _linksKey() {
    const song = (document.getElementById("ssSongName")?.value || "").trim().toLowerCase();
    const artist = (document.getElementById("ssArtistName")?.value || "").trim().toLowerCase();
    return `${artist}::${song}`;
  },
  _loadSavedLinks() {
    try {
      const all = JSON.parse(localStorage.getItem("cdb_song_links_v1") || "{}");
      const saved = all[this._linksKey()];
      if (saved) {
        if (saved.spotify) document.getElementById("ssLinkSpotify").value = saved.spotify;
        if (saved.apple) document.getElementById("ssLinkApple").value = saved.apple;
        if (saved.distrokid) document.getElementById("ssLinkDistrokid").value = saved.distrokid;
      }
      const hfEl = document.getElementById("ssHyperfollowUsername");
      const savedHf = localStorage.getItem("cdb_hyperfollow_username_v1");
      if (hfEl && !hfEl.value.trim() && savedHf) hfEl.value = savedHf;
    } catch (e) { /* без localStorage — просто не предпълваме, не е фатално */ }
  },
  _saveLinks() {
    try {
      const all = JSON.parse(localStorage.getItem("cdb_song_links_v1") || "{}");
      all[this._linksKey()] = {
        spotify: document.getElementById("ssLinkSpotify").value.trim(),
        apple: document.getElementById("ssLinkApple").value.trim(),
        distrokid: document.getElementById("ssLinkDistrokid").value.trim()
      };
      localStorage.setItem("cdb_song_links_v1", JSON.stringify(all));
      const hf = document.getElementById("ssHyperfollowUsername")?.value.trim();
      if (hf) localStorage.setItem("cdb_hyperfollow_username_v1", hf);
    } catch (e) { /* тихо — само удобство, не пречи на основния pipeline */ }
  },

  // Опитва да намери РЕАЛНИ Spotify + Apple Music линкове за песента (търсене
  // по заглавие+артист). DistroKid НЯМА публичен search endpoint (не е
  // магазин/каталог с публични track страници) — остава ръчно поле.
  async findLinks() {
    const song = document.getElementById("ssSongName").value.trim();
    const artist = document.getElementById("ssArtistName").value.trim();
    const statusEl = document.getElementById("ssLinksStatus");
    if (!song) { toast("Първо въведи име на песента"); return; }
    if (statusEl) statusEl.textContent = "⏳ Търся...";
    let foundAny = false;
    let pageLinks = null;

    // Приоритет 1: ако песента я има в импортираната DistroKid библиотека,
    // директно ЧЕТЕМ реалната ѝ HyperFollow страница — тя вече съдържа
    // истинските Spotify/Apple/Deezer/iHeart/... линкове, вградени от самия
    // DistroKid (за Facebook/Instagram preview). Това е ТОЧНО тази песен,
    // без риск да хванем грешен артист със същото заглавие (какъвто риск
    // има при търсене по име в Spotify/iTunes API).
    const libMatch = this._findDistrokidLink(song);
    if (libMatch) {
      document.getElementById("ssLinkDistrokid").value = libMatch.url;
      foundAny = true;
      this.log(`✅ Намерена песента в библиотеката: "${libMatch.song}" → чета HyperFollow страницата ѝ...`);
      pageLinks = await this._fetchPlatformLinksFromPage(libMatch.url);
      if (pageLinks && pageLinks.spotify) { document.getElementById("ssLinkSpotify").value = pageLinks.spotify; foundAny = true; }
      if (pageLinks && pageLinks.apple) { document.getElementById("ssLinkApple").value = pageLinks.apple; foundAny = true; }
      if (pageLinks && Object.keys(pageLinks).length) {
        this.log(`✅ От HyperFollow страницата: ${Object.keys(pageLinks).map(k => this._platformLabel(k)).join(", ")}.`);
      } else {
        this.log("⚪ HyperFollow страницата не съдържа платформени линкове (може още да не е пуснала песента).");
      }
    }

    // Fallback (само ако песента НЕ е в библиотеката) — търсене по име през
    // Spotify Web API / iTunes Search API, с известен риск от грешно
    // съвпадение при често срещани заглавия.
    if (!pageLinks || !pageLinks.spotify) {
      try {
        const token = await NicheToolkit._getSpotifyToken();
        const q = artist ? `track:${song} artist:${artist}` : song;
        const res = await fetchTimeout(proxied(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`), {
          headers: { "Authorization": `Bearer ${token}` }
        }, 15000);
        if (res.ok) {
          const data = await res.json();
          const track = data.tracks?.items?.[0];
          const url = track?.external_urls?.spotify;
          if (url) {
            document.getElementById("ssLinkSpotify").value = url;
            foundAny = true;
            this.log(`✅ Намерен Spotify линк (търсене по име): ${track.name} — ${track.artists?.[0]?.name || "?"}`);
          } else {
            this.log("⚪ Spotify: няма намерена песен с това заглавие (може още да не е качена).");
          }
        } else {
          this.log(`⚠️ Spotify търсене неуспешно (${res.status}).`);
        }
      } catch (e) {
        this.log("⚠️ Spotify: " + e.message);
      }
    }

    if (!pageLinks || !pageLinks.apple) {
      try {
        const term = artist ? `${artist} ${song}` : song;
        const res = await fetchTimeout(proxied(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`), {}, 15000);
        if (res.ok) {
          const data = await res.json();
          const track = data.results?.[0];
          const url = track?.trackViewUrl;
          if (url) {
            document.getElementById("ssLinkApple").value = url;
            foundAny = true;
            this.log(`✅ Намерен Apple Music линк (търсене по име): ${track.trackName} — ${track.artistName || "?"}`);
          } else {
            this.log("⚪ Apple Music: няма намерена песен с това заглавие.");
          }
        } else {
          this.log(`⚠️ Apple Music търсене неуспешно (${res.status}).`);
        }
      } catch (e) {
        this.log("⚠️ Apple Music: " + e.message);
      }
    }

    if (!libMatch) {
      const hfUsername = document.getElementById("ssHyperfollowUsername")?.value.trim().replace(/^@/, "");
      if (hfUsername) {
        try {
          const hfUrl = `https://hyperfollow.com/${encodeURIComponent(hfUsername)}`;
          const res = await fetchTimeout(proxied(hfUrl), {}, 15000);
          if (res.ok) {
            document.getElementById("ssLinkDistrokid").value = hfUrl;
            foundAny = true;
            this.log(`✅ Намерена обща HyperFollow страница (не по конкретна песен): ${hfUrl}`);
          } else {
            this.log(`⚪ HyperFollow: страница "${hfUsername}" не е намерена (${res.status}) — провери юзърнейма или го попълни ръчно.`);
          }
        } catch (e) {
          this.log("⚠️ HyperFollow проверка: " + e.message);
        }
      } else {
        this.log("⚪ DistroKid: няма съвпадение в библиотеката и няма зададен юзърнейм — попълни ръчно или импортирай списъка.");
      }
    }

    this._saveLinks();
    if (statusEl) statusEl.textContent = foundAny
      ? "✅ Намерени линкове са попълнени по-горе — провери ги преди да продължиш."
      : "⚪ Нищо не се намери автоматично (нормално, ако песента още не е пусната) — можеш да въведеш ръчно.";
  },

  // Всички платформи, които DistroKid може да вгради в HyperFollow страница
  // (не само Spotify/Apple) — по домейн, за общо извличане с regex.
  _PLATFORM_PATTERNS: {
    spotify: /href="(https:\/\/open\.spotify\.com\/[^"]+)"/i,
    apple: /href="(https:\/\/music\.apple\.com\/[^"]+)"/i,
    youtube: /href="(https:\/\/(?:www\.)?youtube\.com\/[^"]+|https:\/\/youtu\.be\/[^"]+)"/i,
    youtubeMusic: /href="(https:\/\/music\.youtube\.com\/[^"]+)"/i,
    deezer: /href="(https:\/\/www\.deezer\.com\/[^"]+)"/i,
    tidal: /href="(https:\/\/(?:listen\.)?tidal\.com\/[^"]+)"/i,
    amazonMusic: /href="(https:\/\/(?:music|www)\.amazon\.[a-z.]+\/[^"]*(?:albums|dp)[^"]*)"/i,
    iheartradio: /href="(https:\/\/(?:www\.)?iheart\.com\/[^"]+)"/i,
    pandora: /href="(https:\/\/(?:www\.)?pandora\.com\/[^"]+)"/i,
    napster: /href="(https:\/\/(?:app|www)\.napster\.com\/[^"]+)"/i,
    soundcloud: /href="(https:\/\/(?:www\.)?soundcloud\.com\/[^"]+)"/i
  },
  _PLATFORM_LABELS: {
    spotify: "Spotify", apple: "Apple Music", youtube: "YouTube", youtubeMusic: "YouTube Music",
    deezer: "Deezer", tidal: "Tidal", amazonMusic: "Amazon Music", iheartradio: "iHeartRadio",
    pandora: "Pandora", napster: "Napster", soundcloud: "SoundCloud"
  },
  _platformLabel(key) { return this._PLATFORM_LABELS[key] || key; },

  // Чете реалната HyperFollow страница на песента и извлича ВСИЧКИ
  // платформени линкове, вградени в HTML-я ѝ (DistroKid ги слага директно
  // в страницата, за да работят Facebook/Instagram/Twitter preview-ите —
  // затова ги има без нужда от JS рендиране). Връща {spotify: "...", ...}
  // само с намерените платформи (празен обект, ако страницата не се зареди).
  async _fetchPlatformLinksFromPage(url) {
    const found = {};
    try {
      const res = await fetchTimeout(proxied(url), {}, 15000);
      if (!res.ok) return found;
      const html = await res.text();
      for (const [key, re] of Object.entries(this._PLATFORM_PATTERNS)) {
        const m = html.match(re);
        if (m) found[key] = m[1];
      }
    } catch (e) { this.log("⚠️ Четене на HyperFollow страницата: " + e.message); }
    return found;
  },

  log(msg) {
    const el = document.getElementById("ssLog");
    if (!el) return;
    const time = new Date().toLocaleTimeString("bg-BG");
    el.innerHTML += `<div>[${time}] ${msg}</div>`;
    el.scrollTop = el.scrollHeight;
  },

  _setRunning(v) {
    const btn = document.getElementById("ssStartBtn");
    if (btn) btn.disabled = v;
    const spinner = document.getElementById("ssRunning");
    if (spinner) spinner.style.display = v ? "block" : "none";
  },

  _pastedLyrics() {
    const el = document.getElementById("ssLyricsPaste");
    return el ? el.value.trim() : "";
  },

  _getCount() {
    const el = document.getElementById("ssCount");
    return el ? parseInt(el.value, 10) || 3 : 3;
  },

  // Чете продължителността на аудиото в браузъра (нужна на AI-я, за да не
  // предлага timestamp-и извън реалната дължина на песента).
  _getAudioDuration(file) {
    return new Promise((resolve, reject) => {
      const el = new Audio();
      el.preload = "metadata";
      el.onloadedmetadata = () => { const d = el.duration; URL.revokeObjectURL(el.src); resolve(d); };
      el.onerror = () => reject(new Error("Не успях да прочета продължителността на аудиото."));
      el.src = URL.createObjectURL(file);
    });
  },

  _fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ":" + String(s).padStart(2, "0");
  },

  // Основен вход — целият pipeline: анализ+избор на моменти → метаданни → видео за всеки → преглед.
  async runFull() {
    if (!this.audioFile) return toast("Първо избери аудио файл");
    const songNameEl = document.getElementById("ssSongName");
    const songName = (songNameEl && songNameEl.value.trim()) || this.audioFile.name.replace(/\.[^/.]+$/, "");
    const count = this._getCount();

    this.items = [];
    this.analysis = null;
    document.getElementById("ssLog").innerHTML = "";
    document.getElementById("ssResultsWrap").style.display = "none";
    document.getElementById("ssItemsWrap").innerHTML = "";
    const progWrap = document.getElementById("ssVideoProgressWrap");
    if (progWrap) progWrap.style.display = "none";
    this._setRunning(true);
    this.log(`🚀 Стартирам — искам ${count} различен Short${count > 1 ? "а" : ""} от "${songName}".`);

    try {
      await this._analyzeAndPickMoments(songName, count);
      await this._generateMetaForAll(songName, count);
      await this._renderAllClips(songName);
      this._renderResults();
      document.getElementById("ssResultsWrap").style.display = "block";
      this.log("🎉 Всички Shorts са готови — прегледай/поправи по-долу и качи с бутона.");
    } catch (e) {
      this.log("❌ Грешка: " + e.message);
    } finally {
      this._setRunning(false);
    }
  },

  async _analyzeAndPickMoments(songName, count) {
    this.log("🎧 Gemini слуша песента и избира " + count + " различни \"hook\" момента (за максимален watch time)...");
    const totalDur = await this._getAudioDuration(this.audioFile);
    const base64 = await fileToBase64(this.audioFile);
    const mimeType = this.audioFile.type || "audio/mpeg";
    const pasted = this._pastedLyrics();

    const prompt = `Ти си музикален анализатор и YouTube Shorts стратег. Слушай приложения аудио файл (песен "${songName}", обща продължителност ${Math.round(totalDur)} секунди / ${this._fmtTime(totalDur)}) и направи следното:

1. Анализирай звука: genre (жанр/поджанр, 2-4 думи), mood (настроение, 2-4 думи), energy ("ниско"/"средно"/"високо"), language (ЕЗИКЪТ, на който се пее — определи го САМО от това, което чуваш), language_code (ISO 639-1, напр. "bg"/"en").
2. lyrics — текстът на песента, на РЕАЛНИЯ й език (НЕ превеждай)${pasted ? " — по-долу е дадена ГОТОВА версия от потребителя, ползвай я КАКТО Е" : " — РАЗПОЗНАЙ го от аудиото, доколкото е разбираемо"}.
${pasted ? `Текст, пейстнат от потребителя:\n---\n${pasted}\n---\n` : ""}
3. Избери ТОЧНО ${count} различни, силно "залепващи" момента от песента, всеки — кандидат за отделен YouTube Short:
   - "start"/"end" в секунди, цели числа, 0 <= start < end <= ${Math.floor(totalDur)}
   - продължителност на всеки момент между 18 и 58 секунди
   - предпочитай момент, който звучи завършено сам по себе си (хук/припев/drop/емоционален връх/изненадващ ред), не по средата на дума
   - ${count > 1 ? `ЗАДЪЛЖИТЕЛНО ${count}-те момента трябва да са от РАЗЛИЧНИ части на песента (не се припокриват, различно усещане всеки — напр. интро-кука, припев, бридж/drop, финален момент и т.н.)` : "избери НАЙ-силния 1 момент от цялата песен"}
   - "hook_reason": 1 изречение защо точно този момент е избран (вътрешна бележка, не се показва публично)
   - "hook_text": кратък текст за overlay върху видеото (до 40 символа), на езика на песента, който възбужда любопитство/емоция (не просто заглавието на песента)

Върни ЧИСТ JSON, без нищо друго:
{"genre":"...", "mood":"...", "energy":"...", "language":"...", "language_code":"...", "lyrics":"...", "segments":[{"start":0,"end":30,"hook_reason":"...","hook_text":"..."}]}`;

    const raw = await callGeminiMultimodal(prompt, base64, mimeType);
    const parsed = extractJson(raw);
    this.analysis = {
      genre: parsed.genre, mood: parsed.mood, energy: parsed.energy,
      language: parsed.language, language_code: parsed.language_code, lyrics: parsed.lyrics
    };
    let segments = Array.isArray(parsed.segments) ? parsed.segments : [];

    // Гаранция на кода (не само на промпта): изрязваме/поправяме диапазони извън
    // реалната продължителност на файла и подсигуряваме точен брой елементи,
    // за да не се счупи рендерирането по-долу дори ако AI-я върне грешен формат.
    segments = segments
      .map(s => ({
        start: Math.max(0, Math.floor(Number(s.start) || 0)),
        end: Math.min(Math.floor(totalDur), Math.ceil(Number(s.end) || 0)),
        hook_reason: s.hook_reason || "",
        hook_text: (s.hook_text || songName).toString().slice(0, 60)
      }))
      .filter(s => s.end - s.start >= 10)
      .slice(0, count);

    if (!segments.length) {
      // Резервен вариант, ако AI-ят не върне валидни диапазони — равномерно
      // разпределени 30-сек. откъса по цялата песен, за да не спре целият pipeline.
      const clipLen = Math.min(30, Math.max(15, Math.floor(totalDur / (count + 1))));
      for (let i = 0; i < count; i++) {
        const start = Math.floor((totalDur / (count + 1)) * (i + 1) - clipLen / 2);
        segments.push({ start: Math.max(0, start), end: Math.min(Math.floor(totalDur), Math.max(0, start) + clipLen), hook_reason: "резервен избор", hook_text: songName });
      }
      this.log("⚠️ AI-ят не върна валидни моменти — ползвам резервно равномерно разпределение.");
    }
    while (segments.length < count) segments.push(segments[segments.length - 1]);

    this.items = segments.map((s, i) => ({
      index: i, start: s.start, end: s.end, hookReason: s.hook_reason, hookText: s.hook_text,
      title: "", description: "", tags: [], videoBlob: null, fileName: "", status: "pending"
    }));
    this.log(`✅ Избрани моменти: ` + this.items.map(it => `#${it.index + 1} [${this._fmtTime(it.start)}–${this._fmtTime(it.end)}]`).join(", "));
  },

  async _generateMetaForAll(songName, count) {
    this.log("✍️ Claude генерира заглавие/описание/хаштагове за всеки Short (всеки — различен ъгъл)...");
    const a = this.analysis || {};
    const segList = this.items.map(it =>
      `#${it.index + 1}: [${this._fmtTime(it.start)}–${this._fmtTime(it.end)}] причина: ${it.hookReason || "—"} · overlay текст: "${it.hookText}"`
    ).join("\n");

    const prompt = `За YouTube Shorts от песента "${songName}" (жанр: ${a.genre || "?"}, настроение: ${a.mood || "?"}, енергия: ${a.energy || "?"}, език: ${a.language || "?"} / ${a.language_code || "?"}).
Текст на песента (откъс, за контекст на темата — НЕ го копирай изцяло): ${(a.lyrics || "").slice(0, 600)}

По-долу е списък от ${count} различни момента от песента, всеки ще стане ОТДЕЛЕН YouTube Short:
${segList}

За ВСЕКИ от ${count}-те момента (в СЪЩИЯ ред по номер) генерирай метаданни, оптимизирани за максимален watch time и виралност:
- title: ЗАДЪЛЖИТЕЛНО започва или съдържа точното име на песента "${songName}", плюс кука/curiosity gap базирана на overlay текста и причината за момента; до 90 символа общо; на езика на песента (${a.language || "?"}); може 1 подходящ emoji
- description: на езика на песента — 2-3 изречения хук/контекст за конкретния момент (НЕ generic), после точно тези 3 реда (ТОЧНО както са, само добави текста на езика на песента, НЕ пипай токените в {{...}} и НЕ ги замествай с истински линкове — те се вкарват автоматично от кода):
🎧 ${a.language_code === "bg" ? "Слушай в Spotify" : "Listen on Spotify"}: {{SPOTIFY_LINK}}
🍏 ${a.language_code === "bg" ? "Слушай в Apple Music" : "Listen on Apple Music"}: {{APPLE_LINK}}
📀 ${a.language_code === "bg" ? "Още платформи" : "More platforms"}: {{DISTROKID_LINK}}
После блок от 15-20 релевантни хаштага с # (ЗАДЪЛЖИТЕЛНО включва #shorts и #short, плюс жанрови/тематични/общи viral хаштагове, разумна смесица от езика на песента и общоприети английски)
- tags: масив от 10-15 YouTube ключови тагове (кратки думи/фрази, БЕЗ #), предимно на езика на песента + 1-2 общоприети английски (жанр, "shorts" и т.н.)

ЗАДЪЛЖИТЕЛНО: ${count > 1 ? `всичките ${count} комплекта title/description ТРЯБВА да звучат забележимо различно едно от друго (различен ъгъл/кука за всеки момент) — НЕ преизползвай едни и същи фрази/структура.` : "направи го възможно най-примамливо за клик."}

Върни ЧИСТ JSON масив от точно ${count} обекта, по един на всеки момент, В СЪЩИЯ РЕД:
[{"title":"...", "description":"...", "tags":["...", "..."]}]`;

    const raw = await callAI(prompt, 1400);
    let metaList = extractJson(raw);
    if (!Array.isArray(metaList)) metaList = [metaList].filter(Boolean);

    this.items.forEach((it, i) => {
      const m = metaList[i] || {};
      let title = (m.title || `${songName} - Short ${i + 1}`).toString().trim();
      if (!title.toLowerCase().includes(songName.trim().toLowerCase())) title = `${songName} - ${title}`;
      it.title = title.slice(0, 100);
      it.description = (m.description || `${songName}\n\n#shorts #short`).toString();
      it.tags = Array.isArray(m.tags) ? m.tags.map(t => String(t).trim()).filter(Boolean) : [];
    });
    this._injectLinks();
    this.log("✅ Заглавия/описания/тагове готови за всичките " + count + ".");
  },

  // Детерминирано замества {{SPOTIFY_LINK}}/{{APPLE_LINK}}/{{DISTROKID_LINK}}
  // токените с реалните стойности от полетата (или трие целия ред, ако е
  // празно) — AI-ят никога не пипа/измисля реални URL-и, само оставя токена.
  _injectLinks() {
    const links = {
      SPOTIFY_LINK: document.getElementById("ssLinkSpotify")?.value.trim() || "",
      APPLE_LINK: document.getElementById("ssLinkApple")?.value.trim() || "",
      DISTROKID_LINK: document.getElementById("ssLinkDistrokid")?.value.trim() || ""
    };
    this.items.forEach(it => {
      it.description = it.description
        .split("\n")
        .map(line => {
          const tokenMatch = line.match(/\{\{(SPOTIFY_LINK|APPLE_LINK|DISTROKID_LINK)\}\}/);
          if (!tokenMatch) return line;
          const val = links[tokenMatch[1]];
          if (!val) return null; // празен линк → редът изчезва изцяло, не оставяме "{{...}}" в описанието
          return line.replace(/\{\{(SPOTIFY_LINK|APPLE_LINK|DISTROKID_LINK)\}\}/, val);
        })
        .filter(line => line !== null)
        .join("\n");
    });
  },

  // Рендерира клиповете ПОСЛЕДОВАТЕЛНО (един по един) — визуализаторът е canvas
  // recording, не може да пише две видеа паралелно в един и същ таб.
  async _renderAllClips(songName) {
    this._bindMessageListener();
    const total = this.items.length;
    for (let i = 0; i < total; i++) {
      const it = this.items[i];
      this.log(`🎬 Клип ${i + 1}/${total} [${this._fmtTime(it.start)}–${this._fmtTime(it.end)}] — рендирам вертикално видео...`);
      this._setClipProgress(i + 1, total, 0);
      await this._renderOneClip(it);
      this.log(`✅ Клип ${i + 1}/${total} готов (${Math.round(it.videoBlob.size / 1024 / 1024 * 10) / 10} MB).`);
    }
  },

  _setClipProgress(current, total, pct) {
    const wrap = document.getElementById("ssVideoProgressWrap");
    const bar = document.getElementById("ssVideoProgressBar");
    const label = document.getElementById("ssVideoProgressLabel");
    if (!bar) return;
    if (wrap) wrap.style.display = "block";
    bar.style.width = pct + "%";
    if (label) label.textContent = pct >= 100
      ? `Клип ${current}/${total}: готово ✅`
      : `Клип ${current}/${total}: записва се… ${pct}%`;
  },

  _bindMessageListener() {
    if (this._msgBound) return;
    this._msgBound = true;
    window.addEventListener("message", (ev) => {
      const frame = document.getElementById("shortsVisualizerFrame");
      if (!frame || ev.source !== frame.contentWindow || !ev.data) return;
      if (ev.data.type === "cdb-video-ready" && this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve({ blob: ev.data.blob, fileName: ev.data.fileName || "short.webm" });
      }
      if (ev.data.type === "cdb-video-progress" && this._pendingIndex != null) {
        this._setClipProgress(this._pendingIndex + 1, this.items.length, ev.data.percent);
      }
      if (ev.data.type === "cdb-video-error" && this._pendingReject) {
        const reject = this._pendingReject;
        this._pendingReject = null;
        reject(new Error(ev.data.message || "Грешка от визуализатора"));
      }
    });
  },

  _renderOneClip(item) {
    return new Promise((resolve, reject) => {
      this._pendingIndex = item.index;
      this._pendingResolve = async ({ blob, fileName }) => {
        item.videoBlob = blob;
        item.fileName = fileName;
        item.status = "rendered";
        resolve();
      };
      this._pendingReject = (err) => { item.status = "error"; reject(err); };

      const frame = document.getElementById("shortsVisualizerFrame");
      const send = () => frame.contentWindow.postMessage({
        type: "cdb-quick-audio",
        file: this.audioFile,
        title: item.hookText,
        clipStart: item.start,
        clipEnd: item.end,
        aspect: "9:16"
      }, "*");
      // Презареждаме iframe-а за всеки клип — гарантира чисто, свежо състояние
      // на визуализатора (без остатъчни clip/aspect стойности от предния клип).
      frame.onload = send;
      frame.src = "visualizer.html";
    });
  },

  _renderResults() {
    const wrap = document.getElementById("ssItemsWrap");
    wrap.innerHTML = this.items.map(it => {
      const url = URL.createObjectURL(it.videoBlob);
      return `
      <div class="card" style="margin-top:12px;" id="ssItem${it.index}">
        <strong>Short ${it.index + 1} · ${this._fmtTime(it.start)}–${this._fmtTime(it.end)}</strong>
        <video src="${url}" controls playsinline style="max-width:220px;width:100%;border-radius:10px;margin-top:8px;display:block;background:#000;"></video>
        <label style="margin-top:10px;">Заглавие</label>
        <input type="text" id="ssTitle${it.index}" value="${this._escAttr(it.title)}">
        <label style="margin-top:8px;">Описание</label>
        <textarea id="ssDesc${it.index}" style="min-height:110px;">${this._esc(it.description)}</textarea>
        <label style="margin-top:8px;">Тагове (запетая разделени)</label>
        <input type="text" id="ssTags${it.index}" value="${this._escAttr(it.tags.join(", "))}">
        <div id="ssItemUploadStatus${it.index}" class="muted" style="margin-top:8px;"></div>
      </div>`;
    }).join("");
  },

  _esc(s) { return (s || "").toString().replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); },
  _escAttr(s) { return this._esc(s).replace(/"/g, "&quot;"); },

  // Качва всички готови Shorts последователно в YouTube (unlisted, като
  // останалата част от dashboard-а). Продължава към следващия дори ако
  // един качване гръмне, за да не изгуби вече готовите останали.
  async uploadAll() {
    if (!this.items.length) return toast("Няма готови Shorts още");
    if (!Step4.accessToken) return toast("⚠️ Първо влез с Google бутона по-горе");
    const overall = document.getElementById("ssUploadOverallProgress");
    let okCount = 0;
    for (const it of this.items) {
      const statusEl = document.getElementById(`ssItemUploadStatus${it.index}`);
      if (overall) overall.textContent = `⏳ Качвам ${it.index + 1}/${this.items.length}...`;
      const title = document.getElementById(`ssTitle${it.index}`).value || it.title;
      const description = document.getElementById(`ssDesc${it.index}`).value || it.description;
      const tags = document.getElementById(`ssTags${it.index}`).value.split(",").map(s => s.trim()).filter(Boolean);
      const file = new File([it.videoBlob], it.fileName || `short_${it.index + 1}.webm`, { type: "video/webm" });
      try {
        const tempProgId = `ssUploadProgress${it.index}`;
        if (statusEl) statusEl.innerHTML = `<div id="${tempProgId}">⏳ Качвам...</div>`;
        const result = await Step4.uploadVideo(file, { title, description, tags, madeForKids: false }, tempProgId);
        okCount++;
        this.log(`✅ Short ${it.index + 1} качен (unlisted) — Video ID: ${result?.id || "?"}`);
      } catch (e) {
        this.log(`❌ Short ${it.index + 1} — грешка при качване: ${e.message}`);
        if (statusEl) statusEl.innerHTML = `❌ ${e.message}`;
      }
      // Кратка пауза между качванията — по-щадящо към YouTube API квотата.
      await new Promise(r => setTimeout(r, 1200));
    }
    if (overall) overall.textContent = `🎉 Готово — ${okCount}/${this.items.length} Shorts качени успешно.`;
    toast(`Качени ${okCount}/${this.items.length} Shorts`);
  }
};
