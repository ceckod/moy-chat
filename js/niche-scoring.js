/* =========================================================
   NICHE SCORING — чист, тестван scoring модул за
   Profit Niche Score (0-100), разширение на js/niche-toolkit.js.

   НАРОЧНО отделен файл, без fetch/DOM извиквания вътре — само
   математика върху вече събрани сигнали. Това го прави лесен за
   unit тестове (виж test/niche-scoring.test.mjs) и детерминистичен:
   един и същ вход → един и същ изход, винаги.

   Зависимости: НИКАКВИ (чист ES modul-съвместим обект, работи и
   директно като <script> в браузъра, и през import в Node тестове —
   виж експорта в самия край на файла).

   5 под-индекса (виж README/AUDIT_PROGRESS.md за пълния дизайн,
   договорен с потребителя преди имплементацията):
     - Demand        — колко голям е пазарът в момента
     - Momentum      — расте ли/пада ли (rising/accelerating/
                       stable/declining/collapsing)
     - Opportunity   — HHI-базирана концентрация (НЕ линейно
                       "100 - конкуренция" — виж computeOpportunity)
     - Monetization  — грубо парично потенциал
     - Feasibility   — субективна, ръчна (1-5) — не пазарен сигнал

   ВАЖНО: ако сигнал липсва, съответният под-индекс е `null`, НЕ 0 —
   тежестта му се преразпределя пропорционално към наличните
   компоненти (виж computePNS). Никога не се компенсира липсваща
   стойност с измислена — вместо това confidence/dataCoverage пада.
   ========================================================= */

