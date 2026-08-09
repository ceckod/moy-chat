/* =========================================================
   VIRAL LAB — AI Music Producer
   (ViralLab + HookArena + GhostAudience — трите обединени в
   един файл, тъй като са тясно свързани модули от една и съща
   feature area: анализ на вирусен потенциал, hook evolution и
   симулация на фокус-група)

   Преместени 1:1 от app.js (продължение на "новата стъпка"
   след Стъпка 8 — девета итерация) — логиката не е променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ
   ниво в самите обекти, значи редът на <script> таговете не е
   критичен, но е поставен преди js/step1.js, тъй като Step1
   извиква ViralLab.analyze()):
   AppState, GeminiValidator, LyricsHistory, callAI(),
   extractJson(), toast().
   ========================================================= */

const ViralLab = {
  // Едно голямо структурирано Claude извикване вместо 8 отделни —
  // по-бързо, по-евтино (по-малко round-trips) и лесно за поддръжка.
  // forceRefresh=true игнорира кеша (бутон "🔄 Презареди анализа").
  async analyze(forceRefresh = false) {
    const p = AppState.data.project;
    const lyrics = (document.getElementById("lyricsOut")?.value || p.lyrics || "").trim();
    if (!lyrics) return toast("Първо генерирай текст на песента (по-горе)");

    const niche = p.chosenNiche || "modern pop";
    const title = p.title || "(без заглавие)";
    const out = document.getElementById("viralLabOut");

    // Кешираме по хеш на реалните входни данни — ако текстът/заглавието/нишата
    // не са се променили от последния анализ, връщаме готовия резултат вместо
    // да хабим API квота за идентична заявка.
    const cacheInputs = { lyrics, niche, title, nicheScore: p.nicheScore };
    if (!forceRefresh) {
      const cached = AICache.get("viralLab", cacheInputs);
      if (cached) {
        AppState.data.project.viralReport = cached;
        AppState.save();
        this.render(cached);
        toast("♻️ Показвам кеширан анализ (текстът не се е променил) — 🔄 Презареди за нов", 4000);
        return;
      }
    }

    // Реални пазарни сигнали, които вече имаме от Стъпка 1 (trend snapshot /
    // niche score) — подаваме ги на Claude вместо да гадае от нулата.
    const nicheRow = (p.niches || []).find(n => n.niche === niche) || {};
    const marketContext = `Niche score (0-100, от дневния trend snapshot / SEO анализ): ${p.nicheScore ?? "няма данни"}
Search signal: ${nicheRow.search_signal || "няма данни"}
Competition signal: ${nicheRow.competition_signal || "няма данни"}`;

    out.innerHTML = `<p class="muted">⏳ AI Producer анализира песента (Viral Score, hook, chorus, структура, жанр, конкуренция, review)...</p>`;

    // Жанрово заземяване: реални заглавия на топ видеа в нишата (ако има YouTube ключ),
    // за да не гадае Claude BPM/теми само от тренировъчните си данни.
    const topTitles = await youtubeTopTitles(niche);
    const genreGrounding = topTitles.length
      ? `\nРЕАЛНИ ЗАГЛАВИЯ НА ВИДЕА, КОИТО РЕАЛНО НАБИРАТ ИНЕРЦИЯ В НИШАТА "${niche}" ТОЧНО СЕГА (YouTube, последните месеци, сортирани по темп на растеж — не стари all-time хитове), използвай ги като реален контекст за genre_check, не гадай:\n${topTitles.map(t => `- ${t}`).join("\n")}\n`
      : "";

    // Обратна връзка от Track Record: последните песни, за които вече знаем
    // реалния резултат на канала — за да се калибрира прогнозата спрямо
    // действителността, а не да гадае "на сляпо" всеки път.
    const calibrationContext = TrackRecord.getCalibrationContext();

    const prompt = `Ти си AI музикален продуцент, A&R анализатор и маркетинг стратег за 2026 година.
Анализирай следната песен КАТО ЦЯЛОСТЕН ПРОДУКТ (не само текста) — вземи предвид жанра, заглавието
и реалните пазарни сигнали по-долу. Бъди честен и критичен, не завишавай оценки без основание.

ЗАГЛАВИЕ: ${title}
ЖАНР/НИША: ${niche}

ПАЗАРЕН КОНТЕКСТ:
${marketContext}

ТЕКСТ НА ПЕСЕНТА:
---
${lyrics}
---
${genreGrounding}${calibrationContext}
Върни ЧИСТ JSON (без markdown, без обяснения извън JSON) с ТОЧНО тази структура:
{
  "viral_score": number (0-100, претеглена комбинация: Trend Momentum 30%, Search Volume 20%, Music Competition 15%, Audience Match 15%, Emotional Impact 10%, TikTok Potential 10% — изчисли реално претеглената стойност),
  "breakdown": {
    "trend_momentum": number (0-100),
    "search_volume": number (0-100),
    "competition": number (0-100, по-високо = по-слаба конкуренция/по-добра позиция),
    "audience_match": number (0-100),
    "emotional_impact": number (0-100),
    "tiktok_potential": number (0-100)
  },
  "predictions": {
    "attention_chance": number (0-100, % шанс да привлече внимание),
    "shorts_fit": number (0-100, % колко е добра за YouTube Shorts),
    "tiktok_sound_chance": number (0-100, % шанс да стане TikTok звук),
    "youtube_ctr_chance": number (0-100, % шанс за висок CTR в YouTube)
  },
  "lyrics_analysis": {
    "hook_strength": number (0-100),
    "memorability": number (0-100),
    "repeatability": number (0-100),
    "emotional_intensity": number (0-100),
    "singability": number (0-100),
    "rhyme_quality": number (0-100),
    "simplicity": number (0-100)
  },
  "chorus": {
    "text": "извлеченият припев от текста, дословно (или '(няма ясен [Chorus] таг)')",
    "has_repeating_hook": boolean,
    "word_count": number,
    "memorability": number (0-100),
    "fits_15_30s_clip": boolean,
    "notes": "1-2 изречения защо"
  },
  "structure": {
    "expected_for_genre": ["Intro","Verse","Pre-Chorus","Chorus","Verse","Bridge","Final Chorus"] (адаптирай реално за жанра, не копирай сляпо),
    "detected_in_lyrics": ["...секциите, които реално откри по [таговете] в текста..."],
    "fits_genre": boolean,
    "notes": "1-2 изречения препоръка"
  },
  "genre_check": {
    "typical_bpm": [number, number, number] (типични BPM за жанра),
    "common_themes": ["...", "...", "...", "..."] (най-чести теми в жанра),
    "alignment_notes": "доколко темата/лириката на тази песен пасва на очакванията на аудиторията в жанра — 1-2 изречения"
  },
  "competition_advice": ["конкретна препоръка 1", "конкретна препоръка 2", "конкретна препоръка 3"] (действия, не статистика — напр. смяна на гледна точка, по-кратък припев, по-силен първи ред и т.н., съобразени с competition signal-а по-горе),
  "ai_review": {
    "stars": number (1-5, може с .5),
    "pros": ["плюс 1", "плюс 2", "плюс 3"],
    "cons": ["минус 1", "минус 2"]
  },
  "weak_sections": [
    {"section": "напр. Verse 2 / Chorus / Bridge — конкретна секция от ТОЗИ текст", "score": number (0-10), "reason": "защо е слаба, 1 изречение"}
  ] (0-3 елемента; само реално слаби секции, ако всичко е силно — празен масив)
}`;

    try {
      const raw = await callAI(prompt, 3200);
      const r = extractJson(raw);
      AICache.set("viralLab", cacheInputs, r);
      AppState.data.project.viralReport = r;
      AppState.save();
      this.render(r);
      TrackRecord.save(r);
      GeminiValidator.autoReview("Стъпка 1 — Viral Lab анализ", JSON.stringify(r.breakdown) + " | Score: " + r.viral_score);
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ Грешка при анализ: ${e.message}</p>`;
    }
  },

  _bar(label, val) {
    return `<div class="vbar-row">
      <div class="lbl"><span>${label}</span><span>${val}</span></div>
      <div class="vbar-track"><div class="vbar-fill" style="width:${Math.max(0, Math.min(100, val))}%;"></div></div>
    </div>`;
  },

  _stars(n) {
    const full = Math.floor(n), half = n % 1 >= 0.5;
    let s = "★".repeat(full);
    if (half) s += "⯨";
    s += "☆".repeat(Math.max(0, 5 - full - (half ? 1 : 0)));
    return s;
  },

  render(r) {
    const out = document.getElementById("viralLabOut");
    const b = r.breakdown || {}, pr = r.predictions || {}, la = r.lyrics_analysis || {};
    const ch = r.chorus || {}, st = r.structure || {}, gc = r.genre_check || {};
    const score = Math.round(r.viral_score || 0);
    const scoreColor = score >= 75 ? "var(--green)" : score >= 50 ? "var(--amber)" : "var(--red)";

    let html = `
      <div class="vscore-hero">
        <div class="vscore-ring" style="--pct:${score};">
          <div class="v" style="color:${scoreColor};">${score}<small>VIRAL SCORE</small></div>
        </div>
        <div class="vscore-meta">
          <strong>Overall Viral Score</strong>
          <p class="muted">Претеглена комбинация от 6 фактора (Trend 30% · Search 20% · Competition 15% · Audience 15% · Emotion 10% · TikTok 10%).</p>
        </div>
      </div>

      ${this._bar("📈 Trend Momentum", b.trend_momentum ?? 0)}
      ${this._bar("🔍 Search Volume", b.search_volume ?? 0)}
      ${this._bar("🎵 Music Competition", b.competition ?? 0)}
      ${this._bar("🎯 Audience Match", b.audience_match ?? 0)}
      ${this._bar("💬 Emotional Impact", b.emotional_impact ?? 0)}
      ${this._bar("📱 TikTok Potential", b.tiktok_potential ?? 0)}

      <div class="vpred-grid">
        <div class="vpred-item"><div class="pv">${pr.attention_chance ?? "—"}%</div><div class="pl">⭐ Шанс да привлече внимание</div></div>
        <div class="vpred-item"><div class="pv">${pr.shorts_fit ?? "—"}%</div><div class="pl">⭐ Добра за YouTube Shorts</div></div>
        <div class="vpred-item"><div class="pv">${pr.tiktok_sound_chance ?? "—"}%</div><div class="pl">⭐ Шанс да стане TikTok звук</div></div>
        <div class="vpred-item"><div class="pv">${pr.youtube_ctr_chance ?? "—"}%</div><div class="pl">⭐ Висок CTR в YouTube</div></div>
      </div>

      <div class="section-title" style="margin:20px 0 8px;">✍️ Анализ на текста</div>
      ${this._bar("Hook Strength", la.hook_strength ?? 0)}
      ${this._bar("Memorability", la.memorability ?? 0)}
      ${this._bar("Repeatability", la.repeatability ?? 0)}
      ${this._bar("Emotional Intensity", la.emotional_intensity ?? 0)}
      ${this._bar("Singability", la.singability ?? 0)}
      ${this._bar("Rhyme Quality", la.rhyme_quality ?? 0)}
      ${this._bar("Simplicity", la.simplicity ?? 0)}

      <div class="section-title" style="margin:20px 0 8px;">🎤 Анализ на припева (Chorus)</div>
      <div class="copy-field"><span><em>"${ch.text || "—"}"</em></span></div>
      <p class="muted" style="margin:8px 0 0;">
        ${ch.has_repeating_hook ? "✅" : "⚠️"} Повтарящ се hook ·
        ${ch.word_count ?? "—"} думи ·
        Memorability ${ch.memorability ?? "—"}/100 ·
        ${ch.fits_15_30s_clip ? "✅ Пасва на 15-30с клипове" : "⚠️ Не е идеален за кратки клипове"}
      </p>
      <p class="muted">${ch.notes || ""}</p>

      <div class="section-title" style="margin:20px 0 8px;">🧱 Структура</div>
      <p class="muted">Очаквана за жанра: ${(st.expected_for_genre || []).join(" → ") || "—"}</p>
      <p class="muted">Открита в текста: ${(st.detected_in_lyrics || []).join(" → ") || "—"}</p>
      <p>${st.fits_genre ? "🟢 Структурата пасва на жанра" : "🟡 Структурата не пасва напълно"} — ${st.notes || ""}</p>

      <div class="section-title" style="margin:20px 0 8px;">🎯 Жанрова проверка</div>
      <p class="muted">Типични BPM за "${AppState.data.project.chosenNiche || ""}": <strong>${(gc.typical_bpm || []).join(" / ") || "—"}</strong></p>
      <div class="hashtags">${(gc.common_themes || []).map(t => `<span>${t}</span>`).join("")}</div>
      <p class="muted" style="margin-top:8px;">${gc.alignment_notes || ""}</p>

      <div class="section-title" style="margin:20px 0 8px;">🏁 Анализ на конкуренцията</div>
      <ul class="vlist">${(r.competition_advice || []).map(a => `<li>${a}</li>`).join("")}</ul>

      <div class="section-title" style="margin:20px 0 8px;">🤖 AI Producer Review</div>
      <div class="stars">${this._stars(r.ai_review?.stars || 0)}</div>
      <p class="muted" style="margin:6px 0 0;">Плюсове:</p>
      <ul class="vlist">${(r.ai_review?.pros || []).map(x => `<li>${x}</li>`).join("")}</ul>
      <p class="muted" style="margin:6px 0 0;">Минуси:</p>
      <ul class="vlist cons">${(r.ai_review?.cons || []).map(x => `<li>${x}</li>`).join("")}</ul>
    `;

    const weak = r.weak_sections || [];
    html += `<div class="section-title" style="margin:20px 0 8px;">✨ Подобри слабите места</div>`;
    if (!weak.length) {
      html += `<p class="muted">Няма ясно слаби секции — текстът е стабилен като цяло.</p>`;
    } else {
      html += weak.map((w, i) => `
        <div class="weak-card">
          <span><strong>${w.section}</strong> <span class="ws-score">${w.score}/10</span><br>
            <span class="muted">${w.reason}</span></span>
          <button class="btn ghost" onclick="ViralLab.improveSection(${i})">✨ Подобри</button>
        </div>`).join("");
    }
    html += `<div id="viralImproveOut" style="margin-top:10px;"></div>`;

    out.innerHTML = html;
  },

  // Пренаписва САМО посочената слаба секция (не цялата песен) и връща
  // текста обратно в lyricsOut — с before/after "score", за да се вижда
  // реалният ефект от подобрението.
  async improveSection(i) {
    const r = AppState.data.project.viralReport;
    const w = r?.weak_sections?.[i];
    const lyrics = document.getElementById("lyricsOut").value.trim();
    if (!w || !lyrics) return;
    const el = document.getElementById("viralImproveOut");
    el.innerHTML = `<p class="muted">⏳ Пренаписвам "${w.section}"...</p>`;

    const prompt = `Дадена е песен. Пренапиши САМО секцията "${w.section}", защото: "${w.reason}".
Не пипай останалите секции — върни ги дословно същите. Запази мета-таговете ([Chorus], [Verse] и т.н.),
стила и жанра. Новата версия на секцията трябва да е осезаемо по-силна (по-добър hook/рими/образност).

Пълен текст:
---
${lyrics}
---

Върни ЧИСТ JSON: {"full_lyrics": "целият текст с пренаписаната секция", "new_section_score": number (0-10, честна нова оценка САМО на пренаписаната секция), "what_changed": "1 изречение какво промени"}`;

    try {
      const raw = await callAI(prompt, 1800);
      const res = extractJson(raw);
      LyricsHistory.push(`Преди подобряване: ${w.section}`);
      document.getElementById("lyricsOut").value = res.full_lyrics;
      AppState.data.project.lyrics = res.full_lyrics;
      AppState.save();
      el.innerHTML = `<div class="copy-field"><span>✅ <strong>${w.section}</strong>: ${w.score}/10 → <strong style="color:var(--green);">${res.new_section_score}/10</strong><br><span class="muted">${res.what_changed}</span></span></div>
        <p class="muted">Текстът по-горе е обновен. Препоръка: пусни "Анализирай вирусния потенциал" пак за нов пълен доклад.</p>`;
      GeminiValidator.autoReview(`Стъпка 1 — Подобряване (${w.section})`, res.what_changed);
    } catch (e) {
      el.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  }
};

/* =========================================================
   HOOK EVOLUTION ARENA
   Вместо 1 hook и се надяваш да е добър: генерираме 8 различни,
   тестваме всеки с "3-секунден scroll тест" (симулация на реално
   TikTok/Shorts поведение — не цялата песен, само прозорче от 3с),
   選ираме топ 3, и ги "кръстосваме" — хибриди + мутации — за
   следващо поколение. 3 поколения по-късно остава 1 победител.
   Вдъхновено от генетични алгоритми: селекция + кръстосване >
   просто "генерирай N пъти и избери най-добрия".
   ========================================================= */
const HookArena = {
  running: false,

  async start() {
    if (this.running) return;
    this.running = true;
    const p = AppState.data.project;
    const niche = p.chosenNiche || "modern pop";
    const title = p.title || "";
    const out = document.getElementById("hookArenaOut");
    out.innerHTML = `<p class="muted">🧬 Generation 1 — създавам 8 различни hook-а...</p>`;

    try {
      let pool = await this._generateInitial(niche, title);
      let allGenerationsHtml = "";

      for (let gen = 1; gen <= 3; gen++) {
        out.innerHTML = allGenerationsHtml + `<p class="muted">🧬 Generation ${gen} — 3-секунден scroll тест на ${pool.length} hook-а...</p>`;
        const scored = await this._scoreHooks(pool, niche);
        const merged = pool.map((h, i) => ({ ...h, ...scored[i] }))
          .sort((a, b) => (b.hook_score ?? 0) - (a.hook_score ?? 0));

        const isFinal = gen === 3;
        allGenerationsHtml += this._renderGeneration(gen, merged, isFinal);
        out.innerHTML = allGenerationsHtml;

        if (isFinal) {
          const winner = merged[0];
          AppState.data.project.winningHook = winner.text;
          AppState.save();
          out.innerHTML = allGenerationsHtml + `
            <div class="card tight" style="margin-top:12px;border-color:var(--green);">
              <strong>🏆 Победител: Gen 3, score ${winner.hook_score}</strong>
              <p style="margin:6px 0 0;font-size:13px;">"${winner.text}"</p>
              <p class="muted" style="margin-top:6px;">Запазен — при следващото "✍️ Генерирай текст" Claude ще го вгради като chorus hook.</p>
            </div>`;
          GeminiValidator.autoReview("Стъпка 1 — Hook Evolution Arena (победител)", winner.text);
          break;
        }

        const top3 = merged.slice(0, 3);
        out.innerHTML = allGenerationsHtml + `<p class="muted">🧬 Кръстосвам топ 3 в следващо поколение...</p>`;
        pool = await this._breed(top3, niche, title, gen === 2 ? 5 : 8);
      }
    } catch (e) {
      out.innerHTML += `<p class="muted">❌ ${e.message}</p>`;
    } finally {
      this.running = false;
    }
  },

  async _generateInitial(niche, title) {
    const prompt = `Генерирай 8 РАЗЛИЧНИ hook/chorus реда (1 ред всеки) за песен в жанр "${niche}"${title ? ` със заглавие "${title}"` : ""}.
Всеки трябва да звучи различно: различна рима схема, различен ъгъл/емоция, различен ключов образ.
Не повтаряй теми/думи между тях. Пиши директно репликите, без обяснения.
Върни ЧИСТ JSON масив: [{"text":"..."}]`;
    const raw = await callAI(prompt, 700);
    return extractJson(raw);
  },

  // "3-секунден scroll тест" — симулира реално TikTok/Shorts поведение:
  // не цялата песен, само прозорче, каквото реално вижда скролващ човек.
  async _scoreHooks(hooks, niche) {
    const prompt = `Ти си симулация на TikTok/YouTube Shorts scroll поведение за жанр "${niche}".
За всеки от следните hook редове, представи си, че потребител чува САМО първите 3 секунди
докато скролва — направи честен "3-секунден window тест":

${hooks.map((h, i) => `${i + 1}. "${h.text}"`).join("\n")}

За всеки върни:
- hook_score: 0-100 (обща сила — запомняемост, ритъм, изненада, "stopping power")
- stops_scroll: boolean (дали тези 3 секунди реално биха спрели скрола)
- why: кратка причина, максимум 8 думи

Върни ЧИСТ JSON масив, В СЪЩИЯ РЕД: [{"hook_score":number,"stops_scroll":boolean,"why":"..."}]`;
    const raw = await callAI(prompt, 1300);
    return extractJson(raw);
  },

  async _breed(top3, niche, title, targetCount) {
    const isFinal = targetCount === 5;
    const prompt = `Ти си AI hook "breeder" — вземаш най-силните hook-ове от предишно поколение и ги кръстосваш,
за песен в жанр "${niche}"${title ? ` със заглавие "${title}"` : ""}.

РОДИТЕЛИ (топ 3 от предишно поколение):
${top3.map((h, i) => `${i + 1}. "${h.text}" — защо е силен: ${h.why || "висок scroll score"}`).join("\n")}

Генерирай СЛЕДВАЩО поколение от ${targetCount} ${isFinal ? "ФИНАЛНО РАФИНИРАНИ" : "НОВИ"} hook-а:
${isFinal
      ? `- Вземи най-добрите елементи от родителите и ги доизпипай до максимална сила — по-остри думи, по-чист ритъм, по-силна изненада. Всеки трябва да е реално по-добър от родителите си, не просто различен.`
      : `- ${Math.max(targetCount - 3, 1)} "хибрида": вземи най-силния елемент от 1 родител (напр. рима/ритъм) + най-силния елемент от друг (напр. образ/тема) и ги слей в нов hook.
- останалите "мутации": вземи 1 самостоятелен родител и направи смел творчески туист (нов ъгъл/метафора), запазвайки основната му сила.`}

За всеки нов hook дай lineage: кратко обяснение на произхода (кой родител/и и какво взе от всеки), до 15 думи.
Върни ЧИСТ JSON масив: [{"text":"...", "lineage":"..."}]`;
    const raw = await callAI(prompt, 1500);
    return extractJson(raw);
  },

  _renderGeneration(gen, merged, isFinal) {
    const best = merged[0];
    let html = `<div class="arena-gen">
      <div class="arena-gen-title">🧬 Generation ${gen} ${isFinal ? "(финал)" : ""} <span class="best">— best: ${best.hook_score ?? "—"}</span></div>`;
    merged.forEach((h, i) => {
      html += `<div class="arena-hook ${i === 0 ? "winner" : ""}">
        <span class="txt">"${h.text}"${h.lineage ? `<div class="lineage">🧬 ${h.lineage}</div>` : ""}${h.why ? `<div class="lineage">${h.stops_scroll ? "✅" : "⚠️"} ${h.why}</div>` : ""}</span>
        <span class="sc">${h.hook_score ?? "—"}</span>
      </div>`;
    });
    html += `</div>`;
    return html;
  },

  // ---------- Сравни с реални hits в нишата ----------
  // Взима реални, СКОРО набиращи инерция заглавия от YouTube в избраната
  // ниша (същият източник като "жанрово заземяване" във Viral Lab) и ги
  // пуска през СЪЩИЯ "3-секунден scroll тест", през който мина нашият
  // победител — за да видим реално къде стоим спрямо истински хитове в
  // нишата, вместо абстрактно число без контекст.
  async compareWithRealHits() {
    const p = AppState.data.project;
    const winner = p.winningHook;
    if (!winner) return toast("Първо стартирай еволюцията по-горе и изчакай победител 🧬");
    const niche = p.chosenNiche || "modern pop";
    const out = document.getElementById("hookArenaCompareOut");
    out.innerHTML = `<p class="muted">📡 Тегля реални заглавия, набиращи инерция в "${niche}", и ги пускам през 3-секундния тест...</p>`;

    try {
      const realTitles = await youtubeTopTitles(niche, 5);
      if (!realTitles.length) {
        out.innerHTML = `<p class="muted">⚠️ Няма достатъчно реални резултати за тази ниша точно сега (изисква се YouTube API ключ в Настройки). Опитай пак по-късно или смени нишата.</p>`;
        return;
      }
      const pool = [
        { text: winner, mine: true },
        ...realTitles.map(t => ({ text: t, mine: false }))
      ];
      const scored = await this._scoreHooks(pool, niche);
      const merged = pool.map((h, i) => ({ ...h, ...scored[i] }))
        .sort((a, b) => (b.hook_score ?? 0) - (a.hook_score ?? 0));

      const myRank = merged.findIndex(h => h.mine) + 1;
      const rankLabel = myRank === 1
        ? `🏆 Твоят hook е класиран #1 от ${merged.length} — над реалните заглавия в нишата точно сега!`
        : `Твоят hook е #${myRank} от ${merged.length} — ${myRank <= Math.ceil(merged.length / 2) ? "в горната половина" : "под средното"} спрямо реални заглавия в нишата.`;

      out.innerHTML = `<div class="card tight" style="margin-bottom:10px;border-color:${myRank === 1 ? "var(--green)" : "var(--border)"};">
          <strong>${rankLabel}</strong>
        </div>` +
        merged.map((h, i) => `<div class="arena-hook ${h.mine ? "winner" : ""}">
            <span class="txt">${h.mine ? "🧬 (твоят hook) " : "📡 (реален, от нишата) "}"${h.text}"${h.why ? `<div class="lineage">${h.stops_scroll ? "✅" : "⚠️"} ${h.why}</div>` : ""}</span>
            <span class="sc">${h.hook_score ?? "—"}</span>
          </div>`).join("");
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  }
};

/* =========================================================
   GHOST AUDIENCE
   Симулирана фокус-група: 12 синтетични, но правдоподобни
   персони "чуват" песента и реагират — с техните думи, техния
   сленг, техните предразсъдъци. Не абстрактно число, а РЕАКЦИЯ.
   Плюс: attention heatmap (секунда по секунда по структурата) и
   meme risk radar (редове, за които няколко персони независимо
   се закачат подигравателно — улавя нещото, за което си твърде
   близо до текста, за да го видиш сам).
   ========================================================= */
const GhostAudience = {
  // forceRefresh=true игнорира кеша (бутон "🔄 Презареди фокус-групата").
  async run(forceRefresh = false) {
    const p = AppState.data.project;
    const lyrics = (document.getElementById("lyricsOut")?.value || p.lyrics || "").trim();
    if (!lyrics) return toast("Първо генерирай текст на песента (по-горе)");
    const niche = p.chosenNiche || "modern pop";
    const out = document.getElementById("ghostAudienceOut");

    // Кешираме по хеш на текста+нишата — 12 персони е скъпа заявка, не я
    // повтаряй за идентичен вход.
    const cacheInputs = { lyrics, niche };
    if (!forceRefresh) {
      const cached = AICache.get("ghostAudience", cacheInputs);
      if (cached) {
        AppState.data.project.ghostAudience = cached;
        AppState.save();
        this.render(cached);
        toast("♻️ Показвам кеширана фокус-група (текстът не се е променил) — 🔄 Презареди за нова", 4000);
        return;
      }
    }

    out.innerHTML = `<p class="muted">👻 Свиквам 12 синтетични слушателя да чуят песента...</p>`;

    const prompt = `Ти симулираш РЕАЛНА, разнообразна публика от 12 души, слушащи следната песен
за пръв път (жанр: "${niche}"), все едно я срещат случайно на своя TikTok/YouTube feed.

ТЕКСТ:
---
${lyrics}
---

Създай 12 РАЗЛИЧНИ, правдоподобни персони (различна възраст, вкус, платформа, отношение —
от фен до циничен критик). За всяка:
- name: измислено кратко име/псевдоним (не истинска знаменитост)
- context: 3-5 думи кой е (напр. "17г, drill фен, TikTok")
- reaction: 1-2 изречения РЕАЛНА реакция, С ТЕХНИЯ ГЛАС/СЛЕНГ (не обяснение — самата реакция, все едно я пише в коментар)
- would_scroll_away: boolean — дали биха скролнали до края
- scroll_away_at: ако would_scroll_away е true, коя секция от текста ги "загуби" (напр. "Verse 2"); ако false — null

После, на база всичките 12 реакции, направи:
- attention_heatmap: масив от {"section":"Intro/Verse/Chorus и т.н., в реда на текста","attention":number 0-100} — колко от персоните останаха "включени" на всяка секция
- meme_risk: масив от 0-2 елемента {"line":"конкретен ред от текста, за който 2+ персони се закачиха подигравателно","flagged_by":number,"note":"защо е рисков, 1 изречение"} — САМО ако реално има такъв риск, иначе празен масив

Върни ЧИСТ JSON: {"personas":[...], "attention_heatmap":[...], "meme_risk":[...]}`;

    try {
      const raw = await callAI(prompt, 3200);
      const r = extractJson(raw);
      AICache.set("ghostAudience", cacheInputs, r);
      AppState.data.project.ghostAudience = r;
      AppState.save();
      this.render(r);
      GeminiValidator.autoReview("Стъпка 1 — Ghost Audience", `${r.personas?.length || 0} персони, ${r.meme_risk?.length || 0} meme риска`);
    } catch (e) {
      out.innerHTML = `<p class="muted">❌ ${e.message}</p>`;
    }
  },

  render(r) {
    const out = document.getElementById("ghostAudienceOut");
    const personas = r.personas || [];
    const stayCount = personas.filter(p => !p.would_scroll_away).length;

    let html = `<p class="muted">${stayCount}/${personas.length} персони биха останали до края.</p>
      <div class="persona-grid">`;
    personas.forEach(p => {
      html += `<div class="persona-card">
        <div class="who"><span>👤 ${p.name}</span><span>${p.context || ""}</span></div>
        <div class="quote">"${p.reaction}"</div>
        <div class="scroll ${p.would_scroll_away ? "leave" : "stay"}">
          ${p.would_scroll_away ? `⚠️ Скролва на: ${p.scroll_away_at || "—"}` : "✅ Остава до края"}
        </div>
      </div>`;
    });
    html += `</div>`;

    if (r.attention_heatmap?.length) {
      html += `<div class="section-title" style="margin:20px 0 4px;">📈 Attention Heatmap</div>`;
      r.attention_heatmap.forEach(s => {
        const val = Math.max(0, Math.min(100, s.attention ?? 0));
        const color = val >= 70 ? "var(--green)" : val >= 40 ? "var(--amber)" : "var(--red)";
        html += `<div class="heat-row"><span class="sec">${s.section}</span>
          <div class="heat-track"><div class="heat-fill" style="width:${val}%;background:${color};"></div></div>
          <span class="muted" style="width:34px;text-align:right;">${val}</span></div>`;
      });
    }

    if (r.meme_risk?.length) {
      html += `<div class="section-title" style="margin:20px 0 4px;">⚠️ Meme Risk Radar</div>`;
      r.meme_risk.forEach(m => {
        html += `<div class="meme-flag"><strong>"${m.line}"</strong><br>
          <span class="muted">${m.flagged_by} персони се закачиха за този ред — ${m.note}</span></div>`;
      });
    } else {
      html += `<p class="muted" style="margin-top:14px;">✅ Никой ред не беше маркиран за подигравателен риск.</p>`;
    }

    out.innerHTML = html;
  }
};
