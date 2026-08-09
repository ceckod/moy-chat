/* =========================================================
   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, пета итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   AppState, callAI(), extractJson(), GeminiValidator, toast().
   ========================================================= */
/* =========================================================
   STEP 2 — Suno & Визуализатор
   (Основната видео логика ще се вгради тук след като предоставиш
    кода на съществуващия си визуализатор)
   ========================================================= */
const Step2 = {
  syncTitleToVisualizer() {
    const frame = document.getElementById("visualizerFrame");
    if (!frame || !frame.contentWindow) return;
    const title = AppState.data.project.title || "";
    const send = () => frame.contentWindow.postMessage({ type: "cdb-set-title", title }, "*");
    // ако iframe вече е зареден - изпращаме веднага; иначе чакаме load-а му
    if (frame.dataset.loaded === "true") send();
    else frame.addEventListener("load", () => { frame.dataset.loaded = "true"; send(); }, { once: true });
  },

  async generateFxConfig() {
    const niche = AppState.data.project.chosenNiche || "pop";
    const prompt = `Генерирай JSON конфигурация за видео ефекти (FX) подходящи за музикален жанр "${niche}".
Включи полета: pulse_on_bass (bool), glitch_intensity (0-1), color_grade (string, напр. "warm cinematic"),
particle_effect (string или null), transition_style (string).
Върни САМО чист JSON, без обяснения.`;
    document.getElementById("fxConfigOut").value = "⏳ Генерирам...";
    try {
      const raw = await callAI(prompt, 300);
      const parsed = extractJson(raw);
      document.getElementById("fxConfigOut").value = JSON.stringify(parsed, null, 2);
      AppState.data.project.fxConfig = JSON.stringify(parsed);
      AppState.save();

      GeminiValidator.autoReview("Стъпка 2 — FX конфигурация", JSON.stringify(parsed));
    } catch (e) {
      document.getElementById("fxConfigOut").value = "";
      toast("Грешка: " + e.message);
    }
  }
  // TODO: renderVisualizer() — ще бъде добавена тук след интеграция
  // на съществуващия ти HTML/JS визуализатор (видео1 + видео2 + лого).
};
