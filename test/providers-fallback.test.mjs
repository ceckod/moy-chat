// Unit тестове за js/providers/fallback-loop.js + provider-специфичните
// classify функции в claude.js/gemini.js/openrouter.js.
//
// НЕ пипат оригиналните файлове — зареждат ги непроменени през
// test/load-provider.mjs (виж коментарите там).
//
// Цел: да потвърдят, че извличането на общия fallback цикъл (стъпка 7 от
// одита) НЕ е променило нюансите на всеки provider — кои HTTP кодове
// значат "смени модела" срещу "спри веднага", вътрешния retry при Gemini
// 429, тихия преход при мрежова грешка, и 404 cache-clear-а при Gemini.
//
// Пускане: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadProviderModule } from "./load-provider.mjs";

function httpError(status, msg = "err") {
  const e = new Error(msg);
  e.status = status;
  return e;
}

describe("runModelFallbackLoop (общ helper)", () => {
  test("успех на първия опит — връща резултата, логва ok:true, не пипа ростъра", async () => {
    const calls = [];
    const sandbox = loadProviderModule("claude.js", {
      AICallLog: { record: (x) => calls.push(x) },
    });
    const result = await sandbox.runModelFallbackLoop(
      ["model-a"],
      async () => "готово",
      { provider: "test", classify: () => ({ action: "abort" }) }
    );
    assert.equal(result, "готово");
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ provider: "test", model: "model-a", ok: true }]);
  });

  test("action: abort — хвърля веднага, не пробва следващия модел", async () => {
    const sandbox = loadProviderModule("claude.js");
    let secondModelTried = false;
    await assert.rejects(
      () => sandbox.runModelFallbackLoop(
        ["model-a", "model-b"],
        async (model) => {
          if (model === "model-b") secondModelTried = true;
          throw httpError(400, "невалиден ключ");
        },
        { provider: "test", classify: () => ({ action: "abort" }) }
      ),
      /невалиден ключ/
    );
    assert.equal(secondModelTried, false);
  });

  test("action: next — премахва от ростъра и показва switchMsg само ако има следващ модел", async () => {
    const removed = [];
    const toasts = [];
    const sandbox = loadProviderModule("claude.js", {
      AgentRoster: { getWorking: () => null, removeModel: (p, m, r) => removed.push([p, m, r]) },
      toast: (msg) => toasts.push(msg),
    });
    const result = await sandbox.runModelFallbackLoop(
      ["model-a", "model-b"],
      async (model) => (model === "model-a" ? Promise.reject(httpError(429)) : "второ сработи"),
      {
        provider: "claude",
        classify: (e) => ({
          action: "next",
          removeReason: "квота",
          switchMsg: (next) => `превключвам към ${next}`,
        }),
      }
    );
    assert.equal(result, "второ сработи");
    assert.deepEqual(removed, [["claude", "model-a", "квота"]]);
    assert.deepEqual(toasts, ["превключвам към model-b"]);
  });

  test("action: retry — изчаква и пробва СЪЩИЯ модел отново, докато не се изчерпят опитите", async () => {
    let attempts = 0;
    const sandbox = loadProviderModule("claude.js");
    const result = await sandbox.runModelFallbackLoop(
      ["model-a"],
      async () => {
        attempts++;
        if (attempts < 3) throw httpError(429);
        return "успя на 3-ти опит";
      },
      {
        provider: "claude",
        maxRetriesPerModel: 2,
        classify: (e, model, retries) => ({ action: "retry", waitMs: 0 }),
      }
    );
    assert.equal(result, "успя на 3-ти опит");
    assert.equal(attempts, 3);
  });

  test("log:false — не логва грешката (Gemini мрежова грешка случай)", async () => {
    const calls = [];
    const sandbox = loadProviderModule("claude.js", { AICallLog: { record: (x) => calls.push(x) } });
    await assert.rejects(
      () => sandbox.runModelFallbackLoop(
        ["model-a"],
        async () => { throw new Error("мрежова грешка"); },
        { provider: "test", classify: () => ({ action: "next", log: false, removeFromRoster: false }) }
      )
    );
    assert.deepEqual(calls, []); // нито един AICallLog.record — точно като преди
  });
});

