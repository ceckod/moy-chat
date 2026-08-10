import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NICHE_SCORING_JS_PATH = path.join(__dirname, "..", "js", "niche-scoring.js");

/**
 * Зарежда js/niche-scoring.js БЕЗ да го променя — изпълнява оригиналния
 * текст на файла във vm контекст (същия подход като load-network.mjs),
 * за да достъпим NicheScoring за тестове точно както браузърът би го
 * видял (глобален <script>, не ES module).
 */
export function loadNicheScoring() {
  const code = fs.readFileSync(NICHE_SCORING_JS_PATH, "utf8");
  const sandbox = { console, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: NICHE_SCORING_JS_PATH });
  return sandbox.module.exports.NicheScoring || sandbox.NicheScoring;
}