const NicheScoring = {

  // Централни тегла — единственото място, което трябва да се пипне,
  // за да се промени балансът, без да се пипа логиката другаде.
  DEFAULT_WEIGHTS: {
    demand: 0.25,
    momentum: 0.25,
    opportunity: 0.25,
    monetization: 0.15,
    feasibility: 0.10
  },

  /* ---------- НОРМАЛИЗАЦИЯ ---------- */

  // Логаритмична нормализация 0-100 за широко-разпределени величини
  // (views, streams) — линейна скала би направила всичко под 1M
  // невидимо до 0. maxLog=7 → log10(10 000 000)=7 се мапва до 100.
  normalizeLog(value, maxLog = 7) {
    if (value == null || Number.isNaN(value) || value < 0) return null;
    return Math.max(0, Math.min(100, (Math.log10(value + 1) / maxLog) * 100));
  },

  // Стандартна min-max нормализация в рамките на портфолио от ниши.
  normalizeMinMax(value, min, max) {
    if (value == null || min == null || max == null) return null;
    if (max === min) return 50; // всички ниши еднакви по тази метрика — неутрално
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  },

  /* ---------- OPPORTUNITY (HHI-базирана концентрация) ----------
     Herfindahl-Hirschman Index: сума от квадратите на пазарните
     дялове (0-1). HHI→1 = монопол (топ 1-2 играча взимат всичко),
     HHI→0 = равномерно разпределен пазар (здрава "средна класа").
     Opportunity = (1 - HHI) * 100 — НЕ линейно спрямо суров брой
     конкуренти, затова "много търсене + много конкуренти, но
     равномерно разпределени" може да получи ВИСОК Opportunity,
     докато "по-малко търсене, но 2 играча взимат 90%" получава НИСЪК —
     точно обратното на наивното "повече резултати = по-зле". */
  computeHHI(shares) {
    const valid = (shares || []).filter(n => typeof n === "number" && n > 0);
    const total = valid.reduce((s, n) => s + n, 0);
    if (!total || valid.length < 2) return null; // под 2 играча — HHI е безсмислен
    return valid.reduce((s, n) => s + Math.pow(n / total, 2), 0);
  },

  computeOpportunity({ topShares = null, youtubeChannelDiversity = null } = {}) {
    const hhi = this.computeHHI(topShares);
    if (hhi != null) {
      return { value: Math.round((1 - hhi) * 100), method: "hhi", confidence: "HIGH" };
    }
    // Fallback: без данни за пазарни дялове (напр. Spotify недостъпен) —
    // ползваме грубо съотношение уникални YouTube канали / общ брой
    // резултати като приближение за "разпръснатост" на нишата.
    if (youtubeChannelDiversity && youtubeChannelDiversity.total > 0) {
      const ratio = youtubeChannelDiversity.unique / youtubeChannelDiversity.total;
      return { value: Math.round(ratio * 100), method: "youtube-diversity-fallback", confidence: "MEDIUM" };
    }
    return { value: null, method: "insufficient-data", confidence: "LOW" };
  },

  /* ---------- MOMENTUM (trend история, не само последен snapshot) ----------
     history: масив от { date: ISO-string или Date, value: number },
     сортиран възходящо по дата. Смята growth rate между последните
     2 точки И acceleration (промяна на growth rate между 2 последователни
     периода), за да различи "расте" от "расте по-бързо от преди". */
  classifyMomentum(history) {
    const pts = (history || []).filter(p => p && typeof p.value === "number").slice();
    if (pts.length < 2) return { trend: "UNKNOWN", growthPct: null, confidence: "LOW" };

    const last = pts[pts.length - 1].value;
    const prev = pts[pts.length - 2].value;
    const growthPct = prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : (last > 0 ? 100 : 0);

    let trend;
    let accelPct = null;
    if (pts.length >= 3) {
      const prev2 = pts[pts.length - 3].value;
      const prevGrowthPct = prev2 !== 0 ? ((prev - prev2) / Math.abs(prev2)) * 100 : (prev > 0 ? 100 : 0);
      accelPct = growthPct - prevGrowthPct;

      if (growthPct <= -20) trend = "COLLAPSING";
      else if (growthPct < 0) trend = "DECLINING";
      else if (growthPct >= 5 && accelPct > 5) trend = "ACCELERATING";
      else if (growthPct >= 5) trend = "RISING";
      else trend = "STABLE";
    } else {
      // Само 2 точки — не можем да смятаме acceleration, по-груба класификация.
      if (growthPct <= -20) trend = "COLLAPSING";
      else if (growthPct < 0) trend = "DECLINING";
      else if (growthPct >= 5) trend = "RISING";
      else trend = "STABLE";
    }

    return {
      trend,
      growthPct: Math.round(growthPct * 10) / 10,
      accelerationPct: accelPct == null ? null : Math.round(accelPct * 10) / 10,
      confidence: pts.length >= 3 ? "HIGH" : "MEDIUM"
    };
  },

  // Момента (0-100) от trend класификацията — за да участва в PNS сметката
  // като нормален под-индекс, не само категория за display.
  momentumToScore(momentum) {
    if (!momentum || momentum.trend === "UNKNOWN") return null;
    const base = { COLLAPSING: 5, DECLINING: 25, STABLE: 55, RISING: 75, ACCELERATING: 92 };
    return base[momentum.trend] ?? null;
  },

  /* ---------- DEMAND (комбинира наличните пазарни сигнали) ---------- */
  computeDemand({ youtubeAvgViews = null, spotifyAvgPopularity = null, deezerAvgFans = null } = {}) {
    const parts = [];
    if (youtubeAvgViews != null) parts.push(this.normalizeLog(youtubeAvgViews, 7));
    if (spotifyAvgPopularity != null) parts.push(Math.max(0, Math.min(100, spotifyAvgPopularity)));
    if (deezerAvgFans != null) parts.push(this.normalizeLog(deezerAvgFans, 6)); // log10(1M)=6, fans обичайно по-малко от views
    const valid = parts.filter(p => p != null);
    if (!valid.length) return { value: null, confidence: "LOW", signalsUsed: 0 };
    const value = Math.round(valid.reduce((s, n) => s + n, 0) / valid.length);
    return { value, confidence: valid.length >= 2 ? "HIGH" : "MEDIUM", signalsUsed: valid.length };
  },

  /* ---------- MONETIZATION (реюз на публично известни RPM диапазини — виж
     NicheToolkit.Revenue.RATES; тук само нормализираме към 0-100, не
     смятаме $ директно — това си остава задача на Revenue Simulator-а) ---------- */
  computeMonetization({ avgViews = null, avgStreams = null, rates = null } = {}) {
    if (!rates || (avgViews == null && avgStreams == null)) {
      return { value: null, confidence: "LOW" };
    }
    const est = (avgViews || 0) * ((rates.youtube?.lo ?? 0) + (rates.youtube?.hi ?? 0)) / 2
              + (avgStreams || 0) * ((rates.spotify?.lo ?? 0) + (rates.spotify?.hi ?? 0)) / 2;
    // Нормализация чрез log — паричните оценки също са widely-distributed.
    const value = this.normalizeLog(est, 4); // log10($10 000)=4 → 100
    return { value: value == null ? null : Math.round(value), confidence: "MEDIUM" };
  },

  /* ---------- FEASIBILITY (чисто субективна, ръчна оценка 1-5) ---------- */
  computeFeasibility(rating1to5) {
    if (rating1to5 == null || rating1to5 < 1 || rating1to5 > 5) return { value: null, confidence: "LOW" };
    return { value: Math.round(((rating1to5 - 1) / 4) * 100), confidence: "HIGH" }; // винаги HIGH — потребителят го е задал сам, не е изведено
  },

  /* ---------- PROFIT NICHE SCORE — обединява 5-те под-индекса ----------
     Всеки sub-index е { value: number|null, confidence }. Ако value е
     null, тежестта му се преразпределя пропорционално към наличните —
     НИКОГА не се третира null като 0 (виж коментара най-отгоре). */
  computePNS(subIndices, weights = this.DEFAULT_WEIGHTS) {
    const keys = ["demand", "momentum", "opportunity", "monetization", "feasibility"];
    const available = keys.filter(k => subIndices[k] && subIndices[k].value != null);
    const missing = keys.filter(k => !available.includes(k));

    if (!available.length) {
      return {
        score: null, confidence: "LOW", dataCoveragePct: 0,
        subIndices, weightsUsed: {}, missingSignals: missing,
        note: "insufficient data — нито един от 5-те сигнала не е наличен"
      };
    }

    const availableWeightSum = available.reduce((s, k) => s + (weights[k] ?? 0), 0);
    const weightsUsed = {};
    let raw = 0;
    for (const k of available) {
      const w = availableWeightSum > 0 ? (weights[k] ?? 0) / availableWeightSum : 1 / available.length;
      weightsUsed[k] = Math.round(w * 1000) / 1000;
      raw += subIndices[k].value * w;
    }
    for (const k of missing) weightsUsed[k] = 0;

    const score = Math.round(Math.max(0, Math.min(100, raw)));
    const dataCoveragePct = Math.round((available.length / keys.length) * 100);
    const confidence = available.length >= 4 ? "HIGH" : available.length >= 2 ? "MEDIUM" : "LOW";

    return { score, confidence, dataCoveragePct, subIndices, weightsUsed, missingSignals: missing };
  },

  /* ---------- OPPORTUNITY BUCKET + RECOMMENDATION (за display, не за сметката) ---------- */
  opportunityBucket(score) {
    if (score == null) return "UNKNOWN";
    if (score >= 85) return "EXCEPTIONAL";
    if (score >= 65) return "HIGH";
    if (score >= 45) return "MEDIUM";
    return "LOW";
  },

  recommendation(score, confidence) {
    if (score == null) return "WATCH"; // недостатъчно данни — изчакай повече сигнал, не гадай
    if (confidence === "LOW") return score >= 70 ? "TEST" : "WATCH"; // ниска увереност никога не дава пряко ATTACK
    if (score >= 70) return "ATTACK";
    if (score >= 50) return "TEST";
    if (score >= 30) return "WATCH";
    return "AVOID";
  },

  /* ---------- СРАВНЕНИЕ НА НИШИ ----------
     niches: [{ name, pns: <резултат от computePNS> }, ...]
     Връща сортиран списък + кратко "защо A > B" обяснение на човешки
     език, базирано на НАЙ-голямата разлика в под-индексите между
     съседните по ранг ниши — не просто "по-голямо число". */
  compareNiches(niches) {
    const labels = { demand: "търсене", momentum: "тренд", opportunity: "свободна ниша", monetization: "монетизация", feasibility: "осъществимост" };
    const sorted = [...niches]
      .filter(n => n.pns && n.pns.score != null)
      .sort((a, b) => b.pns.score - a.pns.score);

    const withReasons = sorted.map((n, i) => {
      if (i === 0) return { ...n, whyAheadOfNext: null };
      const prev = sorted[i - 1];
      const keys = Object.keys(labels);
      let maxKey = null, maxDiff = -1;
      for (const k of keys) {
        const a = prev.pns.subIndices[k]?.value, b = n.pns.subIndices[k]?.value;
        if (a == null || b == null) continue;
        const diff = a - b;
        if (diff > maxDiff) { maxDiff = diff; maxKey = k; }
      }
      const why = maxKey
        ? `${prev.name} печели пред ${n.name} основно по ${labels[maxKey]} (+${Math.round(maxDiff)})`
        : `${prev.name} печели пред ${n.name} с общ по-висок резултат — под-индексите не са напълно сравними (различна data coverage)`;
      return { ...n, whyBehindPrevious: why };
    });

    return withReasons;
  }
};

// Работи и като браузърен <script> (глобален NicheScoring), и през
// import в Node тестове — виж test/niche-scoring.test.mjs.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { NicheScoring };
}
