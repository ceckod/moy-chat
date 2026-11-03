import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadNicheScoring } from "./load-niche-scoring.mjs";

const NicheScoring = loadNicheScoring();

describe("computeHHI / computeOpportunity", () => {
  test("здрава 'средна класа' (равномерни дялове) → нисък HHI → висок Opportunity", () => {
    const shares = [20, 18, 17, 16, 15, 14]; // почти равни дялове
    const opp = NicheScoring.computeOpportunity({ topShares: shares });
    assert.equal(opp.method, "hhi");
    assert.ok(opp.value > 70, `очаквах висок Opportunity, получих ${opp.value}`);
  });

  test("монополизиран пазар (топ играч взима >80%) → висок HHI → нисък Opportunity", () => {
    const shares = [85, 8, 3, 2, 1, 1];
    const opp = NicheScoring.computeOpportunity({ topShares: shares });
    assert.ok(opp.value < 40, `очаквах нисък Opportunity, получих ${opp.value}`);
  });

  test("под 2 играча → HHI недефиниран → fallback към YouTube diversity", () => {
    const opp = NicheScoring.computeOpportunity({ topShares: [100], youtubeChannelDiversity: { unique: 8, total: 15 } });
    assert.equal(opp.method, "youtube-diversity-fallback");
    assert.equal(opp.value, 53);
  });

  test("никакви данни за конкуренция → insufficient-data, не измислена стойност", () => {
    const opp = NicheScoring.computeOpportunity({});
    assert.equal(opp.value, null);
    assert.equal(opp.method, "insufficient-data");
    assert.equal(opp.confidence, "LOW");
  });
});

describe("classifyMomentum — trend история, не само snapshot", () => {
  test("расте стабилно, без ускорение → RISING (не ACCELERATING)", () => {
    const history = [{ date: "2026-01-01", value: 100 }, { date: "2026-02-01", value: 110 }, { date: "2026-03-01", value: 121 }];
    const m = NicheScoring.classifyMomentum(history);
    // growth ~10% и на двата периода — без ускорение
    assert.equal(m.trend, "RISING");
  });

  test("растежът се ускорява период-до-период → ACCELERATING", () => {
    const history = [{ date: "2026-01-01", value: 100 }, { date: "2026-02-01", value: 105 }, { date: "2026-03-01", value: 130 }];
    const m = NicheScoring.classifyMomentum(history);
    assert.equal(m.trend, "ACCELERATING");
  });

  test("спад с повече от 20% → COLLAPSING, не просто DECLINING", () => {
    const history = [{ date: "2026-01-01", value: 100 }, { date: "2026-02-01", value: 60 }];
    const m = NicheScoring.classifyMomentum(history);
    assert.equal(m.trend, "COLLAPSING");
  });

  test("лек спад → DECLINING", () => {
    const history = [{ date: "2026-01-01", value: 100 }, { date: "2026-02-01", value: 92 }];
    const m = NicheScoring.classifyMomentum(history);
    assert.equal(m.trend, "DECLINING");
  });

  test("под 2 точки история → UNKNOWN, не гадаем тренд от нищо", () => {
    const m = NicheScoring.classifyMomentum([{ date: "2026-01-01", value: 100 }]);
    assert.equal(m.trend, "UNKNOWN");
    assert.equal(m.confidence, "LOW");
  });
});

