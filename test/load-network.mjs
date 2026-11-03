import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NETWORK_JS_PATH = path.join(__dirname, "..", "js", "network.js");

/**
 * Зарежда js/network.js БЕЗ да го променя — изпълнява оригиналния текст на
 * файла във vm контекст, за да достъпим fetchTimeout/proxied за тестове,
 * точно както браузърът би ги видял като глобални функции (класически
 * <script>, не ES module — виж коментара в самия network.js).
 *
 * keysStub замества глобалния `Keys` (реално дефиниран в app.js) — тук
 * подаваме само каквото proxied() чете (k.proxyUrl), без да зареждаме
 * целия app.js (той разчита на window/DOM/localStorage, които не
 * съществуват в Node).
 *
 * Връща обект с fetchTimeout/proxied функции + самия sandbox, за да може
 * тест да презапише sandbox.fetch между отделни извиквания (мокване).
 */
export function loadNetworkModule(keysStub = { load: () => ({ proxyUrl: "" }) }) {
  const code = fs.readFileSync(NETWORK_JS_PATH, "utf8");
  const sandbox = {
    Keys: keysStub,
    console,
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: NETWORK_JS_PATH });
  return { fetchTimeout: sandbox.fetchTimeout, proxied: sandbox.proxied, sandbox };
}
