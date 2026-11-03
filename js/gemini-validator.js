/* =========================================================
   GEMINI VALIDATOR — малък модул за "втори поглед"
   Автоматично прави бърз анализ на резултата от ВСЯКА стъпка
   (без да чака потребителя да натисне бутон), и трупа лог.

   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, втора итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   callGemini(), AppState.
   ========================================================= */
const GeminiValidator = {
  // fire-and-forget: не блокира основния workflow, ако Gemini ключ липсва/грешка
  autoReview(stepLabel, content) {
    this.review(stepLabel, content)
      .then(text => this._log(stepLabel, text))
      .catch(e => this._log(stepLabel, "⚠️ Пропуснат авто-анализ: " + e.message));
  },

  async review(stepLabel, content) {
    const prompt = `Ти си "втори поглед" (validator) в музикален production pipeline.
Стъпка: "${stepLabel}"
Съдържание за анализ:
---
${content}
---
Дай МАКСИМУМ 3 кратки изречения: (1) бърза оценка има ли проблем/риск,
(2) дали е готово за следваща стъпка, (3) ако не, кратка препоръка.
Пиши директно, без встъпление.`;
    return await callGemini(prompt);
  },

  _log(stepLabel, text) {
    const entry = { label: stepLabel, time: new Date().toLocaleTimeString("bg-BG"), text };
    AppState.data.project.geminiLog = AppState.data.project.geminiLog || [];
    AppState.data.project.geminiLog.unshift(entry);
    AppState.data.project.geminiLog = AppState.data.project.geminiLog.slice(0, 20);
    AppState.save();
    this.render();
  },

  render() {
    const el = document.getElementById("geminiOut");
    const log = (AppState.data.project.geminiLog || []);
    const countChip = document.getElementById("dashValidatorCount");
    if (countChip) countChip.textContent = log.length;
    if (!el) return;
    if (!log.length) { el.textContent = "Все още няма анализи — ще се появят автоматично след всяка стъпка."; return; }
    el.innerHTML = log.map(e =>
      `<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
        <strong>${e.label}</strong> <span class="muted">· ${e.time}</span><br>${e.text}
      </div>`).join("");
  }
};
