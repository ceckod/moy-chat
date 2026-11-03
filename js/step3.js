/* =========================================================
   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, седма итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   AppState, Keys, callAI(), callGemini(), extractJson(), fetchTimeout(),
   proxied(), GeminiValidator, toast().
   ========================================================= */
/* =========================================================
   STEP 3 — DistroKid & Обложка
   ========================================================= */
const Step3 = {
  async generateCoverPrompt() {
    const title = AppState.data.project.title || "untitled";
    const niche = AppState.data.project.chosenNiche || "pop";
    const prompt = `Създай детайлен визуален промпт (на английски, за Imagen/Flow Music AI) за квадратна
обложка на песен (3000x3000px, streaming cover art) със заглавие "${title}" в жанр "${niche}".
Опиши стил, цветова палитра, композиция, настроение. Максимум 4-5 изречения, само промпта.`;
    document.getElementById("coverPromptOut").value = "⏳ Генерирам...";
    try {
      const p = await callAI(prompt, 300);
      document.getElementById("coverPromptOut").value = p;
      AppState.data.project.coverPrompt = p;
      AppState.save();

      GeminiValidator.autoReview("Стъпка 3 — Промпт за обложка", p);
    } catch (e) {
      document.getElementById("coverPromptOut").value = "";
      toast("Грешка: " + e.message);
    }
  },

  // Генерира обложка. Ако има Gemini/Imagen ключ, пробва него първи
  // (обикновено по-високо качество); ако няма ключ ИЛИ Gemini гръмне
  // грешка, автоматично пада на Cloudflare Workers AI (FLUX) — безплатно
  // (10 000 neuroni/ден), нужни са само cfApiToken+cfAccountId в Настройки.
  async generateCoverImage() {
    const prompt = document.getElementById("coverPromptOut").value.trim();
    if (!prompt) return toast("Първо генерирай визуалния промпт");
    const k = Keys.load();

    document.getElementById("coverImgOut").innerHTML = "⏳ Генерирам обложка...";

    if (k.gemini) {
      try {
        const imgUrl = await this._generateCoverImageGemini(prompt, k.gemini);
        document.getElementById("coverImgOut").innerHTML = `<img src="${imgUrl}" style="max-width:300px;border-radius:8px;"><div class="muted" style="margin-top:4px;">Генерирано с Gemini/Imagen</div>`;
        AppState.data.project.coverImageUrl = imgUrl;
        AppState.save();
        return;
      } catch (e) {
        toast(`⚠️ Gemini/Imagen гръмна (${e.message}) — превключвам на безплатния Cloudflare...`, 4000);
      }
    }

    try {
      const imgUrl = await this._generateCoverImageCloudflare(prompt, k.cfApiToken, k.cfAccountId);
      document.getElementById("coverImgOut").innerHTML = `<img src="${imgUrl}" style="max-width:300px;border-radius:8px;"><div class="muted" style="margin-top:4px;">🆓 Генерирано безплатно (Cloudflare FLUX)</div>`;
      AppState.data.project.coverImageUrl = imgUrl;
      AppState.save();
    } catch (e) {
      document.getElementById("coverImgOut").innerHTML = `❌ ${e.message}`;
    }
  },

  async _generateCoverImageGemini(prompt, geminiKey) {
    // ЗАБЕЛЕЖКА: Точният endpoint/модел за Imagen генериране на изображения
    // през Gemini API може да варира — провери актуалното име на модела
    // в Google AI Studio (напр. модел с "image-generation" в името).
    // ВАЖНО: не добавяме "Square album cover art..." пред промпта на
    // потребителя — ако той иска нещо друго (лого, банер и т.н.), а не
    // "обложка на албум", добавеният контекст само конкурира с исканото.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${geminiKey}`;
    const res = await fetchTimeout(proxied(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt}, square 1:1 composition, high resolution` }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      })
    }, 60000); // image generation отнема по-дълго
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const imgPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imgPart) throw new Error("Моделът не върна изображение — провери името на модела в Настройки/документацията.");
    return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
  },

  // Директна извиквка към безплатния провайдър (виж providers/cloudflare-image.js —
  // Cloudflare Workers AI, FLUX-1-schnell, 10 000 neuroni/ден безплатно).
  // Резултатът е data: URL — същия формат, който Step3 вече пази
  // в AppState.project.coverImageUrl от Gemini/Imagen пътя.
  //
  // ВАЖНО: тук НЕ добавяме предефиниращ текст като "Square album cover
  // art" пред промпта на потребителя — ако той иска "3d logo cd-b
  // records", а не "обложка на албум", добавен чужд контекст само
  // обърква/конкурира модела с точно това, което е поискал. Добавяме
  // САМО технически quality-суфикс накрая, който не променя СЪДЪРЖАНИЕТО.
  async _generateCoverImageCloudflare(prompt, cfApiToken, cfAccountId) {
    return generateCoverImage(
      `${prompt}, high quality, high resolution, sharp focus`,
      { width: 1024, height: 1024 },
      cfApiToken, cfAccountId,
      (stage) => {
        if (stage === "cloudflare-failed") toast("⚠️ Cloudflare не се справи — пробвам безплатния Pollinations...", 3000);
        if (stage === "pollinations-failed") toast("⚠️ И Pollinations е претоварен — показвам placeholder, пробвай пак след малко", 4000);
      }
    );
  },

  // Бутон "🆓 Безплатна обложка" — прескача Gemini директно, дори да има ключ
  // (напр. когато потребителят иска да пести Gemini квотата за нещо друго).
  async generateCoverImageFree() {
    const prompt = document.getElementById("coverPromptOut").value.trim();
    if (!prompt) return toast("Първо генерирай визуалния промпт");
    const k = Keys.load();
    if (!k.cfApiToken || !k.cfAccountId) {
      return toast("Нужни са безплатни Cloudflare ключове — Настройки → AI Model Finder → Ключове.", 5000);
    }
    document.getElementById("coverImgOut").innerHTML = "⏳ Генерирам безплатна обложка (Cloudflare FLUX)...";
    try {
      const imgUrl = await this._generateCoverImageCloudflare(prompt, k.cfApiToken, k.cfAccountId);
      document.getElementById("coverImgOut").innerHTML = `<img src="${imgUrl}" style="max-width:300px;border-radius:8px;"><div class="muted" style="margin-top:4px;">🆓 Генерирано безплатно (Cloudflare FLUX)</div>`;
      AppState.data.project.coverImageUrl = imgUrl;
      AppState.save();
    } catch (e) {
      document.getElementById("coverImgOut").innerHTML = `❌ ${e.message}`;
    }
  },

  // 16 — AI Демо мелодия (MusicGen през Hugging Face, безплатно) —
  // кратък инструментален откъс (~15 сек) по жанра/концепцията на песента,
  // за бърза идея/референция. Само инструментал, без вокали — виж
  // providers/musicgen.js за реалните ограничения на безплатния tier.
  async generateDemoMelody() {
    const p = AppState.data.project;
    const genre = p.chosenNiche || "pop";
    const mood = p.viralReport?.emotional_impact?.summary || "";
    const k = Keys.load();
    const el = document.getElementById("demoMelodyOut");
    if (!k.hfApiKey) {
      el.innerHTML = "⚠️ Нужен е безплатен Hugging Face API токен — Настройки → AI Model Finder → Ключове (huggingface.co/settings/tokens).";
      return;
    }
    const prompt = `${genre} instrumental${mood ? ", mood: " + mood : ""}, high quality studio production`;
    el.innerHTML = "⏳ Генерирам демо мелодия (може да отнеме до 1 мин при първо ползване)...";
    try {
      const audioUrl = await musicGenAsync(prompt, k.hfApiKey);
      el.innerHTML = `<audio controls src="${audioUrl}" style="width:100%;margin-top:6px;"></audio><div class="muted" style="margin-top:4px;">🆓 MusicGen (Hugging Face) — инструментал, ~15 сек, само за идея/референция</div>`;
    } catch (e) {
      el.innerHTML = `❌ ${e.message}`;
    }
  },

  // Трета опция: 100% code-генерирано 3D текстово лого (Canvas, БЕЗ AI —
  // виж js/providers/code-logo.js). Гарантирано изписва ТОЧНО текста,
  // който е въведен, консистентно при всяко натискане (за разлика от AI
  // генерирането, което винаги е приблизително за конкретен текст).
  generateCoverImageCodeLogo() {
    const text = (document.getElementById("codeLogoText")?.value || "").trim();
    if (!text) return toast("Въведи текст за логото (напр. CD-B Records)");
    const subtitle = (document.getElementById("codeLogoSubtitle")?.value || "").trim();
    try {
      const imgUrl = renderCodeLogo(text, { subtitle });
      document.getElementById("coverImgOut").innerHTML = `<img src="${imgUrl}" style="max-width:300px;border-radius:8px;"><div class="muted" style="margin-top:4px;">🔤 Код-генерирано лого (гарантиран точен текст, без AI)</div>`;
      AppState.data.project.coverImageUrl = imgUrl;
      AppState.save();
    } catch (e) {
      document.getElementById("coverImgOut").innerHTML = `❌ ${e.message}`;
    }
  },

  buildDistrokidFields() {
    const p = AppState.data.project;
    const fields = [
      { label: "Заглавие", value: p.title || "" },
      { label: "Изпълнител", value: "CD-B Records" },
      { label: "Жанр", value: p.chosenNiche || "" },
      { label: "Цена", value: "$5.99" },
      { label: "AI отметки", value: "✅ Съдържа AI-генерирана музика / текст" },
      { label: "Хаштагове", value: (p.hashtags || []).join(" ") },
    ];
    let html = "";
    fields.forEach((f, i) => {
      html += `<label>${f.label}</label>
        <div class="copy-field">
          <span id="dk-field-${i}">${f.value || "(няма данни — попълни Стъпка 1)"}</span>
          <button onclick="Step3.copyField(${i})">📋 Copy</button>
        </div>`;
    });
    document.getElementById("distrokidFields").innerHTML = html;
    AppState.data.project.distrokid = fields;
    AppState.save();
  },

  copyField(i) {
    const text = document.getElementById(`dk-field-${i}`).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Копирано ✅"));
  },

  // 12 — Spotify for Artists / Apple Music for Artists готови текстове
  async generateSpotifyAppleText() {
    const p = AppState.data.project;
    if (!p.title) return toast("Първо генерирай концепция в Стъпка 1");
    const el = document.getElementById("spotifyAppleOut");
    el.innerHTML = "⏳ Генерирам...";
    // т.17.08.2026 бъгфикс: описанията се генерираха винаги на български
    // (езика на самия промпт), независимо на какъв език е песента. Тук
    // няма изричен language field (за разлика от вече публикувани песни
    // в catalog.json) — вадим hint директно от текста на песента.
    const langHint = p.lyrics
      ? `\nЕЗИК: генерирай ги на СЪЩИЯ език като текста на песента (виж откъс по-долу за разпознаване) — НЕ превеждай на български по подразбиране, освен ако песента самата е на български.\nОткъс от текста: "${p.lyrics.slice(0, 200).replace(/\n/g, " ")}"`
      : "";
    const prompt = `За песен със заглавие "${p.title}" в жанр "${p.chosenNiche || "pop"}", генерирай:
- spotify_bio: кратко Spotify for Artists "Pitch to editors" описание (до 500 знака) — какво прави песента специална, звучене, настроение.
- apple_bio: кратко Apple Music for Artists описание на пускането (до 400 знака), малко по-формален тон.
- release_note: 1-2 изречения "бележка към феновете" за социалните мрежи.${langHint}
Върни ЧИСТ JSON: {"spotify_bio":"...", "apple_bio":"...", "release_note":"..."}`;
    try {
      const raw = await callAI(prompt, 500);
      const c = extractJson(raw);
      AppState.data.project.spotifyAppleText = c;
      AppState.save();
      el.innerHTML = `
        <label style="margin-top:0;">🎵 Spotify for Artists</label>
        <div class="copy-field"><span id="sa-0">${c.spotify_bio}</span><button onclick="Step3._copySA(0)">📋</button></div>
        <label>🍏 Apple Music for Artists</label>
        <div class="copy-field"><span id="sa-1">${c.apple_bio}</span><button onclick="Step3._copySA(1)">📋</button></div>
        <label>💬 Бележка към феновете</label>
        <div class="copy-field"><span id="sa-2">${c.release_note}</span><button onclick="Step3._copySA(2)">📋</button></div>`;
      GeminiValidator.autoReview("Стъпка 3 — Spotify/Apple текстове", JSON.stringify(c));
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  },
  _copySA(i) {
    const text = document.getElementById(`sa-${i}`).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Копирано ✅"));
  },

  // 13 — YouTube A/B заглавия + thumbnail текст, с кратък Gemini "глас" кой е по-clickable
  async generateABTitles() {
    const p = AppState.data.project;
    if (!p.title) return toast("Първо генерирай концепция в Стъпка 1");
    const el = document.getElementById("abTitlesOut");
    el.innerHTML = "⏳ Генерирам...";
    const langHint = p.lyrics
      ? `\nЕЗИК: title и thumbnail_text на СЪЩИЯ език като текста на песента (откъс за разпознаване: "${p.lyrics.slice(0, 150).replace(/\n/g, " ")}") — НЕ превеждай на български по подразбиране.`
      : "";
    const prompt = `За песен "${p.title}" в жанр "${p.chosenNiche || "pop"}", генерирай 3 РАЗЛИЧНИ YouTube A/B варианта:
За всеки: title (до 60 символа, clickable но не clickbait), thumbnail_text (2-4 думи за thumbnail overlay).${langHint}
Върни ЧИСТ JSON масив: [{"title":"...", "thumbnail_text":"..."}]`;
    try {
      const raw = await callAI(prompt, 500);
      const variants = extractJson(raw);
      AppState.data.project.abTitles = variants;
      AppState.save();
      let html = variants.map((v, i) =>
        `<div class="copy-field"><span><strong>Вариант ${i + 1}:</strong> ${v.title}<br><span class="muted">Thumbnail: "${v.thumbnail_text}"</span></span>
          <button onclick="Step3._useTitle(${i})">➡️ Ползвай</button></div>`).join("");
      el.innerHTML = html + `<div id="abVoteOut" class="muted" style="margin-top:10px;">⏳ Gemini преценява кой е по-clickable...</div>`;

      GeminiValidator.autoReview("Стъпка 3 — YouTube A/B заглавия", JSON.stringify(variants));

      // Кратък отделен Gemini "глас" кой вариант е по-clickable
      const votePrompt = `Кой от следните 3 YouTube заглавия за песен в жанр "${p.chosenNiche || "pop"}" е най-вероятно да получи най-много кликове, и защо?
${variants.map((v, i) => `${i + 1}. "${v.title}"`).join("\n")}
Отговори с 2 изречения максимум — посочи номер и кратка причина.`;
      const vote = await callGemini(votePrompt);
      document.getElementById("abVoteOut").innerHTML = "🤖 <strong>Gemini глас:</strong> " + vote;
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  },
  _useTitle(i) {
    const v = (AppState.data.project.abTitles || [])[i];
    if (!v) return;
    document.getElementById("ytTitle").value = v.title;
    toast(`YouTube заглавие сменено на Вариант ${i + 1}`);
  },

  // 15 — Short-Form Viral Scripting Engine: НЕ песенния hook, а визуален/
  // текстов hook за 15-30 сек TikTok/Reels/Shorts клип, за да превърне
  // готовото аудио в промо видео идея (POV / behind-the-scenes / visual hook).
  async generateShortFormScripts() {
    const p = AppState.data.project;
    if (!p.title) return toast("Първо генерирай концепция в Стъпка 1");
    const el = document.getElementById("shortFormScriptsOut");
    el.innerHTML = "⏳ Генерирам сценарии...";
    // Взимаме emotional context от вече наличен Viral Lab доклад (ако има),
    // иначе просто жанр+заглавие — не дублира самия текст на песента.
    const emotionHint = p.viralReport?.emotional_impact?.summary
      || p.viralReport?.chorus_analysis?.summary
      || "";
    const chorusLine = (p.lyrics || "").split("\n").find(l => l.trim().length > 0) || "";
    const langHint = p.lyrics
      ? `\nЕЗИК: caption текстовете на СЪЩИЯ език като текста на песента (откъс: "${p.lyrics.slice(0, 150).replace(/\n/g, " ")}") — НЕ превеждай на български по подразбиране; hashtags могат да останат смесени/на английски за discoverability.`
      : "";
    const prompt = `За песен "${p.title}" в жанр "${p.chosenNiche || "pop"}"${emotionHint ? `, емоционален тон: ${emotionHint}` : ""}, генерирай 3 РАЗЛИЧНИ кратки видео сценария (15-30 сек, за TikTok/Reels/YouTube Shorts) за ПРОМОТИРАНЕ на песента — не текста на самата песен.
Всеки сценарий трябва да е различен формат: 1) POV сценарий, 2) Behind-the-scenes/студио момент, 3) чист visual hook (силен кадър/текст overlay в първите 2 секунди).
За всеки: format (кратко име), hook_line (какво се случва/пише се на екрана в първите 2 секунди — критично за задържане на вниманието), beats (масив от 3-4 кратки визуални стъпки/кадъра по време на клипа), caption (готов социален caption текст), hashtags (масив от 4-5 хаштага).${langHint}
Върни ЧИСТ JSON масив: [{"format":"...", "hook_line":"...", "beats":["...","..."], "caption":"...", "hashtags":["...","..."]}]`;
    try {
      const raw = await callAI(prompt, 1000);
      const scripts = extractJson(raw);
      AppState.data.project.shortFormScripts = scripts;
      AppState.save();
      el.innerHTML = scripts.map((s, i) => `
        <div class="card tight" style="margin-top:${i === 0 ? 0 : 10}px;">
          <strong>🎬 ${s.format}</strong>
          <p style="margin-top:6px;"><strong>Първите 2 сек:</strong> ${s.hook_line}</p>
          <ol style="margin:8px 0 0 18px;padding:0;font-size:13px;">${(s.beats || []).map(b => `<li>${b}</li>`).join("")}</ol>
          <div class="copy-field" style="margin-top:8px;"><span id="sfs-cap-${i}">${s.caption}</span><button onclick="Step3._copyShortForm(${i}, 'caption')">📋</button></div>
          <div class="copy-field" style="margin-top:6px;"><span id="sfs-tags-${i}">${(s.hashtags || []).join(" ")}</span><button onclick="Step3._copyShortForm(${i}, 'hashtags')">📋</button></div>
        </div>`).join("");
      GeminiValidator.autoReview("Стъпка 3 — Short-form видео сценарии", JSON.stringify(scripts));
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  },
  _copyShortForm(i, field) {
    const id = field === "caption" ? `sfs-cap-${i}` : `sfs-tags-${i}`;
    const text = document.getElementById(id).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Копирано ✅"));
  },

  // 14 — Бърза проверка за прилика със съществуваща песен (YouTube search)
  async checkSimilarity() {
    const title = document.getElementById("songTitle")?.value || AppState.data.project.title;
    if (!title) return toast("Първо генерирай заглавие в Стъпка 1");
    const k = Keys.load();
    const el = document.getElementById("similarityOut");
    if (!k.ytApiKey) { el.innerHTML = "⚠️ Нужен е YouTube Data API Key (Настройки → API Ключове)"; return; }
    el.innerHTML = "⏳ Проверявам...";
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(title)}&key=${k.ytApiKey}`;
      const res = await fetchTimeout(proxied(url));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) { el.innerHTML = "✅ Не намерих близки съвпадения — заглавието изглежда свободно."; return; }

      const norm = s => s.toLowerCase().replace(/[^a-zа-я0-9]/gi, "");
      const exact = items.some(i => norm(i.snippet.title) === norm(title));
      const chipHtml = exact
        ? `<span class="chip red">⚠️ Точно съвпадение намерено</span>`
        : `<span class="chip amber">Близки резултати — прегледай ръчно</span>`;

      let html = chipHtml + items.map(i =>
        `<div class="copy-field"><span><strong>${i.snippet.title}</strong><br><span class="muted">${i.snippet.channelTitle}</span></span></div>`).join("");
      el.innerHTML = html;
      GeminiValidator.autoReview("Стъпка 3 — Проверка за прилика", `Заглавие: "${title}". Точно съвпадение: ${exact}. Топ резултат: "${items[0].snippet.title}"`);
    } catch (e) {
      el.innerHTML = "❌ " + e.message;
    }
  }
};
