/* =========================================================
   AGENT ROSTER — "работещи AI агенти ДНЕС" (Claude/Gemini/OpenRouter).

   Проблем, който решава: getClaudeModelList/getGeminiModelList/
   getOpenRouterFreeModels() връщат ПЪЛНИЯ списък модели, достъпни за
   ключа (при OpenRouter — всички безплатни модели в платформата, може
   да са десетки). Досега всяко реално извикване (callClaude/callGemini/
   callOpenRouter) тръгваше от този пълен списък и опитваше моделите
   един по един при грешка — на практика "рови между 1000 агента" и
   потребителят чака, докато не удари някой работещ.

   Решение: ОТДЕЛЕН, компактен "ростър" — временен файл в localStorage
   (виж AGENT_ROSTER_KEY), който се строи МАКСИМУМ веднъж на 24ч (виж
   AGENT_ROSTER_TTL_HOURS) чрез реална, евтина проверка ("hi" prompt) на
   първите AGENT_ROSTER_TEST_CAP модела (подредени по историческа
   надеждност — виж AICallLog.sortByReliability) на всеки provider, за
   който има зададен ключ. Пази се САМО списъкът модели, които РЕАЛНО
   отговориха успешно в момента на проверката.

   callClaude/callGeminiWithFallback/callOpenRouter (виж providers/*.js)
   ползват getWorking(provider) като ПЪРВИ избор — малкия, вече проверен
   списък — вместо целия суров списък. Пълният списък се държи само като
   резервен опашка накрая, ако всичко от ростъра гръмне.

   Ако даден модел удари квота (429/529 при Claude, 429 изчерпана дневна
   квота при Gemini, 429/503 при OpenRouter) или изчезне (404 — Google
   понякога преименува/маха модели), veднага се маха от ростъра чрез
   removeModel() — НЕ чака следващото дневно опресняване. Така
   следващата задача същия ден автоматично прескача агента, без да го
   пробва отново и без ново мрежово повикване.

   Зависи от: Storage/Keys/AICallLog (app.js), fetchTimeout (network.js),
   getClaudeModelList/getGeminiModelList/getOpenRouterFreeModels
   (providers/*.js) — зареден СЛЕД network.js, ПРЕДИ providers/*.js в
   index.html (самите извиквания стават по-късно, при реално използване,
   така редът на <script> тагове не чупи нищо — виж бележката в
   providers/claude.js).
   ========================================================= */

const AGENT_ROSTER_KEY = "cdb_agent_roster_v1";
const AGENT_ROSTER_TTL_HOURS = 24;
// Колко модела максимум да се пингват РЕАЛНО при всяко опресняване на
// ростъра, за provider — държи проверката бърза дори ако суровият списък
// (особено при OpenRouter) съдържа десетки безплатни модели.
const AGENT_ROSTER_TEST_CAP = 8;

