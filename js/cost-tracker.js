/* =========================================================
   COST TRACKER — реален приблизителен $ разход (Master Prompt т.11
   "COST CONTROL"). Добавен 2026-08-16 (P1, коригирана приоритизация
   — виж PROJECT_STATE.md).

   За разлика от QuotaTracker (брои ПОВИКВАНИЯ, не $), този модул
   估算 реален разход от token usage, който providers/claude.js и
   providers/gemini.js вече връщат в суровия API отговор, но досега
   се изхвърляше (data.usage / data.usageMetadata се четяха никъде).

   Механизъм (минимална добавка, не сменя нито един публичен API):
   - providers/claude.js и providers/gemini.js записват usage-а на
     последния успешен call в глобалната променлива
     `_lastAICallUsage` точно преди да върнат текста (класически
     top-level `let`, споделен lexical scope между <script> тагове —
     същия механизъм, документиран в STORAGE_KEY/app-state.js).
   - providers/fallback-loop.js (единствената точка, която вече вика
     QuotaTracker.record() при успех) го подава на CostTracker.record()
     веднага след това и го изчиства.
   - OpenRouter/AI Model Finder НЕ пращат usage (по дизайн ползват
     предимно безплатни модели в това приложение) — не се калкулират.

   Цените в AI_PRICING_PER_1M са приблизителна ориентация по публични
   тарифи към момента на писане — НЕ официална фактура, Anthropic/
   Google сменят цените с времето.

   Публичен интерфейс:
     - CostTracker.record(provider, model, inputTokens, outputTokens)
     - CostTracker.summary() → { today, allTime, calls }
     - CostTracker.render() — прерисува #costTrackerOut
   ========================================================= */
const COST_TRACKER_KEY = "cdb_cost_tracker_v1";

// $ на 1 милион токена (input/output) — приблизително.
const AI_PRICING_PER_1M = [
  { match: /claude.*opus/i, input: 15, output: 75 },
  { match: /claude.*sonnet/i, input: 3, output: 15 },
  { match: /claude.*haiku/i, input: 0.8, output: 4 },
  { match: /gemini.*flash-lite/i, input: 0.075, output: 0.3 },
  { match: /gemini.*flash/i, input: 0.15, output: 0.6 },
  { match: /gemini.*pro/i, input: 1.25, output: 5 }
];

// Задава се от providers/claude.js и providers/gemini.js веднага преди
// return, четено веднъж от providers/fallback-loop.js след успешен call.
let _lastAICallUsage = null;

const CostTracker = {
  _today() { return new Date().toISOString().slice(0, 10); },
  _load() {
    try { return Storage.get(COST_TRACKER_KEY) || {}; } catch (e) { return {}; }
  },
  _save(data) { Storage.set(COST_TRACKER_KEY, data); },

  _priceFor(model) {
    return AI_PRICING_PER_1M.find(r => r.match.test(model)) || null;
  },

  record(provider, model, inputTokens, outputTokens) {
    if (!inputTokens && !outputTokens) return;
    const rule = this._priceFor(model);
    // Непознат модел (напр. нов Claude/Gemini, все още не в таблицата) —
    // пазим повикването в брояча, но без $ калкулация вместо грешна цена.
    const cost = rule ? (inputTokens / 1e6 * rule.input + outputTokens / 1e6 * rule.output) : 0;

    const data = this._load();
    const day = this._today();
    if (data.day !== day) { data.day = day; data.today = 0; }
    data.today = (data.today || 0) + cost;
    data.allTime = (data.allTime || 0) + cost;
    data.calls = (data.calls || 0) + 1;
    if (!rule) data.unpriced = (data.unpriced || 0) + 1;
    this._save(data);
    this._renderIfVisible();
  },

  summary() {
    const data = this._load();
    return {
      today: data.day === this._today() ? (data.today || 0) : 0,
      allTime: data.allTime || 0,
      calls: data.calls || 0,
      unpriced: data.unpriced || 0
    };
  },

  _renderIfVisible() {
    if (document.getElementById("costTrackerOut")) this.render();
  },

  render() {
    const el = document.getElementById("costTrackerOut");
    if (!el) return;
    const s = this.summary();
    el.innerHTML = `
      <div class="grid cols-2">
        <div class="kpi"><div class="label">Разход днес</div><div class="value">~$${s.today.toFixed(3)}</div></div>
        <div class="kpi"><div class="label">Общо (откакто следим)</div><div class="value">~$${s.allTime.toFixed(2)}</div></div>
      </div>
      ${s.unpriced ? `<p class="muted" style="margin-top:8px;font-size:11px;">⚠️ ${s.unpriced} извиквания са от модел без ценова таблица — не са калкулирани в сумата.</p>` : ""}
    `;
  }
};
