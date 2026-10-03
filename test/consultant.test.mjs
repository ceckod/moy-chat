import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "js", "consultant.js");
const sandbox = { console, module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
const { ConsultantCore: C } = sandbox.module.exports;

const vid = (id, views, dur = "PT4M", published = "2026-09-01T00:00:00Z") => ({
  id, snippet: { title: id, publishedAt: published },
  contentDetails: { duration: dur }, statistics: { viewCount: String(views) },
});

test("parseDuration", () => {
  assert.equal(C.parseDuration("PT1H2M3S"), 3723);
  assert.equal(C.parseDuration("PT45S"), 45);
  assert.equal(C.parseDuration("garbage"), 0);
});

test("isShort: до 180 сек. са Shorts", () => {
  assert.equal(C.isShort(vid("a", 1, "PT2M30S")), true);
  assert.equal(C.isShort(vid("b", 1, "PT3M1S")), false);
});

test("findOutliers: ≥3× медиана", () => {
  const r = C.findOutliers([vid("a", 100), vid("b", 100), vid("c", 100), vid("hit", 900)]);
  assert.equal(r.median, 100);
  assert.equal(JSON.stringify(r.outliers.map(o => o.id)), '["hit"]');
  assert.equal(r.outliers[0].multiple, 9);
});

test("findOutliers: празен списък / медиана 0 не гърми", () => {
  assert.equal(C.findOutliers([]).outliers.length, 0);
  assert.equal(C.findOutliers([vid("a", 0), vid("b", 0)]).outliers.length, 0);
});

test("recentVideos", () => {
  const now = Date.parse("2026-09-30T00:00:00Z");
  const r = C.recentVideos([vid("new", 1, "PT1M", "2026-09-20T00:00:00Z"), vid("old", 1, "PT1M", "2026-01-01T00:00:00Z")], 30, now);
  assert.equal(JSON.stringify(r.map(v => v.id)), '["new"]');
});

test("scoreTitle: добро заглавие > празно", () => {
  const kws = C.DEFAULT_KEYWORDS;
  const good = C.scoreTitle("КЮЧЕК 2026 | Най-новите хитове за купон 🔥", kws);
  const bad = C.scoreTitle("abc", kws);
  assert.ok(good.score > bad.score);
  assert.ok(good.matched.includes("кючек"));
  assert.ok(good.score <= 100);
});

test("findOpportunities: най-добрият има score 100", () => {
  const r = C.findOpportunities(C.DEFAULT_KEYWORDS);
  assert.equal(r[0].score, 100);
  assert.ok(r.every(x => x.volume >= 1000));
});

test("growth: сравнява последния snapshot с по-стар", () => {
  const h = { snapshots: [
    { date: "2026-09-01", channel: { subscribers: 100, total_views: 1000 }, videos: [{ video_id: "a", title: "A", views: 10 }] },
    { date: "2026-09-10", channel: { subscribers: 130, total_views: 1500 }, videos: [{ video_id: "a", title: "A", views: 60 }] },
  ] };
  const g = C.growth(h, 7);
  assert.equal(g.subscribersDelta, 30);
  assert.equal(g.viewsDelta, 500);
  assert.equal(g.topMovers[0].viewsGained, 50);
  assert.equal(C.growth({ snapshots: [] }), null);
});

test("findOpportunities: ползва жива конкуренция само ако покрива всички", () => {
  const kws = [{ term: "a", volume: 10000, competition: 10 }, { term: "b", volume: 10000, competition: 10 }];
  const partial = C.findOpportunities(kws, 1000, { a: { count: 100 } });
  assert.equal(partial[0].compSource, "manual");
  const full = C.findOpportunities(kws, 1000, { a: { count: 100 }, b: { count: 1000000 } });
  assert.equal(full[0].compSource, "live");
  assert.equal(full[0].term, "a"); // по-малко видеа → по-висок score при равно търсене
  assert.ok(full[0].competition < full[1].competition);
});

test("unrated: без търсене, най-малко видеа първо", () => {
  const kws = [{ term: "x", volume: 0 }, { term: "y", volume: 0 }, { term: "z", volume: 5000, competition: 5 }];
  const u = C.unrated(kws, 1000, { x: { count: 500 }, y: { count: 50 } });
  assert.equal(u.map(k => k.term).join(), "y,x");
});