const AgentRoster = {
  _load() {
    try { return Storage.get(AGENT_ROSTER_KEY); } catch (e) { return null; }
  },
  _save(data) {
    Storage.set(AGENT_ROSTER_KEY, data);
    this._renderIfVisible();
  },

  isStale(data) {
    data = data || this._load();
    if (!data || !data.ts || !data.providers) return true;
    return (Date.now() - data.ts) > AGENT_ROSTER_TTL_HOURS * 3600 * 1000;
  },

  // Работещите модели за provider, ЧИСТО ОТ КЕША (без мрежово извикване) —
  // това ползват providers/*.js вместо пълния суров списък. Връща null,
  // ако ростърът никога не е строен или няма запис за този provider
  // (напр. ключът е добавен СЛЕД последното опресняване).
  getWorking(provider) {
    const data = this._load();
    if (!data || !data.providers || !Array.isArray(data.providers[provider])) return null;
    return [...data.providers[provider]];
  },

  lastUpdated() {
    const data = this._load();
    return data ? data.ts : null;
  },

  // Маха модел от ростъра ВЕДНАГА (квота/невъзстановима грешка), без да
  // чака следващото дневно опресняване — виж бележката най-горе.
  removeModel(provider, model, reason) {
    const data = this._load();
    if (!data || !data.providers || !Array.isArray(data.providers[provider])) return;
    const before = data.providers[provider].length;
    data.providers[provider] = data.providers[provider].filter(m => m !== model);
    if (data.providers[provider].length !== before) {
      this._save(data);
      console.warn(`AgentRoster: премахнат "${model}" (${provider}) от днешния ростър — ${reason || "грешка"}`);
    }
  },

  hasAnyKey(k) {
    k = k || Keys.load();
    return !!(k.claude || k.gemini || k.openrouterKey);
  },

  // Задължителната проверка "след влизане в сайта" (виж #rosterGateOverlay
  // в index.html) — само ако има поне един AI ключ И ростърът липсва/е
  // по-стар от AGENT_ROSTER_TTL_HOURS часа.
  needsRefresh() {
    if (!this.hasAnyKey()) return false;
    return this.isStale();
  },

  /* ---------- ЗАДЪЛЖИТЕЛЕН ЕКРАН ПРИ ВЛИЗАНЕ ---------- */
  // Вика се при DOMContentLoaded, след отключване на Auth Gate и след
  // отключване на Vault-а (виж app.js/auth-gate.js) — на всяко от тези
  // места API ключовете може току-що да са станали достъпни.
  maybeShowGate() {
    const overlay = document.getElementById("rosterGateOverlay");
    if (!overlay) return;
    if (this.needsRefresh()) {
      overlay.style.display = "flex";
      this._renderGateStatus();
    } else {
      overlay.style.display = "none";
    }
  },

  _renderGateStatus() {
    const el = document.getElementById("rosterGateStatus");
    if (!el) return;
    const data = this._load();
    el.textContent = data
      ? `Последна проверка: ${new Date(data.ts).toLocaleString("bg-BG")} — по-стара от ${AGENT_ROSTER_TTL_HOURS}ч, трябва опресняване.`
      : "Още няма проверени AI агенти на това устройство.";
  },

  // Вика се от бутона на #rosterGateOverlay.
  async runGateRefresh() {
    const btn = document.getElementById("rosterGateBtn");
    const out = document.getElementById("rosterGateStatus");
    if (btn) btn.disabled = true;
    try {
      const summary = await this.refresh((line) => { if (out) out.textContent = line; });
      if (out) out.textContent = "✅ " + summary;
      toast("✅ Списъкът с работещи AI агенти е обновен");
      const overlay = document.getElementById("rosterGateOverlay");
      if (overlay) overlay.style.display = "none";
    } catch (e) {
      if (out) out.textContent = "❌ " + e.message;
      toast("❌ " + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // Вика се от бутона в Настройки → API Ключове (ръчно опресняване по избор,
  // не само от задължителния екран).
  async manualRefresh() {
    const out = document.getElementById("agentRosterOut");
    if (out) out.textContent = "⏳ Проверявам кои AI агенти отговарят точно сега...";
    try {
      const summary = await this.refresh((line) => { if (out) out.textContent = line; });
      toast("✅ " + summary);
      this.render();
    } catch (e) {
      if (out) out.textContent = "❌ " + e.message;
      toast("❌ " + e.message);
    }
  },

  /* ---------- РЕАЛНАТА ПРОВЕРКА ----------
     Тества до AGENT_ROSTER_TEST_CAP модела на всеки provider с ключ,
     подредени по историческа надеждност, и пази САМО тези, които РЕАЛНО
     отговориха. onProgress(text) е по избор — за живо обновяване на
     статус реда в overlay/Настройки, докато тече проверката. */
  async refresh(onProgress) {
    const k = Keys.load();
    if (!this.hasAnyKey(k)) throw new Error("Няма зададен нито един AI ключ (Claude/Gemini/OpenRouter) — виж Настройки → API Ключове");

    const data = { ts: Date.now(), providers: {} };
    const lines = [];

    if (k.claude) {
      if (onProgress) onProgress("⏳ Проверявам Claude модели...");
      try {
        data.providers.claude = await this._testClaude(k.claude);
      } catch (e) { data.providers.claude = []; }
      lines.push(`Claude ${data.providers.claude.length ? "✅ " + data.providers.claude.length + " работещи" : "❌ нито един"}`);
    }
    if (k.gemini) {
      if (onProgress) onProgress("⏳ Проверявам Gemini модели...");
      try {
        data.providers.gemini = await this._testGemini(k.gemini);
      } catch (e) { data.providers.gemini = []; }
      lines.push(`Gemini ${data.providers.gemini.length ? "✅ " + data.providers.gemini.length + " работещи" : "❌ нито един"}`);
    }
    if (k.openrouterKey) {
      if (onProgress) onProgress("⏳ Проверявам OpenRouter безплатни модели...");
      try {
        data.providers.openrouter = await this._testOpenRouter(k.openrouterKey);
      } catch (e) { data.providers.openrouter = []; }
      lines.push(`OpenRouter ${data.providers.openrouter.length ? "✅ " + data.providers.openrouter.length + " работещи" : "❌ нито един"}`);
    }

    this._save(data);
    return lines.join(" · ");
  },

  async _testClaude(apiKey) {
    const raw = AICallLog.sortByReliability("claude", await getClaudeModelList(apiKey, true));
    const working = [];
    for (const model of raw.slice(0, AGENT_ROSTER_TEST_CAP)) {
      try {
        const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey,
                     "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
        }, 15000);
        if (r.ok) { working.push(model); AICallLog.record({ provider: "claude", model, ok: true, note: "ростър" }); }
        else AICallLog.record({ provider: "claude", model, ok: false, note: "ростър: HTTP " + r.status });
      } catch (e) { /* мрежова грешка/timeout — пропусни модела, не чупи проверката */ }
    }
    return working;
  },

  async _testGemini(apiKey) {
    const raw = AICallLog.sortByReliability("gemini", await getGeminiModelList(apiKey, true));
    const working = [];
    for (const model of raw.slice(0, AGENT_ROSTER_TEST_CAP)) {
      try {
        const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
        }, 15000);
        if (r.ok) { working.push(model); AICallLog.record({ provider: "gemini", model, ok: true, note: "ростър" }); }
        else AICallLog.record({ provider: "gemini", model, ok: false, note: "ростър: HTTP " + r.status });
      } catch (e) { /* пропусни */ }
    }
    return working;
  },

  async _testOpenRouter(apiKey) {
    const all = AICallLog.sortByReliability("openrouter", await getOpenRouterFreeModels(true));
    const working = [];
    for (const model of all.slice(0, AGENT_ROSTER_TEST_CAP)) {
      try {
        const r = await fetchTimeout("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          // max_tokens по-висок от 5 нарочно: някои безплатни модели, рутирани
          // през Google AI Studio (Gemini free варианти), връщат 400
          // INVALID_ARGUMENT при много малък max_tokens (недостатъчен бюджет
          // за вътрешния им "thinking" стъп) — 16 е достатъчно за "hi" теста,
          // без да бави реално проверката.
          body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
        }, 15000);
        if (r.ok) { working.push(model); AICallLog.record({ provider: "openrouter", model, ok: true, note: "ростър" }); }
        else AICallLog.record({ provider: "openrouter", model, ok: false, note: "ростър: HTTP " + r.status });
      } catch (e) { /* пропусни */ }
    }
    return working;
  },

  /* ---------- НАСТРОЙКИ: панел с текущия ростър ---------- */
  render() {
    const el = document.getElementById("agentRosterOut");
    if (!el) return;
    const data = this._load();
    if (!data) { el.textContent = "Още няма изграден списък с работещи агенти. Натисни бутона по-горе."; return; }
    const ageH = Math.round((Date.now() - data.ts) / 3600000 * 10) / 10;
    const lines = [`Обновено преди ~${ageH}ч (${new Date(data.ts).toLocaleString("bg-BG")}, изтича след ${AGENT_ROSTER_TTL_HOURS}ч):`];
    for (const p of ["claude", "gemini", "openrouter"]) {
      if (!data.providers[p]) continue;
      const label = p === "claude" ? "Claude" : p === "gemini" ? "Gemini" : "OpenRouter";
      lines.push(`${label}: ${data.providers[p].length ? data.providers[p].join(", ") : "(нито един работещ в момента)"}`);
    }
    el.textContent = lines.join("\n");
  },

  _renderIfVisible() {
    if (document.getElementById("agentRosterOut")) this.render();
  }
};