describe("Claude: _classifyClaudeError", () => {
  test("429 и 529 → next (смяна на модела)", () => {
    const sandbox = loadProviderModule("claude.js");
    assert.equal(sandbox._classifyClaudeError(httpError(429), "m").action, "next");
    assert.equal(sandbox._classifyClaudeError(httpError(529), "m").action, "next");
  });
  test("друг статус (напр. 401 невалиден ключ) → abort", () => {
    const sandbox = loadProviderModule("claude.js");
    assert.equal(sandbox._classifyClaudeError(httpError(401), "m").action, "abort");
  });
});

describe("OpenRouter: _classifyOpenRouterError", () => {
  test("429 / 503 / 400 / без status → next (retryable)", () => {
    const sandbox = loadProviderModule("openrouter.js");
    for (const status of [429, 503, 400]) {
      assert.equal(sandbox._classifyOpenRouterError(httpError(status), "m").action, "next");
    }
    assert.equal(sandbox._classifyOpenRouterError(new Error("отрязан отговор"), "m").action, "next");
  });
  test("друг статус (напр. 401) → abort", () => {
    const sandbox = loadProviderModule("openrouter.js");
    assert.equal(sandbox._classifyOpenRouterError(httpError(401), "m").action, "abort");
  });
});

describe("Gemini: _classifyGeminiError", () => {
  test("мрежова грешка (без .status) → next, БЕЗ лог, БЕЗ премахване от ростъра (тих преход)", () => {
    const sandbox = loadProviderModule("gemini.js");
    const verdict = sandbox._classifyGeminiError(new Error("network fail"), "m", 0);
    assert.equal(verdict.action, "next");
    assert.equal(verdict.log, false);
    assert.equal(verdict.removeFromRoster, false);
  });

  test("429, retries=0 → retry (кратък backoff, същия модел)", () => {
    const sandbox = loadProviderModule("gemini.js");
    const verdict = sandbox._classifyGeminiError(httpError(429), "m", 0);
    assert.equal(verdict.action, "retry");
    assert.equal(verdict.waitMs, 1500);
  });

  test("429, retries=1 (изчерпан единствения retry) → next, маха от ростъра", () => {
    const sandbox = loadProviderModule("gemini.js");
    const verdict = sandbox._classifyGeminiError(httpError(429), "m", 1);
    assert.equal(verdict.action, "next");
    assert.equal(verdict.removeReason, "429 — изчерпана дневна квота");
  });

  test("404 → next, чисти кеша на списъка с модели", () => {
    const sandbox = loadProviderModule("gemini.js");
    const verdict = sandbox._classifyGeminiError(httpError(404), "m", 0);
    assert.equal(verdict.action, "next");
    assert.equal(verdict.cacheClearKey, "cdb_gemini_models_cache_v1");
  });

  test("друг статус (напр. 401) → abort", () => {
    const sandbox = loadProviderModule("gemini.js");
    assert.equal(sandbox._classifyGeminiError(httpError(401), "m", 0).action, "abort");
  });
});

describe("callClaude (интеграционен тест с мокнат fetchTimeout)", () => {
  test("първи модел удря 429 → превключва на втория и връща неговия резултат", async () => {
    const toasts = [];
    const removed = [];
    let callCount = 0;
    const sandbox = loadProviderModule("claude.js", {
      Keys: { load: () => ({ claude: "fake-key" }) },
      Storage: {
        get: () => ({ ts: Date.now(), models: ["model-a", "model-b"] }),
        set: () => {},
      },
      AgentRoster: { getWorking: () => null, removeModel: (p, m, r) => removed.push([p, m, r]) },
      toast: (msg) => toasts.push(msg),
      fetchTimeout: async (url) => {
        callCount++;
        if (url.includes("/v1/models")) {
          return { ok: true, json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }) };
        }
        // /v1/messages извиквания — първият модел (callCount 1) се проваля
        // с 429, вторият (callCount 2) успява. Кешът с моделите вече е
        // "свеж" (виж Storage.get по-горе), затова няма отделно извикване
        // към /v1/models — броим само messages извикванията.
        if (callCount <= 1) {
          return { ok: false, status: 429, text: async () => "quota exceeded" };
        }
        return { ok: true, json: async () => ({ content: [{ text: "здравей от втория модел" }] }) };
      },
    });
    const result = await sandbox.callClaude("здравей", 100);
    assert.equal(result, "здравей от втория модел");
    assert.ok(removed.some(([p, m]) => p === "claude" && m === "model-a"));
    assert.ok(toasts.some((t) => t.includes("превключвам")));
  });
});