describe("computePNS — обединяване на 5-те под-индекса", () => {
  const full = () => ({
    demand: { value: 80 }, momentum: { value: 75 }, opportunity: { value: 82 },
    monetization: { value: 45 }, feasibility: { value: 90 }
  });

  test("high demand + LOW competition (висок Opportunity) → висок общ score", () => {
    const subIndices = { ...full(), demand: { value: 90 }, opportunity: { value: 85 } };
    const r = NicheScoring.computePNS(subIndices);
    assert.ok(r.score >= 75, `очаквах висок score, получих ${r.score}`);
    assert.equal(r.confidence, "HIGH");
  });

  test("high demand + HIGH competition (нисък Opportunity) → СЪЩЕСТВЕНО по-нисък score от предходния случай", () => {
    const highDemandHighComp = { ...full(), demand: { value: 90 }, opportunity: { value: 15 } };
    const r = NicheScoring.computePNS(highDemandHighComp);
    const highDemandLowComp = NicheScoring.computePNS({ ...full(), demand: { value: 90 }, opportunity: { value: 85 } });
    assert.ok(r.score < highDemandLowComp.score, "висока конкуренция трябва да намали score-а спрямо ниска конкуренция при същото demand");
  });

  test("КЛЮЧОВ сценарий от заданието: умерено търсене + ниска конкуренция + силен растеж БИЕ голямо търсене + много висока конкуренция", () => {
    const bigButSaturated = NicheScoring.computePNS({
      demand: { value: 92 }, momentum: { value: 55 }, opportunity: { value: 10 },
      monetization: { value: 50 }, feasibility: { value: 60 }
    });
    const smallButGrowing = NicheScoring.computePNS({
      demand: { value: 55 }, momentum: { value: 92 }, opportunity: { value: 80 },
      monetization: { value: 50 }, feasibility: { value: 60 }
    });
    assert.ok(smallButGrowing.score > bigButSaturated.score,
      `по-малка, бързорастяща, ниско-конкурентна ниша (${smallButGrowing.score}) трябва да бие голяма пренаситена (${bigButSaturated.score})`);
  });

  test("low demand + high growth → все пак прилична оценка, не автоматично AVOID", () => {
    const r = NicheScoring.computePNS({
      demand: { value: 25 }, momentum: { value: 92 }, opportunity: { value: 75 },
      monetization: { value: 40 }, feasibility: { value: 70 }
    });
    assert.ok(r.score >= 45, `очаквах поне умерен score заради силния растеж, получих ${r.score}`);
  });

  test("declining niche → нисък momentum под-индекс тегли score-а надолу", () => {
    const rising = NicheScoring.computePNS(full());
    const declining = NicheScoring.computePNS({ ...full(), momentum: { value: 20 } });
    assert.ok(declining.score < rising.score);
  });

  test("напълно липсващи данни (всички null) → score=null, insufficient data, НЕ измислено число", () => {
    const r = NicheScoring.computePNS({
      demand: { value: null }, momentum: { value: null }, opportunity: { value: null },
      monetization: { value: null }, feasibility: { value: null }
    });
    assert.equal(r.score, null);
    assert.equal(r.dataCoveragePct, 0);
    assert.equal(r.confidence, "LOW");
  });

  test("частично липсващи данни → confidence не е HIGH, dataCoveragePct отразява реалното покритие", () => {
    const r = NicheScoring.computePNS({
      demand: { value: 70 }, momentum: { value: null }, opportunity: { value: null },
      monetization: { value: null }, feasibility: { value: null }
    });
    assert.equal(r.dataCoveragePct, 20); // 1 от 5
    assert.notEqual(r.confidence, "HIGH");
    assert.equal(r.score, 70); // единственият наличен сигнал носи 100% от тежестта
  });

  test("тежестта на липсващ под-индекс се преразпределя пропорционално, не се губи", () => {
    const r = NicheScoring.computePNS({
      demand: { value: 100 }, momentum: { value: 100 }, opportunity: { value: null },
      monetization: { value: null }, feasibility: { value: null }
    });
    // demand(0.25) + momentum(0.25) от общо 0.5 налично тегло → 50/50 помежду си
    assert.equal(r.weightsUsed.demand, 0.5);
    assert.equal(r.weightsUsed.momentum, 0.5);
    assert.equal(r.score, 100);
  });

  test("екстремни стойности (всички 100 / всички 0) → score остава в [0,100], без NaN/Infinity", () => {
    const allMax = NicheScoring.computePNS({
      demand: { value: 100 }, momentum: { value: 100 }, opportunity: { value: 100 },
      monetization: { value: 100 }, feasibility: { value: 100 }
    });
    const allMin = NicheScoring.computePNS({
      demand: { value: 0 }, momentum: { value: 0 }, opportunity: { value: 0 },
      monetization: { value: 0 }, feasibility: { value: 0 }
    });
    assert.equal(allMax.score, 100);
    assert.equal(allMin.score, 0);
    assert.ok(Number.isFinite(allMax.score) && Number.isFinite(allMin.score));
  });

  test("еднакви ниши (идентичен вход) → идентичен резултат — ДЕТЕРМИНИЗЪМ", () => {
    const input = full();
    const r1 = NicheScoring.computePNS(input);
    const r2 = NicheScoring.computePNS(full());
    assert.equal(r1.score, r2.score);
    assert.deepEqual(r1.weightsUsed, r2.weightsUsed);
  });
});

describe("compareNiches — сравнение с обяснение", () => {
  test("сравнение на две ниши: по-високата побеждава и обяснението сочи най-голямата разлика в под-индекс", () => {
    const nicheA = { name: "Sleep / Deep Focus", pns: NicheScoring.computePNS({
      demand: { value: 88 }, momentum: { value: 74 }, opportunity: { value: 82 },
      monetization: { value: 45 }, feasibility: { value: 90 }
    }) };
    const nicheB = { name: "Phonk / Gym", pns: NicheScoring.computePNS({
      demand: { value: 76 }, momentum: { value: 52 }, opportunity: { value: 38 },
      monetization: { value: 68 }, feasibility: { value: 92 }
    }) };
    const result = NicheScoring.compareNiches([nicheB, nicheA]); // подадени в грешен ред нарочно
    assert.equal(result[0].name, "Sleep / Deep Focus"); // трябва да пресортира
    assert.ok(result[1].whyBehindPrevious.includes("свободна ниша")); // най-голямата разлика е в opportunity (82 vs 38)
  });

  test("ниши без наличен score (insufficient data) се изключват от сравнението, не чупят сортирането", () => {
    const validNiche = { name: "A", pns: NicheScoring.computePNS({
      demand: { value: 70 }, momentum: { value: 70 }, opportunity: { value: 70 },
      monetization: { value: 70 }, feasibility: { value: 70 }
    }) };
    const emptyNiche = { name: "B", pns: NicheScoring.computePNS({
      demand: { value: null }, momentum: { value: null }, opportunity: { value: null },
      monetization: { value: null }, feasibility: { value: null }
    }) };
    const result = NicheScoring.compareNiches([emptyNiche, validNiche]);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "A");
  });
});

describe("opportunityBucket / recommendation", () => {
  test("score >= 85 → EXCEPTIONAL", () => assert.equal(NicheScoring.opportunityBucket(90), "EXCEPTIONAL"));
  test("score 65-84 → HIGH", () => assert.equal(NicheScoring.opportunityBucket(70), "HIGH"));
  test("score < 45 → LOW", () => assert.equal(NicheScoring.opportunityBucket(20), "LOW"));

  test("висок score но LOW confidence → никога директно ATTACK, максимум TEST", () => {
    assert.equal(NicheScoring.recommendation(85, "LOW"), "TEST");
  });
  test("висок score + добра confidence → ATTACK", () => {
    assert.equal(NicheScoring.recommendation(80, "HIGH"), "ATTACK");
  });
  test("null score (insufficient data) → WATCH, не гадаем", () => {
    assert.equal(NicheScoring.recommendation(null, "LOW"), "WATCH");
  });
});
