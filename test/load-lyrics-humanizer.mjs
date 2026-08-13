import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LYRICS_HUMANIZER_JS_PATH = path.join(__dirname, "..", "js", "lyrics-humanizer.js");

/**
 * Зарежда js/lyrics-humanizer.js БЕЗ да го променя — изпълнява
 * оригиналния текст на файла във vm контекст (същия подход като
 * load-niche-scoring.mjs), за да достъпим LyricsHumanizer за тестове
 * точно както браузърът би го видял (глобален <script>, не ES module).
 *
 * judge() ползва глобалните callGemini()/extractJson() (дефинирани в
 * js/providers/gemini.js / js/ai-helpers.js в реалния браузър) — тук
 * подаваме mock версии през sandbox, за да тестваме judge() изолирано,
 * без реална мрежова заявка.
 */
export function loadLyricsHumanizer({ callGemini, extractJson } = {}) {
  const code = fs.readFileSync(LYRICS_HUMANIZER_JS_PATH, "utf8");
  const sandbox = {
    console,
    document: { getElementById: () => null },
    module: { exports: {} },
    callGemini: callGemini || (async () => { throw new Error("no key"); }),
    extractJson: extractJson || (text => JSON.parse(text))
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: LYRICS_HUMANIZER_JS_PATH });
  return sandbox.module.exports.LyricsHumanizer || sandbox.LyricsHumanizer;
}
