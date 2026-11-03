/* =========================================================
   IDEA VAULT — музикални идеи (ниши/hooks/концепции), с проследяване
   "used/not used" и реално представяне след публикуване.
   Добавен 2026-08-16 (Phase 0 audit → P1).

   НЕ Е същото като "Архив на идеи от AI екипа" (js/system-test.js,
   _IDEAS_KEY "cdb_ai_ideas_v1", view "ai-ideas") — онова е за идеи за
   НОВИ ФУНКЦИИ на самия dashboard (мета, dev feedback). Idea Vault е
   за музикално-творчески идеи (ниши, hooks, концепции) — различен
   storage key, различна цел, никаква припокриване.

   Зависимости (runtime, вътре в методи): Storage, AppState, TrackRecord,
   toast() (глобални). Auto-capture points (само добавка, не пипат
   съществуваща логика):
     - js/step1.js  → _renderNicheResults() логва топ нишите
     - js/viral-lab.js → HookArena победителя логва хука

   Публичен интерфейс:
     - IdeaVault.add({text, source, niche, score})
     - IdeaVault.markUsed(id) / markRejected(id) / remove(id)
     - IdeaVault.addManual() — от текстовото поле в UI
     - IdeaVault.render() — прерисува #ideaVaultList
   ========================================================= */
const IDEA_VAULT_KEY = "cdb_idea_vault_v1";

const IdeaVault = {
  load() {
    try { return Storage.get(IDEA_VAULT_KEY) || []; } catch (e) { return []; }
  },
  saveAll(list) {
    Storage.set(IDEA_VAULT_KEY, list.slice(0, 200));
  },

  add(idea) {
    if (!idea || !idea.text) return;
    const list = this.load();
    // Не дублирай същия текст от същия източник (auto-capture се вика
    // при всяко презареждане на резултати — без това щеше да пълни
    // vault-а с идентични записи при всяко повторно сканиране).
    if (list.some(i => i.text === idea.text && i.source === idea.source)) return;
    list.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: idea.text,
      source: idea.source || "Ръчно добавено",
      niche: idea.niche || "",
      score: idea.score ?? null,
      date: new Date().toLocaleDateString("bg-BG"),
      status: "new", // new | used | rejected
      resultingTitle: null
    });
    this.saveAll(list);
    this._renderIfVisible();
  },

  addManual() {
    const input = document.getElementById("ideaVaultInput");
    const text = (input?.value || "").trim();
    if (!text) return toast("Въведи текст на идеята първо");
    this.add({ text, source: "Ръчно добавено" });
    if (input) input.value = "";
    toast("Идеята е добавена във Vault 💡");
  },

  markUsed(id) {
    const list = this.load();
    const it = list.find(i => i.id === id);
    if (!it) return;
    it.status = "used";
    it.resultingTitle = (typeof AppState !== "undefined" && AppState.data?.project?.title) || null;
    this.saveAll(list);
    this.render();
    toast("Маркирано като използвано ✅");
  },

  markRejected(id) {
    const list = this.load();
    const it = list.find(i => i.id === id);
    if (!it) return;
    it.status = "rejected";
    this.saveAll(list);
    this.render();
  },

  remove(id) {
    // Останалите "изтрий" действия в приложението (Song Lab, Metadata
    // Optimizer, App Log) минават през confirm() — IdeaVault беше
    // изключение и трие безвъзвратно на един клик. Подравнено с
    // конвенцията на останалия код.
    const it = this.load().find(i => i.id === id);
    const label = it?.text ? `"${it.text}"` : "тази идея";
    if (!confirm(`Изтрий ${label} от Idea Vault безвъзвратно? Това не може да се върне.`)) return;
    this.saveAll(this.load().filter(i => i.id !== id));
    this.render();
  },

  // Свързва използвана идея с реалното ѝ представяне, ако песента вече
  // е свързана с публикувано видео в Track Record (r.actual).
  _performanceFor(title) {
    if (!title || typeof TrackRecord === "undefined") return null;
    try {
      const rec = TrackRecord.load().find(r => r.title === title && r.actual);
      return rec ? rec.actual : null;
    } catch (e) { return null; }
  },

  _renderIfVisible() {
    if (document.getElementById("ideaVaultList")) this.render();
  },

  render() {
    const el = document.getElementById("ideaVaultList");
    if (!el) return;
    const list = this.load();

    const total = list.length;
    const usedCount = list.filter(i => i.status === "used").length;
    const summaryEl = document.getElementById("ideaVaultSummary");
    if (summaryEl) {
      summaryEl.textContent = total
        ? `${total} идеи общо · ${usedCount} използвани`
        : "";
    }

    if (!total) {
      el.innerHTML = `<p class="muted">Все още няма идеи. Топ нишите от Пазарен анализ и победителят от Hook Evolution Arena се добавят автоматично тук, или добави ръчно по-горе.</p>`;
      return;
    }

    const filter = document.getElementById("ideaVaultFilter")?.value || "all";
    const filtered = filter === "all" ? list : list.filter(i => i.status === filter);
    if (!filtered.length) { el.innerHTML = `<p class="muted">Нищо в този филтър.</p>`; return; }

    el.innerHTML = filtered.map(it => {
      const perf = it.status === "used" ? this._performanceFor(it.resultingTitle) : null;
      const perfHtml = perf
        ? `<br><span class="chip ${perf.perf === "Отлично" ? "green" : perf.perf === "Добре" ? "cyan" : "amber"}">${perf.perf}</span> <span class="muted">${perf.perDay != null ? Math.round(perf.perDay) + " views/ден" : ""}</span>`
        : (it.status === "used" ? `<br><span class="muted">Чака резултати — свържи публикуваното видео в Проследяване (Track Record).</span>` : "");

      return `<div class="copy-field" style="align-items:flex-start;">
        <span>
          <strong>${this._esc(it.text)}</strong><br>
          <span class="muted">${this._esc(it.source)}${it.niche ? " · " + this._esc(it.niche) : ""}${it.score != null ? " · " + it.score + "/100" : ""} · ${it.date}</span>
          ${it.status === "used" ? `<br><span class="chip green">✅ Използвано${it.resultingTitle ? ": " + this._esc(it.resultingTitle) : ""}</span>` : ""}
          ${it.status === "rejected" ? `<br><span class="chip">✖ Отхвърлено</span>` : ""}
          ${perfHtml}
        </span>
        <span style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;">
          ${it.status === "new" ? `<button class="btn ghost sm" onclick="IdeaVault.markUsed('${it.id}')">✅ Използвай</button>
             <button class="btn ghost sm" onclick="IdeaVault.markRejected('${it.id}')">✖ Отхвърли</button>` : ""}
          <button class="btn ghost sm" onclick="IdeaVault.remove('${it.id}')">🗑️</button>
        </span>
      </div>`;
    }).join("");
  },

  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
};
