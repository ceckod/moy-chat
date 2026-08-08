import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(__dirname, "..", "js", "providers");
const FALLBACK_LOOP_PATH = path.join(PROVIDERS_DIR, "fallback-loop.js");

/**
 * Зарежда js/providers/fallback-loop.js + един provider файл (claude.js /
 * gemini.js / openrouter.js) БЕЗ да ги променя — изпълнява оригиналния
 * текст на файловете във vm контекст, точно както браузърът би ги видял
 * като глобални <script> тагове един след друг (fallback-loop.js се
 * зарежда първо в index.html, преди providers/*.js).
 *
 * Подава минимални заглушки за зависимостите от app.js/agent-roster.js
 * (Storage/Keys/toast/AICallLog/QuotaTracker/AgentRoster/ModelPref) —
 * тестовете подават свои собствени mock-ове през `overrides`, за да
 * следят точно какво е било извикано.
 */
export function loadProviderModule(providerFileName, overrides = {}) {
  const fallbackLoopCode = fs.readFileSync(FALLBACK_LOOP_PATH, "utf8");
  const providerCode = fs.readFileSync(path.join(PROVIDERS_DIR, providerFileName), "utf8");

  const noop = () => {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: overrides.fetch || (async () => { throw new Error("fetch не е мокнат в теста"); }),
    fetchTimeout: overrides.fetchTimeout || (async () => { throw new Error("fetchTimeout не е мокнат в теста"); }),
    proxied: overrides.proxied || ((url) => url),
    Storage: overrides.Storage || { get: () => null, set: noop, remove: noop },
    Keys: overrides.Keys || { load: () => ({}) },
    toast: overrides.toast || noop,
    AICallLog: overrides.AICallLog || { record: noop },
    QuotaTracker: overrides.QuotaTracker || { record: noop },
    AgentRoster: overrides.AgentRoster || { getWorking: () => null, removeModel: noop },
    ModelPref: overrides.ModelPref || { applyTo: (_provider, list) => list },
  };
  vm.createContext(sandbox);
  vm.runInContext(fallbackLoopCode, sandbox, { filename: FALLBACK_LOOP_PATH });
  vm.runInContext(providerCode, sandbox, { filename: path.join(PROVIDERS_DIR, providerFileName) });
  return sandbox;
}
