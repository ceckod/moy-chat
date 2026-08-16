/* =========================================================
   ОБЩ FALLBACK/RETRY ЦИКЪЛ ЗА PROVIDERS (стъпка 7 от одита) — извлечен
   от callClaude/callGeminiWithFallback/callOpenRouter, където преди
   това всеки провайдър имаше свое собствено, почти идентично копие на
   логиката "пробвай моделите по ред, при грешка провери дали да
   превключиш на следващия".

   ВАЖНО: тук се пазят НАПЪЛНО нюансите на всеки provider — кои HTTP
   кодове означават "смени модела" срещу "спри веднага", дали да се
   retry-ва СЪЩИЯТ модел преди да се откаже, дали грешката се логва.
   Всичко това се решава от provider-специфичната classify() функция,
   подадена от съответния providers/*.js файл — този файл не решава
   ТЕЗИ неща сам, само изпълнява каквото classify() върне.

   Зависи от: Storage/AICallLog/QuotaTracker/toast (app.js), AgentRoster
   (js/agent-roster.js) — зареден преди този файл в index.html. Реално
   се ползват само ВЪТРЕ в runModelFallbackLoop() (при действително
   извикване по-късно), затова редът в HTML не чупи нищо дори app.js
   да се зареди след този файл — виж същата бележка в providers/claude.js.

   Публичен интерфейс:
     - runModelFallbackLoop(models, attemptFn, opts)

   opts:
     provider          — "claude" | "gemini" | "openrouter" (за AICallLog/QuotaTracker)
     classify(e, model, retries) — връща едно от:
       { action: "abort" }
         — спри веднага, хвърли грешката (лог се пише, освен ако log:false)
       { action: "retry", waitMs, waitMsg }
         — изчакай waitMs (ако е зададено) и пробвай СЪЩИЯ модел пак;
           само ако retries < maxRetriesPerModel, иначе се третира като "next"
       { action: "next", removeReason, switchMsg(nextModel), cacheClearKey, note, log, removeFromRoster }
         — маха модела (освен ако removeFromRoster:false), показва switchMsg
           (ако е зададена функция и има следващ модел), продължава със
           следващия модел от списъка
     maxRetriesPerModel — max брой "retry" преди да се третира като "next" (default 0)
     exhaustedMsg        — текст на грешката, ако ВСИЧКИ модели се провалят
   ========================================================= */

async function runModelFallbackLoop(models, attemptFn, opts) {
  const maxRetriesPerModel = opts.maxRetriesPerModel || 0;
  let lastError;

  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    let retries = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const result = await attemptFn(model);
        AICallLog.record({ provider: opts.provider, model, ok: true });
        QuotaTracker.record(opts.provider, model);
        // CostTracker (js/cost-tracker.js) — четем usage-а, оставен от
        // providers/claude.js или providers/gemini.js точно преди return,
        // ако е наличен (OpenRouter/ModelFinder не го задават — не пращат
        // usage, не се калкулира $ разход за тях по дизайн).
        if (typeof CostTracker !== "undefined" && _lastAICallUsage) {
          CostTracker.record(opts.provider, model, _lastAICallUsage.input, _lastAICallUsage.output);
          _lastAICallUsage = null;
        }
        return result;
      } catch (e) {
        lastError = e;
        const verdict = opts.classify(e, model, retries) || { action: "abort" };

        if (verdict.action === "retry" && retries < maxRetriesPerModel) {
          retries++;
          if (verdict.waitMs) {
            if (verdict.waitMsg) toast(verdict.waitMsg, verdict.waitMs + 500);
            await new Promise(r => setTimeout(r, verdict.waitMs));
          }
          continue; // същия модел пак
        }

        if (verdict.log !== false) {
          AICallLog.record({ provider: opts.provider, model, ok: false, note: (verdict.note || e.message || "").slice(0, 140) });
        }

        if (verdict.cacheClearKey) {
          try { Storage.remove(verdict.cacheClearKey); } catch (e2) { /* noop */ }
        }

        if (verdict.action === "abort") throw e;

        // action === "next" (включително "retry" с изчерпани опити)
        if (verdict.removeFromRoster !== false && typeof AgentRoster !== "undefined") {
          AgentRoster.removeModel(opts.provider, model, verdict.removeReason || ("HTTP " + e.status));
        }
        if (verdict.switchMsg && m < models.length - 1) {
          toast(verdict.switchMsg(models[m + 1]), verdict.switchMsgDuration || 4500);
        }
        break; // към следващия модел
      }
    }
  }
  throw lastError || new Error(opts.exhaustedMsg || (opts.provider + " грешка: неуспешно след всички модели"));
}
