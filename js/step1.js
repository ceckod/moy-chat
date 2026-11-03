/* =========================================================
   STEP 1 — Ниша, Album Sprint, Концепция, Текст на песента
   (главният workflow за създаване на нова песен от нула)

   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, осма итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   AppState, Keys, Storage, GeminiValidator, LyricsHistory, ViralLab,
   callAI(), callGemini(), extractJson(), fetchTimeout(), toast(),
   NICHE_TOOLKIT_SCORES_KEY (от js/niche-toolkit.js).
   ========================================================= */
const Step1 = {
  // Главен бутон "🔍 Предложение за песен".
  // Ако textarea-та е празна → чете готовите daily trend данни от GitHub (безплатно, без Gemini).
  // Ако потребителят е въвел свои ниши → сравнява точно тях (Claude, старото поведение).
  async scanNiches() {
    const raw = document.getElementById("nicheInput").value.trim();
    if (raw) return this._scoreGivenNiches(raw.split("\n").map(s => s.trim()).filter(Boolean));
    return this._autoTrendScan();
  },

  // Чете data/trends-history.json от GitHub (пише го .github/workflows/daily-trends.yml,
  // веднъж на ден, през pytrends + YouTube Data API — БЕЗ Gemini, БЕЗ live-search квота).
  async _autoTrendScan() {
    const out = document.getElementById("nicheResults");
    out.innerHTML = "⏳ Зареждам вчерашния/днешния trend snapshot...";
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) {
      out.innerHTML = "⚠️ Нужен е GitHub Trend Tracker setup (Настройки → YouTube Тракер — същите ghOwner/ghRepo поля) " +
        "+ пуснат поне веднъж <code>daily-trends.yml</code> workflow (Actions таб → Run workflow).<br>" +
        "<span class='muted'>Дотогава: въведи 2-3 ниши ръчно в полето отгоре.</span>";
      return;
    }

    const branch = k.ghBranch || "main";
    const url = `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/trends-history.json`;
    try {
      const res = await fetchTimeout(url, {}, 15000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const snapshots = data.snapshots || [];
      if (!snapshots.length) {
        out.innerHTML = "⚠️ Файлът съществува, но е празен — workflow-ът още не се е пуснал. " +
          "Actions таб → \"Daily Music Trend Tracker\" → Run workflow (ръчно, за да не чакаш до утре).";
        return;
      }
      const latest = snapshots[snapshots.length - 1];
      const results = latest.niches || [];
      if (!results.length) {
        out.innerHTML = "⚠️ Последният snapshot няма ниши с пълни данни (Trends/YouTube грешка онзи ден). Пробвай ръчно въведени ниши.";
        return;
      }
      out.innerHTML = `<p class="muted">📅 Snapshot от ${latest.date} (обновява се веднъж на ден)</p>`;
      this._renderNicheResults(results, true);
    } catch (e) {
      out.innerHTML = "❌ " + e.message +
        "<br><span class='muted'>Провери дали repo-то е публично и daily-trends.yml вече е пускан поне веднъж. " +
        "Дотогава: въведи 2-3 ниши ръчно в полето отгоре и натисни бутона пак.</span>";
    }
  },

  // Старото поведение: потребителят подава списък сам, Claude ги оценява.
  async _scoreGivenNiches(niches) {
    document.getElementById("nicheResults").innerHTML = "⏳ Анализирам...";
    const prompt = `Ти си музикален A&R / SEO анализатор за 2026 година.
Дадени са следните музикални ниши/жанрове:
${niches.map((n, i) => `${i + 1}. ${n}`).join("\n")}

За всяка ниша дай:
- Score от 0 до 100 (комбинация от търсене и ниска конкуренция)
- Кратка причина (1 изречение)

Върни ЧИСТ JSON масив без обяснения, формат:
[{"niche":"...", "score":number, "reason":"..."}]`;

    try {
      const raw2 = await callAI(prompt, 600);
      const results = extractJson(raw2);
      results.sort((a, b) => b.score - a.score);
      this._renderNicheResults(results, false);
      GeminiValidator.autoReview("Стъпка 1 — Сравнение на ниши", JSON.stringify(results));
    } catch (e) {
      document.getElementById("nicheResults").innerHTML = "❌ " + e.message;
    }
  },

  async _renderNicheResults(results, fromTrendScan) {
    const best = results[0];
    AppState.data.project.niches = results;
    AppState.data.project.chosenNiche = best.niche;
    AppState.data.project.nicheScore = best.score;
    AppState.save();

    // Auto-capture: топ 3 ниши над 60/100 отиват в Idea Vault (само
    // добавка — не променя нищо от съществуващия рендър/логика по-долу).
    if (typeof IdeaVault !== "undefined") {
      results.filter(r => r.score >= 60).slice(0, 3).forEach(r => {
        IdeaVault.add({ text: r.niche, source: "Пазарен анализ", niche: r.niche, score: r.score });
      });
    }

    let html = fromTrendScan ? `<p class="muted">📈 Дневен trend snapshot (GitHub Actions, без Gemini)</p>` : "";
    const toolkitScores = Storage.get(NICHE_TOOLKIT_SCORES_KEY) || {};
    results.forEach(r => {
      const color = r.score > 75 ? "🟢" : r.score > 50 ? "🟡" : "⚪";
      const signals = (r.search_signal || r.competition_signal)
        ? `<br><span class="muted">Търсене: ${r.search_signal || "—"} · Конкуренция: ${r.competition_signal || "—"}</span>` : "";
      // Ако вече е пусната Niche Toolkit (Spotify) анализ за тази/подобна ниша,
      // показваме и нея веднага до собствения score — виж NicheToolkit.analyzeNiche().
      const nicheLower = r.niche.toLowerCase();
      const toolkitMatch = Object.entries(toolkitScores).find(([g]) => nicheLower.includes(g) || g.includes(nicheLower));
      const toolkitBadge = toolkitMatch
        ? `<br><span class="muted">🎯 Niche Toolkit (Spotify): ${toolkitMatch[1].score}/100</span>` : "";
      html += `<div class="copy-field"><span>${color} <strong>${r.niche}</strong> — ${r.score}/100<br><span class="muted">${r.reason}</span>${signals}${toolkitBadge}</span></div>`;
    });
    document.getElementById("nicheResults").innerHTML = html;
    this._renderDashNicheQuick(results);

    document.getElementById("conceptCard").style.display = "block";
    document.getElementById("nicheScore").value = best.score + "/100";

    if (best.score > 75) {
      toast(`🟢 Най-добра ниша: ${best.niche} (${best.score}/100)`);
    } else {
      toast(`Най-добър резултат ${best.score}/100 — под прага 75, но може да продължиш ръчно.`);
    }
    document.getElementById("albumSprintCard").style.display = "block";
    this.runOutlierScan(best.niche);
    this.runKeywordSuggest(best.niche);
    await this.generateConcept(best.niche);

    // Автопилот (опционален, изключен по подразбиране — виж Настройки → Предпочитания):
    // верижно продължава автоматично към текст на песента + Viral Lab анализ,
    // за да не чакаш ръчно всяка стъпка. Винаги ясно съобщено с toast.
    if (Prefs.data.autopilot) {
      toast("🤖 Автопилот: генерирам текст + Viral анализ автоматично...", 4000);
      await this.generateLyrics();
      await ViralLab.analyze();
    }
  },

  // Малка карта-версия на резултатите за Dashboard-а (Бърз изглед).
  _renderDashNicheQuick(results) {
    const el = document.getElementById("dashNicheQuick");
    if (!el) return;
    el.innerHTML = results.slice(0, 4).map(r => {
      const level = r.score > 75 ? ["🟢", "Висок потенциал"] : r.score > 50 ? ["🟡", "Среден потенциал"] : ["⚪", "Нисък потенциал"];
      return `<div class="card tight"><strong style="font-size:13px;">${r.niche}</strong>
        <p class="muted" style="margin:8px 0 0;">${level[0]} ${level[1]}</p></div>`;
    }).join("");
  },

  // VidIQ-стил "outlier" анализ: канали с малко абонати, но много гледания в тази ниша.
  async runOutlierScan(niche) {
    const el = document.getElementById("outlierResults");
    el.innerHTML = "⏳ Проверявам YouTube outliers (само скорошни видеа)...";
    try {
      const { outliers, totalChecked, windowDays, insufficientData } = await youtubeOutlierScan(niche);
      const windowNote = windowDays ? `последните ${windowDays} дни` : "скорошния период";
      if (!outliers.length) {
        const warn = insufficientData
          ? ` ⚠️ Малко скорошни видеа намерени за тази ниша — сигналът е слаб, не разчитай само на него.`
          : "";
        el.innerHTML = `<p class="muted">📊 Провери ${totalChecked} видеа за "${niche}" (${windowNote}) — няма ясни outliers.${warn}</p>`;
        return;
      }
      let html = `<strong style="font-size:13px;">📊 YouTube Outliers за "${niche}"</strong><p class="muted">Малки канали с видео, което расте непропорционално бързо ПРЯВО СЕГА (${windowNote}, ${totalChecked} видеа проверени):</p>`;
      if (insufficientData) {
        html += `<p class="muted">⚠️ Скорошните данни за тази ниша са оскъдни — третирай тези резултати с повишено внимание.</p>`;
      }
      outliers.forEach(o => {
        html += `<div class="copy-field"><span><strong>${o.channel}</strong> — ${o.views.toLocaleString()} views / ${o.subs.toLocaleString()} абонати (×${o.ratio.toFixed(1)}) · ${o.ageDays}д от публикуване · ~${o.velocity.toLocaleString()} views/ден<br><span class="muted">${o.title}</span></span></div>`;
      });
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<p class="muted">📊 Outlier анализ пропуснат: ${e.message}</p>`;
    }
  },

  // "Хората също търсят" — реални autocomplete предложения (нужен Proxy URL).
  async runKeywordSuggest(niche) {
    const el = document.getElementById("keywordSuggestOut");
    el.innerHTML = "⏳ Проверявам свързани търсения...";
    try {
      const suggestions = await keywordSuggest(niche);
      if (!suggestions.length) { el.innerHTML = ""; return; }
      el.innerHTML = `<strong style="font-size:13px;">🔎 Хората също търсят</strong>
        <div class="hashtags">${suggestions.map(s => `<span>${s}</span>`).join("")}</div>`;
    } catch (e) {
      el.innerHTML = `<p class="muted">🔎 Свързани търсения пропуснати: ${e.message}</p>`;
    }
  },

  // "Album Sprint" — 10-30 заглавия+hook идеи наведнъж в избраната ниша (batch мета-промптиране).
  async generateAlbumSprint() {
    const niche = AppState.data.project.chosenNiche || "modern pop";
    const count = document.getElementById("albumSprintCount").value;
    document.getElementById("albumSprintOut").innerHTML = "⏳ Генерирам...";
    const prompt = `За музикалната ниша "${niche}" генерирай ${count} РАЗЛИЧНИ концепции за песни.
За всяка концепция дай:
- title: кратко заглавие (до 3 думи)
- hook: 1 ред от потенциален chorus/hook, звучащ естествено за жанра
- mood: 2-3 думи атмосфера

Всички трябва да пасват на нишата, но да звучат различно едно от друго (не повтаряй теми).
Върни ЧИСТ JSON масив: [{"title":"...", "hook":"...", "mood":"..."}]`;
    try {
      const raw = await callAI(prompt, 2400);
      const list = extractJson(raw);
      AppState.data.project.albumSprint = list;
      AppState.save();
      this._renderAlbumSprint(list, null);
      GeminiValidator.autoReview("Стъпка 1 — Album Sprint", JSON.stringify(list));
      this._scoreAlbumSprint(list, niche);
    } catch (e) {
      document.getElementById("albumSprintOut").innerHTML = "❌ " + e.message;
    }
  },

  // Лек, бърз "quick score" (само по заглавие+hook+mood, без пълен текст) за ВСИЧКИ
  // идеи наведнъж — за да видиш кое си струва да напишеш преди да похарчиш
  // token-и/време за пълни текстове на слаби идеи.
  async _scoreAlbumSprint(list, niche) {
    const prompt = `Ти си A&R анализатор. Дадени са ${list.length} концепции за песни в жанр "${niche}"
(само заглавие+hook+mood, текстовете още не са написани). За всяка дай quick_score 0-100
(бърза прогноза за вирусен потенциал само на база тези 3 неща — hook сила, оригиналност, жанрово пасване).
${list.map((c, i) => `${i + 1}. "${c.title}" — "${c.hook}" (${c.mood})`).join("\n")}

Върни ЧИСТ JSON масив в СЪЩИЯ ред: [{"quick_score": number}]`;
    try {
      const raw = await callAI(prompt, 800);
      const scores = extractJson(raw);
      this._renderAlbumSprint(list, scores);
    } catch (e) {
      // Тихо пропускаме — списъкът вече е видим и без quick score.
    }
  },

  _renderAlbumSprint(list, scores) {
    const withScores = list.map((c, i) => ({ ...c, _i: i, quick_score: scores?.[i]?.quick_score ?? null }));
    if (scores) withScores.sort((a, b) => (b.quick_score ?? 0) - (a.quick_score ?? 0));
    let html = scores ? `<p class="muted">Сортирано по прогнозиран потенциал (само по идея, преди пълен текст):</p>` : "";
    withScores.forEach(c => {
      const badge = c.quick_score != null
        ? `<span class="chip ${c.quick_score > 75 ? "green" : c.quick_score > 50 ? "cyan" : "amber"}" style="margin-left:6px;">${c.quick_score}</span>`
        : "";
      html += `<div class="copy-field"><span><strong>${c.title}</strong>${badge} <span class="muted">(${c.mood})</span><br>"${c.hook}"</span>
        <button onclick="Step1.useAlbumIdea(${c._i})">➡️ Ползвай</button></div>`;
    });
    document.getElementById("albumSprintOut").innerHTML = html;
  },

  // Взима избрана идея от Album Sprint-а и я праща в основната концепция.
  useAlbumIdea(i) {
    const c = (AppState.data.project.albumSprint || [])[i];
    if (!c) return;
    document.getElementById("songTitle").value = c.title;
    AppState.data.project.title = c.title;
    AppState.save();
    toast(`Заглавие сменено на "${c.title}" — hook-а може да вкараш ръчно в текста`);
  },

  async generateConcept(niche) {
    const prompt = `За музикалната ниша "${niche}" за 2026 генерирай:
1. Кратко, запомнящо се заглавие на песен (на български или английски, каквото пасва на жанра)
2. Style Prompt за Suno AI (детайлен, максимум 200 символа, описващ звук/настроение/инструменти)
3. Точно 3 хаштага (с #, релевантни за YouTube/TikTok/Instagram)

Върни ЧИСТ JSON: {"title":"...", "style_prompt":"...", "hashtags":["#...","#...","#..."]}`;
    try {
      const raw = await callAI(prompt, 400);
      const c = extractJson(raw);
      // formatSunoStyleTags() (js/song-lab.js) — гаранция ≤190 символа
      // ДОРИ ако AI-ят игнорира "максимум 200 символа" инструкцията по-горе
      // (случва се особено на безплатни fallback модели) — виж коментара
      // на функцията за защо точно тук е правилното място за прилагане.
      const styleTags = formatSunoStyleTags(c.style_prompt);
      document.getElementById("songTitle").value = c.title;
      document.getElementById("stylePrompt").value = styleTags;
      document.getElementById("hashtagsOut").innerHTML = c.hashtags.map(h => `<span>${h}</span>`).join("");

      AppState.data.project.title = c.title;
      AppState.data.project.stylePrompt = styleTags;
      AppState.data.project.hashtags = c.hashtags;
      AppState.save();

      GeminiValidator.autoReview("Стъпка 1 — Концепция (заглавие/стил/хаштагове)", JSON.stringify(c));
    } catch (e) {
      toast("Грешка при генериране на концепция: " + e.message);
    }
  },

  // Поп-фолк/чалга иска ДРУГА структура от западния pop/hyperpop шаблон
  // по-долу (Chorus-first) — балканската чалга традиционно строи
  // напрежение постепенно (Куплет → Бридж → Припев), плюс задължителен
  // инструментален Kyuchek/Solo брейк, който няма аналог в западния поп.
  // Детекция по избраната ниша (chosenNiche) — покрива и кирилица, и
  // латиница, с/без интервал/тире между "поп" и "фолк".
  _CHALGA_NICHE_RE: /чалга|кючек|балкан|balkan|поп[\s-]?фолк|pop[\s-]?folk/i,

  _lyricsStructureBlock(niche, winningHook) {
    if (this._CHALGA_NICHE_RE.test(niche)) {
      return `ЗАДЪЛЖИТЕЛНА структура за поп-фолк/чалга (стриктен ред, точно тези мета-тагове, не разменяй последователността):
[Verse] → [Bridge] → [Chorus] → [Kyuchek/Solo] → [Outro]
- [Verse]: разгръща историята/темата, спокойно темпо
- [Bridge]: покачва напрежението, води директно към припева
- [Chorus]: най-запомнящата се, хук-ориентирана част — "мотото" на песента${winningHook ? `\n  (използвай ТОЧНО този ред като основен hook/първи ред: "${winningHook}")` : ""}
- [Kyuchek/Solo]: инструментален брейк с кючек ритъм — само кратки ад-либи тук, НЕ пълни вокални редове
- [Outro]: кратък финал, затваря темата
- Текстът да е готов за качване в Suno AI`;
    }
    return `ЗАДЪЛЖИТЕЛНО за структурата:
- [Chorus] секцията да е НАЙ-ОТПРЕД (преди първия куплет)
- Използвай ясни мета-тагове: [Chorus], [Verse], [Drop] (ако жанрът позволява drop)
- Текстът да е готов за качване в Suno AI${winningHook ? `\n- Използвай ТОЧНО този ред като основен hook/първи ред на [Chorus] (дошъл е от Hook Evolution Arena, тестван и избран): "${winningHook}"` : ""}`;
  },

  async generateLyrics() {
    const niche = AppState.data.project.chosenNiche || "modern pop";
    const title = AppState.data.project.title || "(без заглавие)";
    const winningHook = AppState.data.project.winningHook;
    const prompt = `Ти си опитен, издаван текстописец в жанр "${niche}", не AI асистент — пиши като човек,
който наистина е преживял темата, не като модел, който обобщава клишета.
Напиши текст на песен със заглавие "${title}".

${this._lyricsStructureBlock(niche, winningHook)}

ЗАДЪЛЖИТЕЛНО за стила (за да звучи човешки, не AI-генерирано):
- Конкретни, специфични образи и детайли (напр. "неотворено съобщение в 3 сутринта"),
  НЕ общи AI клишета от типа "electric nights", "whispers in the dark", "chasing dreams",
  "shine like stars", "unbreakable bond", "riding the wave" и подобни изтъркани фрази.
- Естествен, разговорен ритъм на фразите — избягвай прекалено "гладки"/симетрични
  редове, които звучат като генерирани по шаблон; леко несъвършена, жива фразировка е по-добра.
- Не повтаряй една и съща идея с различни думи между куплетите — всеки куплет да носи
  нова, конкретна информация/развитие, не просто вариация на припева.
- Без мета-коментари, обяснения или встъпителни изречения от типа "Ето текст на песен...".
Върни само текста с таговете, без допълнителни обяснения.`;
    LyricsHistory.push("Преди ново генериране");
    document.getElementById("lyricsOut").value = "⏳ Генерирам...";
    try {
      // forceFirst "claude" — за текст/лирика естествеността е приоритет №1,
      // затова винаги пробваме Claude първи тук (fallback синджирът към
      // Gemini/OpenRouter/Model Finder остава непроменен, ако Claude няма
      // ключ или гръмне грешка).
      const lyrics = await callAI(prompt, 1400, "claude");
      document.getElementById("lyricsOut").value = lyrics;
      AppState.data.project.lyrics = lyrics;
      AppState.save();

      GeminiValidator.autoReview("Стъпка 1 — Текст на песента", lyrics);
    } catch (e) {
      document.getElementById("lyricsOut").value = "";
      toast("Грешка: " + e.message);
    }
  },

  // Ръчно повторно/задълбочено валидиране на текста (по избор — авто-анализът вече тръгва сам).
  async validateWithGemini() {
    const lyrics = document.getElementById("lyricsOut").value;
    const niche = AppState.data.project.chosenNiche || "";
    if (!lyrics.trim()) return toast("Първо генерирай текст на песента");
    const prompt = `Анализирай следния текст на песен за жанр "${niche}".
Дай честна, кратка оценка (5-8 изречения) на:
- качеството и логиката на римите
- дали пасва на жанра
- структурата (има ли ясен Chorus/Verse/Drop)
Текст:
${lyrics}`;
    try {
      const review = await callGemini(prompt);
      GeminiValidator._log("Стъпка 1 — Ръчна проверка на текста", review);
      AppState.data.project.geminiReview = review;
      AppState.save();
    } catch (e) {
      GeminiValidator._log("Стъпка 1 — Ръчна проверка", "❌ " + e.message);
    }
  }
};
