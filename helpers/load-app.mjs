import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = path.join(__dirname, "..", "app.js");

/**
 * Проста in-memory реализация на localStorage (Web Storage интерфейс),
 * за да не пипаме диска и всеки тест да тръгва от чисто състояние.
 */
function createMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
    // достъп за самите тестове, за да проверят "чист текст на диска" директно
    _raw: store,
  };
}

/**
 * Зарежда app.js (ЦЕЛИЯ файл, непроменен) във vm контекст с минимални
 * browser-like stub-ове (window/document/localStorage/crypto/btoa/atob),
 * за да можем да достъпим Vault/Keys/Storage/AppState за тестове.
 *
 * ПРОВЕРЕНО (виж AUDIT_PROGRESS.md): app.js има само ЕДНО изпълнимо нещо
 * на топ ниво — регистрация на 'DOMContentLoaded' listener — затова
 * зареждането му в изолирана среда е безопасно, стига window.addEventListener
 * да съществува (тук е no-op stub, listener-ът просто не се тригва).
 *
 * Top-level `const`/`let` в script (не module) НЕ стават свойства на
 * sandbox обекта директно — затова ги "изваждаме" с допълнителен
 * vm.runInContext() след първоначалното изпълнение (легитимна vm техника:
 * лексикалният global scope се пази между отделни runInContext извиквания
 * в един и същ context).
 */
export function loadAppModule({ localStorage: localStorageOverride } = {}) {
  const code = fs.readFileSync(APP_JS_PATH, "utf8");
  const localStorageStub = localStorageOverride || createMemoryLocalStorage();

  const documentStub = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
    }),
    addEventListener() {},
    head: { appendChild() {} },
    body: { appendChild() {} },
  };

  const windowStub = {
    crypto: webcrypto,
    addEventListener() {}, // прихваща DOMContentLoaded регистрацията, не я тригва
    location: { href: "http://localhost/", search: "" },
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage: localStorageStub,
    crypto: webcrypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    fetch: globalThis.fetch,
    console,
    navigator: { credentials: undefined },
    Chart: undefined, // Chart.js от CDN — не се ползва при зареждане, само при рендер
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: APP_JS_PATH });

  // "Изваждаме" нужните top-level const-ове от лексикалния global scope
  const extracted = vm.runInContext(
    "({ Vault, Keys, Storage, AppState, VAULT_ENC_KEY, VAULT_FLAG_KEY, KEYS_STORAGE, STORAGE_KEY })",
    sandbox
  );

  return { ...extracted, sandbox, localStorage: localStorageStub };
}
