/* =========================================================
   MODEL PREF — кой модел се ползва "по подразбиране" за всяко
   извикване (callClaude/callGeminiWithFallback), вместо винаги да
   пробваме fallback списъка отначало (models[0]).
   Два начина да се зададе:
     - "auto"   → Settings.testKeys() пробва РЕАЛНО моделите от fallback
                  списъка по ред и хваща ПЪРВИЯ, който отговори успешно.
                  Пази се като предпочитание, докато не се промени.
     - "manual" → потребителят избира ръчно от падащото меню в Настройки.
   И в двата случая предпочитаният модел се пази в localStorage (не само
   за текущата сесия/таб, а докато не бъде презаписан/изчистен), и всяко
   място в кода, което вика модел за дадения provider, автоматично го
   ползва (виж getClaudeModelList/getGeminiModelList по-долу — те бутат
   предпочетения модел на първо място в списъка, останалите модели пак
   стоят като fallback, ако предпочетеният внезапно откаже/изчерпа квота).
   ========================================================= */
const MODEL_PREF_KEY = "cdb_model_pref_v1";

const ModelPref = {
  _load() {
    try { return Storage.get(MODEL_PREF_KEY) || {}; } catch (e) { return {}; }
  },
  _save(data) { Storage.set(MODEL_PREF_KEY, data); },

  // { model, source: "auto" | "manual" } или null, ако няма зададено предпочитание
  get(provider) {
    const data = this._load();
    return data[provider] || null;
  },
  set(provider, model, source = "manual") {
    const data = this._load();
    data[provider] = { model, source };
    this._save(data);
    this._renderIfVisible();
  },
  clear(provider) {
    const data = this._load();
    delete data[provider];
    this._save(data);
    this._renderIfVisible();
  },
  // Подрежда списък от модели, слагайки предпочетения (ако има) на първо
  // място — останалите пазят реда си като fallback.
  applyTo(provider, models) {
    const pref = this.get(provider);
    if (!pref || !models.includes(pref.model)) return models;
    return [pref.model, ...models.filter(m => m !== pref.model)];
  },
  _renderIfVisible() {
    if (document.getElementById("modelPrefOut")) Settings.renderModelPref();
  }
};
