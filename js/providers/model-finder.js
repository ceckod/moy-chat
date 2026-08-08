/* =========================================================
   MODEL FINDER BRIDGE — свързва вградения инструмент "AI Model Finder"
   (папка /ai-model-finder/, обединен от отделен проект на 2026-08-08) с
   основното табло. НЕ е нов AI провайдър за Стъпка 1-3 (не пипа
   Claude/Gemini/OpenRouter fallback-а) — само чете резултата от скрейпъра
   (ai-model-finder/ai-models.json) и го показва в Настройки → API Ключове,
   за да знаеш кои допълнителни безплатни модели/ключове са налични.

   Зависи от: js/network.js (fetchTimeout) — зареден преди този файл в
   index.html.

   Публичен интерфейс:
     - ModelFinder.render()   — показва списъка в #modelFinderOut
     - ModelFinder.refresh()  — force-reload на ai-models.json (без кеш)
   ========================================================= */

const MODEL_FINDER_CACHE_KEY = "cdb_model_finder_cache_v1";
const MODEL_FINDER_CACHE_HOURS = 6;
const MODEL_FINDER_JSON_PATH = "ai-model-finder/ai-models.json";

const ModelFinder = {
  async _load(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = Storage.get(MODEL_FINDER_CACHE_KEY);
      if (cached && Array.isArray(cached.models) &&
          (Date.now() - cached.ts) < MODEL_FINDER_CACHE_HOURS * 3600 * 1000) {
        return cached;
      }
    }
    try {
      const r = await fetchTimeout(MODEL_FINDER_JSON_PATH + "?t=" + Date.now(), {}, 15000);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const models = Array.isArray(data) ? data : (data.models || []);
      const result = { ts: Date.now(), models, generatedAt: data.generated_at || data.generatedAt || null };
      Storage.set(MODEL_FINDER_CACHE_KEY, result);
      return result;
    } catch (e) {
      return { ts: Date.now(), models: [], error: e.message };
    }
  },

  async refresh() {
    await this._load(true);
    return this.render();
  },

  async render() {
    const out = document.getElementById("modelFinderOut");
    if (!out) return;
    out.textContent = "⏳ Зареждам ai-model-finder/ai-models.json...";
    const { models, error, generatedAt } = await this._load();
    if (error) {
      out.innerHTML = `<span style="color:var(--danger,#e5484d)">⚠️ Още няма генериран списък (${error}). ` +
        `Отвори <a href="ai-model-finder/index.html" target="_blank" rel="noopener">AI Model Finder</a> и натисни ` +
        `„Намери ми AI модели", или пусни GitHub Action-а „AI Model Finder — обновяване на модели" веднъж ръчно.</span>`;
      return;
    }
    if (!models.length) {
      out.textContent = "Няма намерени модели все още — отвори AI Model Finder и генерирай списъка.";
      return;
    }
    const rows = models.slice(0, 50).map(m => {
      const id = m.id || m.model || m.name || "?";
      const provider = m.provider || m.source || "";
      const auth = m.auth?.type || m.auth || "";
      const keyEnv = m.key_env || m.auth?.key_env || "";
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border,#2a2a3a);">` +
        `<strong>${id}</strong>` +
        (provider ? ` <span class="muted">· ${provider}</span>` : "") +
        (auth ? ` <span class="optional-tag">${auth}${keyEnv ? " (" + keyEnv + ")" : ""}</span>` : "") +
        `</div>`;
    }).join("");
    out.innerHTML =
      (generatedAt ? `<p class="muted" style="margin-bottom:8px;">Последно обновено: ${generatedAt}</p>` : "") +
      `<p class="muted" style="margin-bottom:8px;">${models.length} открити модела (показани първите ${Math.min(50, models.length)}):</p>` +
      rows;
  }
};
