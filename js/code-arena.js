/* =========================================================
   CODE ARENA — множество AI агенти (виж agent-registry.js) пишат
   независимо код по една и съща задача, после един на друг четат и
   критикуват кода, накрая един агент ("съдия") синтезира финална,
   подобрена версия. Резултатът се сваля като .zip (JSZip, вижте
   index.html) с финалния файл + чернови + ревюта.

   Зависи от: AgentRegistry (agent-registry.js), Keys (storage.js),
   JSZip (CDN, виж index.html), toast (ui/toast.js). Не пипа други
   модули — самостоятелна секция, регистрирана в Nav (виж nav.js).
   ========================================================= */

const CodeArena = {
  TEXT_AGENT_IDS: ["claude", "gemini", "openrouter", "groq", "mistral", "cloudflare"],

  state: {
    running: false,
    task: "",
    log: [],
    finalCode: "",
    finalFilename: "solution.py",
    selectedAgents: []
  },

  render() {
    const wrap = document.getElementById("codeArenaAgentPicker");
    if (!wrap) return;
    const available = AgentRegistry.available().filter(a => this.TEXT_AGENT_IDS.includes(a.id));

    if (!available.length) {
      wrap.innerHTML = `<p class="muted" style="margin:0;">Няма наличен агент — добави поне 2 безплатни ключа в <b>⚙️ API Ключове</b> (Groq, Mistral и OpenRouter са напълно безплатни).</p>`;
      const runBtn = document.getElementById("codeArenaRunBtn");
      if (runBtn) runBtn.disabled = true;
      return;
    }

    // По подразбиране — избери всички налични при първо зареждане.
    if (!this.state.selectedAgents.length) {
      this.state.selectedAgents = available.map(a => a.id);
    } else {
      this.state.selectedAgents = this.state.selectedAgents.filter(id => available.some(a => a.id === id));
    }

    wrap.innerHTML = available.map(a => `
      <label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:10px;cursor:pointer;font-size:13px;">
        <input type="checkbox" value="${a.id}" ${this.state.selectedAgents.includes(a.id) ? "checked" : ""}
          onchange="CodeArena.toggleAgent('${a.id}', this.checked)">
        <span>${a.icon} ${a.name}</span>
      </label>
    `).join("");

    const runBtn = document.getElementById("codeArenaRunBtn");
    if (runBtn) runBtn.disabled = false;
  },

  toggleAgent(id, checked) {
    const s = this.state.selectedAgents;
    if (checked && !s.includes(id)) s.push(id);
    if (!checked) this.state.selectedAgents = s.filter(x => x !== id);
  },

  async run() {
    if (this.state.running) return;
    const taskInput = document.getElementById("codeArenaTask");
    const task = (taskInput?.value || "").trim();
    if (!task) { toast("⚠️ Опиши каква задача трябва да реши кодът."); return; }

    const agents = this.state.selectedAgents.map(id => AgentRegistry.get(id)).filter(Boolean);
    if (agents.length < 2) { toast("⚠️ Избери поне 2 агента, за да могат да проверяват кода един на друг."); return; }

    this.state.running = true;
    this.state.task = task;
    this.state.log = [];
    this.state.finalCode = "";
    this._setBusy(true);
    this._renderLog();

    try {
      this._pushLog(null, 1, "info", `🚀 Кръг 1 — ${agents.length} агента пишат код независимо един от друг...`);
      const drafts = await Promise.all(agents.map(a => this._writeCode(a, task)));
      drafts.forEach((d, i) => this._pushLog(agents[i], 1, "code", d.code || d.raw));

      const okDrafts = drafts.filter(d => d.code);
      if (!okDrafts.length) {
        this._pushLog(null, 0, "error", "❌ Нито един агент не върна код — провери дали ключовете в ⚙️ API Ключове са валидни.");
        return;
      }

      this._pushLog(null, 2, "info", "🔍 Кръг 2 — всеки агент чете и критикува кода на другите...");
      const reviews = await Promise.all(agents.map((a, i) => this._reviewCode(a, task, drafts, i)));
      reviews.forEach((r, i) => this._pushLog(agents[i], 2, "review", r.text));

      const judge = agents[agents.length - 1];
      this._pushLog(null, 3, "info", `⚖️ Кръг 3 — ${judge.icon} ${judge.name} синтезира финалната версия от всичко по-горе...`);
      const final = await this._synthesizeFinal(judge, task, drafts, reviews);
      this.state.finalCode = final.code || "";
      this.state.finalFilename = final.filename || "solution.py";
      this._pushLog(judge, 3, "final", this.state.finalCode || "(съдията не върна ясен код — виж ревютата от Кръг 2 ръчно)");

      toast(this.state.finalCode ? "✅ Готово! Свали .zip архива по-долу." : "⚠️ Съдията не се справи — виж ревютата ръчно.");
    } catch (e) {
      this._pushLog(null, 0, "error", "❌ Грешка: " + (e?.message || e));
    } finally {
      this.state.running = false;
      this._setBusy(false);
      this._renderLog();
    }
  },

  async _writeCode(agent, task) {
    const prompt = `Ти си опитен софтуерен инженер. Напиши пълен, работещ Python код за следната задача:

"${task}"

Правила:
- Върни САМО кода, в един markdown код блок (\`\`\`python ... \`\`\`), без обяснения преди/след блока.
- Кодът да е самостоятелен, с коментари на български, с обработка на грешки.
- Ако е нужен API ключ, чети го от environment variable — не го хардкодвай.
- Не измисляй несъществуващи библиотеки/API-та.`;
    try {
      const res = await agent.send(prompt, []);
      return { code: this._extractCode(res.text || ""), raw: res.text || "" };
    } catch (e) {
      return { code: "", raw: "⚠️ " + (e?.message || e) };
    }
  },

  async _reviewCode(agent, task, drafts, selfIndex) {
    const others = drafts.map((d, i) => `--- Версия ${i + 1} ---\n${d.code || "(няма код / грешка при генериране)"}`).join("\n\n");
    const prompt = `Задачата беше: "${task}"

По-долу са ${drafts.length} различни решения от различни AI агенти:

${others}

Направи кратка, конкретна критика на всяка версия — бъгове, пропуснати edge cases, проблеми със сигурността, неефективност. После кажи коя версия е най-близо до правилната и какви точни поправки трябва да се направят. Пиши стегнато, на български, без излишни любезности.`;
    try {
      const res = await agent.send(prompt, []);
      return { text: res.text || "" };
    } catch (e) {
      return { text: "⚠️ " + (e?.message || e) };
    }
  },

  async _synthesizeFinal(judge, task, drafts, reviews) {
    const draftsBlock = drafts.map((d, i) => `--- Версия ${i + 1} ---\n${d.code || "(няма код)"}`).join("\n\n");
    const reviewsBlock = reviews.map((r, i) => `--- Ревю ${i + 1} ---\n${r.text}`).join("\n\n");
    const prompt = `Задачата беше: "${task}"

Всички версии код от различните агенти:
${draftsBlock}

Всички критики/ревюта върху тези версии:
${reviewsBlock}

Синтезирай ЕДНА финална, максимално правилна и стабилна версия — обедини най-доброто от всички версии и поправи проблемите, споменати в ревютата. Върни само финалния код в един \`\`\`python код блок, без обяснения преди/след, с кратък коментар в началото какво прави файлът.`;
    try {
      const res = await judge.send(prompt, []);
      return { code: this._extractCode(res.text || ""), filename: this._suggestFilename(task) };
    } catch (e) {
      return { code: "", filename: "solution.py" };
    }
  },

  _extractCode(text) {
    const m = text.match(/```(?:python)?\s*([\s\S]*?)```/i);
    return (m ? m[1] : text).trim();
  },

  _suggestFilename(task) {
    const slug = task.toLowerCase()
      .replace(/[^a-z0-9а-я\s-]/gi, "")
      .trim().split(/\s+/).slice(0, 4).join("_");
    return (slug || "solution") + ".py";
  },

  _pushLog(agent, round, type, text) {
    this.state.log.push({ agent: agent ? { id: agent.id, name: agent.name, icon: agent.icon } : null, round, type, text });
    this._renderLog();
  },

  _renderLog() {
    const el = document.getElementById("codeArenaLog");
    if (!el) return;
    el.innerHTML = this.state.log.map(e => {
      const who = e.agent ? `${e.agent.icon} ${e.agent.name}` : "";
      if (e.type === "info") return `<div class="ca-info">${this._esc(e.text)}</div>`;
      if (e.type === "error") return `<div class="ca-error">${this._esc(e.text)}</div>`;
      if (e.type === "code") return `<div class="ca-card"><div class="ca-card-head">💻 ${who} — чернова (кръг ${e.round})</div><pre class="ca-code">${this._esc(e.text)}</pre></div>`;
      if (e.type === "review") return `<div class="ca-card"><div class="ca-card-head">🔍 ${who} — рецензия (кръг ${e.round})</div><div class="ca-review">${this._esc(e.text)}</div></div>`;
      if (e.type === "final") return `<div class="ca-card ca-final"><div class="ca-card-head">🏆 Финален код — синтезиран от ${who}</div><pre class="ca-code">${this._esc(e.text)}</pre></div>`;
      return "";
    }).join("");
    el.scrollTop = el.scrollHeight;
    const dl = document.getElementById("codeArenaDownloadBtn");
    if (dl) dl.style.display = this.state.finalCode ? "inline-block" : "none";
  },

  _esc(s) { return (s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); },

  _setBusy(busy) {
    const btn = document.getElementById("codeArenaRunBtn");
    if (btn) { btn.disabled = busy; btn.textContent = busy ? "⏳ Агентите работят..." : "🚀 Пусни агентите"; }
  },

  async downloadZip() {
    if (!this.state.finalCode) { toast("⚠️ Няма готов финален код още."); return; }

    if (typeof JSZip === "undefined") {
      const blob = new Blob([this.state.finalCode], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = this.state.finalFilename;
      a.click();
      toast("✅ Свален " + this.state.finalFilename + " (JSZip не зареди — само единичен файл)");
      return;
    }

    const zip = new JSZip();
    zip.file(this.state.finalFilename, this.state.finalCode);

    const drafts = this.state.log.filter(l => l.type === "code" && l.round === 1);
    if (drafts.length) {
      const df = zip.folder("drafts");
      drafts.forEach(d => df.file(`${d.agent?.id || "agent"}.py`, d.text || ""));
    }
    const reviews = this.state.log.filter(l => l.type === "review");
    if (reviews.length) {
      zip.file("reviews.md", `# Ревюта от агентите\n\n` + reviews.map(r => `### ${r.agent?.name || "?"}\n\n${r.text}`).join("\n\n---\n\n"));
    }
    zip.file("README.md", `# ${this.state.task}\n\nГенерирано от Code Arena — ${this.state.selectedAgents.length} AI агента написаха и рецензираха код взаимно.\n\nФинален файл: \`${this.state.finalFilename}\`\n`);

    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "code-arena-result.zip";
    a.click();
    toast("✅ Архивът е свален!");
  }
};
