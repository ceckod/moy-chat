import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "js", "thumbnail-maker.js");
const sandbox = { console, module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
const { ThumbCore: T } = sandbox.module.exports;

test("cleanHeadline: главни, до 4 думи, до 28 символа", () => {
  assert.equal(T.cleanHeadline("  нов   хит  за  купона  тази  вечер "), "НОВ ХИТ ЗА КУПОНА");
  assert.ok(T.cleanHeadline("абвгдежзийклмнопрстуфхцчшщ абвгд").length <= 28);
  assert.equal(T.cleanHeadline(""), "");
});

test("parseConcepts: чист JSON масив", () => {
  const raw = JSON.stringify([
    { headline: "огън", imagePrompt: "neon club crowd", accent: "#ff0055", position: "center" },
    { headline: "нощ", imagePrompt: "dark street", accent: "bad", position: "nowhere" },
  ]);
  const r = T.parseConcepts(raw);
  assert.equal(r.length, 2);
  assert.equal(r[0].headline, "ОГЪН");
  assert.equal(r[0].position, "center");
  assert.equal(r[1].accent, "#ffd400");   // невалиден цвят → по подразбиране
  assert.equal(r[1].position, "left");    // невалидна позиция → по подразбиране
});

test("parseConcepts: ```json ограда и текст наоколо", () => {
  const raw = 'Ето:\n```json\n[{"headline":"A B","imagePrompt":"x"}]\n```\nУспех!';
  assert.equal(T.parseConcepts(raw).length, 1);
});

test("parseConcepts: обект с concepts и непълни елементи", () => {
  const raw = JSON.stringify({ concepts: [{ headline: "ok", imagePrompt: "p" }, { headline: "", imagePrompt: "p" }, { headline: "x" }] });
  assert.equal(T.parseConcepts(raw).length, 1);
});

test("parseConcepts: боклук → празен масив", () => {
  assert.equal(T.parseConcepts("не мога да помогна").length, 0);
  assert.equal(T.parseConcepts("").length, 0);
  assert.equal(T.parseConcepts(null).length, 0);
});

test("parseConcepts: максимум 3", () => {
  const arr = Array.from({ length: 6 }, (_, i) => ({ headline: "h" + i, imagePrompt: "p" }));
  assert.equal(T.parseConcepts(JSON.stringify(arr)).length, 3);
});

test("wrapLines: пренася по ширина", () => {
  const measure = s => s.length * 10;
  const lines = T.wrapLines("ААА ББББ ВВ ГГГГГГ", measure, 80);
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(" "), "ААА ББББ ВВ ГГГГГГ");
});

test("fitFont: смалява докато се събере в до 3 реда", () => {
  const measureAt = (s, size) => s.length * size * 0.6;
  const r = T.fitFont("НОВ ХИТ ЗА КУПОНА", measureAt, 600, 200);
  assert.ok(r.lines.length <= 3);
  assert.ok(r.lines.every(l => measureAt(l, r.size) <= 600));
  assert.ok(r.size <= 200 && r.size >= 48);
});

test("chooseExport: PNG ако е под лимита, иначе JPEG, иначе tooBig", () => {
  const b = n => ({ size: n });
  assert.equal(T.chooseExport({ png: b(100), jpeg: b(50) }, 1000).kind, "png");
  assert.equal(T.chooseExport({ png: b(5000), jpeg: b(500) }, 1000).kind, "jpeg");
  const big = T.chooseExport({ png: b(5000), jpeg: b(4000) }, 1000);
  assert.equal(big.tooBig, true);
});

test("imageProviderOrder: най-силният първо, само с налични ключове", () => {
  assert.equal(T.imageProviderOrder("auto", { gemini: "k", cfApiToken: "t", cfAccountId: "a" }).join(), "gemini,cloudflare,pollinations");
  assert.equal(T.imageProviderOrder("auto", { cfApiToken: "t", cfAccountId: "a" }).join(), "cloudflare,pollinations");
  assert.equal(T.imageProviderOrder("auto", {}).join(), "pollinations");
  assert.equal(T.imageProviderOrder("cloudflare", { gemini: "k", cfApiToken: "t", cfAccountId: "a" }).join(), "cloudflare,gemini,pollinations");
  assert.equal(T.imageProviderOrder("gemini", {}).join(), "pollinations"); // избран, но без ключ → не се опитва
});

test("textFirst: free = безплатен преди платения Claude", () => {
  assert.equal(T.textFirst("free", { claude: "c", gemini: "g" }), "gemini");
  assert.equal(T.textFirst("free", { claude: "c", openrouterKey: "o" }), "openrouter");
  assert.equal(T.textFirst("free", { claude: "c", groqKey: "x" }), "modelfinder");
  assert.equal(T.textFirst("free", { claude: "c" }), null); // само Claude → редът на callAI
  assert.equal(T.textFirst("auto", { gemini: "g" }), null);
  assert.equal(T.textFirst("claude", { claude: "c" }), "claude");
  assert.equal(T.textFirst("claude", {}), null);
});
