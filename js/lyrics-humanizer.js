// js/lyrics-humanizer.js
// -----------------------------------------------------------------------
// LyricsHumanizer — v2: ОСНОВЕН gate е AI-съдия (Gemini, judge()),
// решаващ дали генериран текст на песен звучи като истинска, изпяваема
// песен или като AI-генерирана поема. Причина за смяната от чист
// rule-based (v1): regex/keyword списък срещу клишета е лесно
// заобиколим от перифраз и не хваща структурни/жанрови проблеми
// (сложни изречения, затворена наративна дъга) — само реална AI
// преценка може.
// detect()/evaluate() (rule-based, безплатни, без API call) остават
// като бърз допълнителен сигнал, подаван В промпта на съдията — не
// вземат самостоятелно финалното решение вече.
//
// Няма зависимости от AppState/Storage; ползва глобалните callGemini()
// и extractJson() от js/providers/gemini.js и js/ai-helpers.js.
// Ползва се от: js/step1.js (generateLyrics()).
// -----------------------------------------------------------------------

const LyricsHumanizer = {
  // Праг над който текстът се смята за "звучи AI" (0-100 скала).
  THRESHOLD: 40,
  MAX_RETRIES: 2,

  // Позната база от AI-клишета — вече само ПОМОЩЕН сигнал за съдията
  // (не самостоятелен gate). Разширяема — просто добавяй низове.
  CLICHE_PATTERNS: [
    "electric night", "whispers in the dark", "chasing dreams",
    "shine like stars", "unbreakable bond", "riding the wave",
    // Допълнителни познати "GPT-isms" в текстове на песни:
    "burning desire", "dancing in the rain", "lost in the moment",
    "hearts collide", "shattered dreams", "rise from the ashes",
    "against all odds", "written in the stars", "fire in my soul",
    "breaking free", "город изгрява", "искри в очите", "пламък в сърцето",
    "танцувам под дъжда", "звезди в очите ми", "неспирна битка",
    "разбито сърце", "летя високо", "свободен като вятъра",
    "огън в душата", "огън в сърцето", "фалшива корона"
  ],

  // Разбива текста на секции по мета-таговете [Verse], [Chorus] и т.н.
  _splitSections(lyrics) {
    const sections = [];
    const re = /\[([A-Za-zА-Яа-я ]+)\]/g;
    let match, lastTag = null, lastIndex = 0;
    while ((match = re.exec(lyrics)) !== null) {
      if (lastTag !== null) {
        sections.push({ tag: lastTag, text: lyrics.slice(lastIndex, match.index).trim() });
      }
      lastTag = match[1].trim();
      lastIndex = re.lastIndex;
    }
    if (lastTag !== null) {
      sections.push({ tag: lastTag, text: lyrics.slice(lastIndex).trim() });
    }
    return sections;
  },

  // Проста дума-базирана прилика (Jaccard върху множества от думи) —
  // достатъчна за евристика "повтаря ли един куплет идеята на друг",
  // без нужда от AI/embedding модел.
  _wordOverlap(a, b) {
    const norm = s => new Set(
      s.toLowerCase().replace(/[^\wа-я\s]/gi, "").split(/\s+/).filter(w => w.length > 3)
    );
    const setA = norm(a), setB = norm(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const w of setA) if (setB.has(w)) inter++;
    return inter / Math.min(setA.size, setB.size);
  },

  detect(lyrics) {
    const flags = [];
    let score = 0;
    const lower = (lyrics || "").toLowerCase();

    // 1. Cliché matches — тежко тегло, всяко съвпадение поотделно.
    for (const phrase of this.CLICHE_PATTERNS) {
      if (lower.includes(phrase.toLowerCase())) {
        score += 15;
        flags.push({ type: "cliche", match: phrase });
      }
    }

    // 2. Структурна симетрия — вариация в дължината на редовете.
    //    Много ниска вариация (всички редове почти еднаква дължина) е
    //    типичен признак на шаблонно/AI генериран текст.
    const lines = lyrics.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("["));
    if (lines.length >= 6) {
      const lens = lines.map(l => l.length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
      const stdDev = Math.sqrt(variance);
      const coefVar = mean > 0 ? stdDev / mean : 1;
      if (coefVar < 0.18) {
        score += 20;
        flags.push({ type: "structure", match: "прекалено еднакви по дължина редове (ниска вариация)" });
      }
    }

    // 3. Повторение на идея между [Verse] секциите.
    const sections = this._splitSections(lyrics);
    const verses = sections.filter(s => /verse/i.test(s.tag));
    for (let i = 0; i < verses.length; i++) {
      for (let j = i + 1; j < verses.length; j++) {
        const overlap = this._wordOverlap(verses[i].text, verses[j].text);
        if (overlap > 0.45) {
          score += 20;
          flags.push({
            type: "repetition",
            match: `${verses[i].tag} и ${verses[j].tag} звучат почти еднакво (${Math.round(overlap * 100)}% застъпване)`
          });
        }
      }
    }

    return { score: Math.min(100, score), flags };
  },

  evaluate(lyrics) {
    const result = this.detect(lyrics);
    return { ...result, pass: result.score < this.THRESHOLD };
  },

  // ОСНОВЕН GATE (v2) — AI-съдия през Gemini, вместо самостоятелно
  // разчитане на rule-based detect(). Причина за смяната: detect()
  // разпозна 0/100 върху реален пример, който потребител флагна ръчно
  // като "изобщо не звучи човешко, това е поема, не песен" — regex
  // list срещу клишета е лесно заобиколим от перифраз и не хваща
  // структурни/жанрови проблеми (сложни подчинени изречения, затворена
  // наративна дъга вместо повтарящ се емоционален momentum), които
  // изискват реална преценка, не точно съвпадение на низове.
  //
  // detect() резултатът все пак се подава в промпта на съдията като
  // бърз, безплатен допълнителен сигнал (напр. явни клишета), но
  // ФИНАЛНОТО pass/fail решение идва от AI преценката, не от score-а
  // на detect() самостоятелно.
  async judge(lyrics) {
    const ruleHint = this.detect(lyrics);
    const ruleHintText = ruleHint.flags.length
      ? `\n(Автоматична бърза проверка вече засече: ${ruleHint.flags.map(f => f.match).join("; ")}.)`
      : "";

    const prompt = `Ти си опитен, издаван български текстописец и музикален критик — не AI асистент.
Оцени дали следният текст звучи като РЕАЛНА, изпяваема песен, или като AI-генерирана ПОЕМА.

Признаци за истинска ПЕСЕН: кратки, singable редове; разговорен, жив тон; конкретни,
специфични детайли; повтарящ се емоционален момент/хук в припева (не завършена история
с начало-среда-край); леко несъвършена, естествена фразировка.

Признаци за AI ПОЕМА (лошо): дълги сложни изречения с подчинени части; литературен,
"писан" тон вместо говорим; общи абстрактни образи (истина/лъжа, огън/душа, светлина/мрак
и подобни двойки); затворена наративна дъга, все едно е разказ, не песен; прекалено
"гладка"/симетрична структура.${ruleHintText}

Текст за оценка:
"""
${lyrics}
"""

Върни ЧИСТ JSON, без обяснения около него:
{"score": <0-100 цяло число, 0 = звучи перфектно като истинска песен, 100 = силно звучи като AI поема>,
 "sounds_like_song": <true или false>,
 "issues": ["конкретен проблем 1 (кратко, максимум 1 изречение)", "проблем 2", "..."]}`;

    try {
      const raw = await callGemini(prompt);
      const parsed = extractJson(raw);
      const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
      return {
        score,
        pass: parsed.sounds_like_song === true && score < this.THRESHOLD,
        flags: (parsed.issues || []).map(i => ({ type: "ai-judge", match: i })),
        source: "ai"
      };
    } catch (e) {
      // Gemini липсва/гръмна — не блокираме целия flow, падаме тихо
      // на бързия rule-based резултат вместо да чупим generateLyrics().
      // callGemini() вече показва toast при липсващ ключ, така че тук
      // само log, без дублиран toast.
      console.warn("LyricsHumanizer.judge: AI съдия неуспешен, fallback към rule-based —", e.message);
      return { ...ruleHint, pass: ruleHint.score < this.THRESHOLD, source: "rule-fallback" };
    }
  },

  // Рендерира badge + списък флагове в дадения контейнер (елемент по id).
  render(containerId, evalResult, opts = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!evalResult) { el.innerHTML = ""; return; }

    const { score, flags, pass, source } = evalResult;
    const color = pass ? "#2ecc71" : (score >= 70 ? "#e74c3c" : "#f1c40f");
    const label = pass ? "🟢 Звучи човешки" : (score >= 70 ? "🔴 Силно AI-звучащ" : "🟡 Възможно AI-звучащ");
    const sourceNote = source === "rule-fallback"
      ? " <span class='muted' style='font-size:0.8em;'>(Gemini недостъпен — бърза проверка, по-малко надеждна)</span>"
      : "";

    let flagsHtml = "";
    if (flags && flags.length) {
      flagsHtml = "<ul style='margin:6px 0 0 18px;padding:0;font-size:0.85em;color:#aaa;'>" +
        flags.map(f => `<li>${f.match}</li>`).join("") +
        "</ul>";
    }

    const retryBtn = opts.onRetry
      ? `<button class="btn ghost" style="margin-top:6px;" onclick="(${opts.onRetryHandlerName})()">🔁 Регенерирай (все още звучи AI)</button>`
      : "";

    el.innerHTML = `
      <div style="border-left:3px solid ${color};padding:6px 10px;">
        <strong style="color:${color};">${label}</strong>
        <span class="muted" style="margin-left:6px;">(score: ${score}/100)</span>${sourceNote}
        ${flagsHtml}
        ${retryBtn}
      </div>`;
  }
};

// Работи и като браузърен <script> (глобален LyricsHumanizer), и през
// import в Node тестове — виж test/lyrics-humanizer.test.mjs.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { LyricsHumanizer };
}
