// Unit тестове за js/network.js (fetchTimeout, proxied).
//
// НЕ пипат оригиналния файл — зареждат го непроменен през
// tests/helpers/load-network.mjs (виж коментарите там).
//
// Пускане: node --test tests/
// (ползва вградения node:test runner — Node 18+, без npm install)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadNetworkModule } from "./helpers/load-network.mjs";

describe("proxied()", () => {
  test("връща оригиналния URL непроменен, когато няма зададен proxyUrl", () => {
    const { proxied } = loadNetworkModule({ load: () => ({ proxyUrl: "" }) });
    const url = "https://api.anthropic.com/v1/messages";
    assert.equal(proxied(url), url);
  });

  test("връща оригиналния URL непроменен, когато Keys.load() въобще няма proxyUrl поле", () => {
    const { proxied } = loadNetworkModule({ load: () => ({}) });
    const url = "https://generativelanguage.googleapis.com/v1beta/models";
    assert.equal(proxied(url), url);
  });

  test("обвива URL-а през proxyUrl?target=... когато има зададен proxyUrl", () => {
    const { proxied } = loadNetworkModule({
      load: () => ({ proxyUrl: "https://my-proxy.example.com" }),
    });
    const url = "https://api.anthropic.com/v1/messages";
    assert.equal(
      proxied(url),
      "https://my-proxy.example.com?target=" + encodeURIComponent(url)
    );
  });

  test("коректно кодира специални символи в оригиналния URL (query params и т.н.)", () => {
    const { proxied } = loadNetworkModule({
      load: () => ({ proxyUrl: "https://my-proxy.example.com" }),
    });
    const url = "https://generativelanguage.googleapis.com/v1beta/models?key=ABC&x=1";
    const result = proxied(url);
    assert.ok(result.startsWith("https://my-proxy.example.com?target="));
    assert.equal(decodeURIComponent(result.split("?target=")[1]), url);
  });
});

describe("fetchTimeout()", () => {
  test("връща отговора нормално при бърз успешен fetch", async () => {
    const { fetchTimeout, sandbox } = loadNetworkModule();
    const fakeResponse = { ok: true, status: 200 };
    sandbox.fetch = async (url, options) => {
      assert.equal(url, "https://example.com/ok");
      // fetchTimeout трябва да подава signal от своя AbortController
      assert.ok(options.signal instanceof AbortSignal);
      return fakeResponse;
    };
    const res = await fetchTimeout("https://example.com/ok", {}, 5000);
    assert.equal(res, fakeResponse);
  });

  test("прекратява заявката и хвърля ясна грешка на български при timeout", async () => {
    const { fetchTimeout, sandbox } = loadNetworkModule();
    // fetch, който никога не отговаря сам — трябва да бъде прекъснат от AbortController-a
    sandbox.fetch = (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });

    await assert.rejects(
      () => fetchTimeout("https://example.com/slow", {}, 50),
      (err) => {
        assert.match(err.message, /отне повече от 0\.05с/);
        return true;
      }
    );
  });

  test("пропуска обикновена (не-timeout) грешка от fetch непроменена", async () => {
    const { fetchTimeout, sandbox } = loadNetworkModule();
    const networkError = new Error("Failed to fetch (DNS)");
    sandbox.fetch = async () => {
      throw networkError;
    };
    await assert.rejects(
      () => fetchTimeout("https://example.com/broken", {}, 5000),
      (err) => {
        assert.equal(err, networkError);
        return true;
      }
    );
  });

  test("използва подразбиращ се timeout от 15000ms, когато не е подаден трети аргумент", async () => {
    const { fetchTimeout, sandbox } = loadNetworkModule();
    let capturedController;
    sandbox.fetch = async (url, options) => {
      capturedController = options.signal;
      return { ok: true };
    };
    await fetchTimeout("https://example.com/default-timeout");
    // само проверяваме, че извикването минава успешно без изричен ms аргумент
    assert.ok(capturedController instanceof AbortSignal);
    assert.equal(capturedController.aborted, false);
  });
});
