// Unit тестове за Storage / Keys / Vault (app.js).
//
// НЕ пипат app.js — зареждат целия файл непроменен през
// tests/helpers/load-app.mjs (виж коментарите там за детайли/ограничения).
//
// Пускане: npm test  (или node --test tests/*.test.mjs)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadAppModule } from "./helpers/load-app.mjs";

// Обектите, върнати от Vault/Keys/Storage, идват от изолиран vm sandbox
// (различен JS "realm" от този тестов файл) — Node.js assert.deepEqual
// сравнява и прототипната верига, затова структурно еднакви обекти от
// различни realm-ове се отчитат като "не еднакви" (Node hint: "same
// structure but not reference-equal"). За тези чисто JSON-сериализуеми
// данни (API ключове/state обекти) сравняваме по сериализирана форма —
// това е коректно и напълно достатъчно тук, не крие функционален проблем.
function assertDeepJSON(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

describe("Storage", () => {
  test("get() връща fallback, ако ключът липсва", () => {
    const { Storage } = loadAppModule();
    assert.equal(Storage.get("missing_key", "default"), "default");
  });

  test("set()/get() round-trip за обект", () => {
    const { Storage } = loadAppModule();
    const obj = { a: 1, b: ["x", "y"] };
    Storage.set("k1", obj);
    assertDeepJSON(Storage.get("k1"), obj);
  });

  test("get() връща fallback (не хвърля), ако данните в localStorage са счупен JSON", () => {
    const { Storage, localStorage } = loadAppModule();
    localStorage.setItem("broken", "{not valid json");
    assert.equal(Storage.get("broken", "fallback-value"), "fallback-value");
  });

  test("remove() трие ключа", () => {
    const { Storage } = loadAppModule();
    Storage.set("k2", { x: 1 });
    Storage.remove("k2");
    assert.equal(Storage.has("k2"), false);
  });

  test("getRaw()/setRaw() работят с чист текст, без JSON обвивка", () => {
    const { Storage } = loadAppModule();
    Storage.setRaw("flag", "1");
    assert.equal(Storage.getRaw("flag"), "1");
  });
});

describe("Keys (преди включен Vault)", () => {
  test("load() връща празен обект по подразбиране", () => {
    const { Keys } = loadAppModule();
    assertDeepJSON(Keys.load(), {});
  });

  test("save()/load() round-trip, пази се като чист текст в localStorage", () => {
    const { Keys, localStorage, KEYS_STORAGE } = loadAppModule();
    Keys.save({ claude: "sk-ant-xyz" });
    assertDeepJSON(Keys.load(), { claude: "sk-ant-xyz" });
    // изрично потвърждаваме документираното в кода поведение: без Vault,
    // ключовете стоят в ЧИСТ текст в localStorage
    assert.equal(
      localStorage.getItem(KEYS_STORAGE),
      JSON.stringify({ claude: "sk-ant-xyz" })
    );
  });
});

describe("Vault (криптиране на ключовете)", () => {
  test("isEnabled() е false по подразбиране", () => {
    const { Vault } = loadAppModule();
    assert.equal(Vault.isEnabled(), false);
    assert.equal(Vault.isUnlocked(), false);
  });

  test("enable() отказва парола под 6 символа", async () => {
    const { Vault } = loadAppModule();
    await assert.rejects(() => Vault.enable("abc"), /поне 6 символа/);
  });

  test("enable() криптира съществуващите ключове и трие чистия текст от localStorage", async () => {
    const { Vault, Keys, localStorage, KEYS_STORAGE, VAULT_ENC_KEY } = loadAppModule();
    Keys.save({ claude: "sk-ant-secret", gemini: "gm-secret" });
    assert.equal(localStorage.getItem(KEYS_STORAGE) !== null, true); // чист текст ПРЕДИ enable

    await Vault.enable("my-passphrase-123");

    assert.equal(Vault.isEnabled(), true);
    assert.equal(Vault.isUnlocked(), true);
    // чистият текст трябва да изчезне от диска завинаги
    assert.equal(localStorage.getItem(KEYS_STORAGE), null);
    // на негово място — криптиран blob (salt/iv/data), не четим текст
    const blob = JSON.parse(localStorage.getItem(VAULT_ENC_KEY));
    assert.ok(blob.salt && blob.iv && blob.data);
    assert.doesNotMatch(localStorage.getItem(VAULT_ENC_KEY), /sk-ant-secret/);
  });

  test("Keys.load() след enable() чете от RAM (Vault._plain), не от диска", async () => {
    const { Vault, Keys } = loadAppModule();
    Keys.save({ claude: "sk-ant-secret" });
    await Vault.enable("my-passphrase-123");
    assertDeepJSON(Keys.load(), { claude: "sk-ant-secret" });
  });

  test("lock() изчиства RAM копието — Keys.load() връща празно, докато не се отключи пак", async () => {
    const { Vault, Keys } = loadAppModule();
    Keys.save({ claude: "sk-ant-secret" });
    await Vault.enable("my-passphrase-123");
    Vault.lock();
    assert.equal(Vault.isUnlocked(), false);
    assertDeepJSON(Keys.load(), {});
  });

  test("unlock() с правилна парола връща същите ключове", async () => {
    const { Vault } = loadAppModule();
    await Vault.enable("correct-horse-battery");
    Vault.lock();
    const result = await Vault.unlock("correct-horse-battery");
    assertDeepJSON(result, {});
  });

  test("unlock() с грешна парола хвърля 'Грешна парола.' и НЕ отключва", async () => {
    const { Vault } = loadAppModule();
    await Vault.enable("correct-horse-battery");
    Vault.lock();
    await assert.rejects(() => Vault.unlock("wrong-password"), /Грешна парола/);
    assert.equal(Vault.isUnlocked(), false);
  });

  test("disable() с правилна парола връща ключовете обратно в чист текст", async () => {
    const app = loadAppModule();
    app.Keys.save({ claude: "sk-ant-secret" });
    await app.Vault.enable("my-passphrase-123");

    await app.Vault.disable("my-passphrase-123");

    assert.equal(app.Vault.isEnabled(), false);
    assert.equal(app.Vault.isUnlocked(), false);
    assert.deepEqual(
      JSON.parse(app.localStorage.getItem(app.KEYS_STORAGE)),
      { claude: "sk-ant-secret" }
    );
    assert.equal(app.localStorage.getItem(app.VAULT_ENC_KEY), null);
    assert.equal(app.localStorage.getItem(app.VAULT_FLAG_KEY), null);
  });

  test("disable() с грешна парола хвърля грешка и НЕ трие криптирания blob", async () => {
    const app = loadAppModule();
    app.Keys.save({ claude: "sk-ant-secret" });
    await app.Vault.enable("my-passphrase-123");

    await assert.rejects(() => app.Vault.disable("wrong-pass"), /Грешна парола/);
    // криптираният blob трябва да СИ СТОИ — не сме го изтрили при неуспешен disable
    assert.notEqual(app.localStorage.getItem(app.VAULT_ENC_KEY), null);
    assert.equal(app.Vault.isEnabled(), true);
  });

  test("две различни Vault инстанции (различни localStorage) не си пречат — изолация между тестове", async () => {
    const app1 = loadAppModule();
    const app2 = loadAppModule();
    app1.Keys.save({ claude: "secret-1" });
    await app1.Vault.enable("passphrase-one");
    assert.equal(app2.Vault.isEnabled(), false); // app2 е чист, независим localStorage
  });
});
