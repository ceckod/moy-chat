/* =========================================================
   AI CHAT — новата "чат с AI агентите" секция (виж view-ai-chat в
   index.html). Разговорът е нарочно ВРЕМЕНЕН — живее само в паметта
   (this.messages), НЕ се пази в localStorage — изчиства се при
   презареждане на страницата.

   Работи с произволен брой агенти, описани в js/agent-registry.js —
   този файл НЕ знае нищо provider-специфично (Claude/Gemini/...),
   само вика agent.send(prompt, attachments) и показва резултата.

   Зависи от: AgentRegistry (agent-registry.js), Keys (storage.js),
   fileToBase64 (ai-helpers.js), toast (ui/toast.js), Nav (nav.js) —
   всички викани само ВЪТРЕ във функции, реда на <script> таговете не
   е критичен.
   ========================================================= */

const AIChat = {
  agentId: null,
  selectedModel: null,     // конкретен модел, избран от падащото меню — null = "Автоматично"
  messages: [],            // {role:"user"|"agent", text, imageUrl, error, attachments, agentId}
  pendingAttachments: [],  // {name, mimeType, kind:"image"|"pdf", base64}
  sending: false,

  init() {
    if (!this.agentId) {
      const avail = AgentRegistry.available();
      this.agentId = avail.length ? avail[0].id : AgentRegistry.all()[0].id;
    }
    if (this._lastAnsweredModel === undefined) this._lastAnsweredModel = null;
    if (this._lastAnsweredAgentId === undefined) this._lastAnsweredAgentId = null;
  },

  render() {
    this.init();
    this._renderAgentSelect();
    this._renderModelSelect();
    this._renderAgentAbout();
    this._renderMessages();
    this._renderAttachments();
  },

  selectAgent(id) {
    this.agentId = id;
    this.selectedModel = null;
    this._lastAnsweredModel = null;
    this._renderModelSelect();
    this._renderAgentAbout();
  },

  selectModel(v) {
    this.selectedModel = v || null;
  },

  /* ---------- ПРИКАЧЕНИ ФАЙЛОВЕ ---------- */
  async handleFiles(fileList) {
    for (const file of Array.from(fileList || [])) {
      const isPdf = file.type === "application/pdf";
      const isImage = file.type.startsWith("image/");
      if (!isPdf && !isImage) { toast(`⚠️ "${file.name}" не е снимка или PDF — прескочен`); continue; }
      try {
        const base64 = await fileToBase64(file);
        this.pendingAttachments.push({ name: file.name, mimeType: file.type, kind: isPdf ? "pdf" : "image", base64 });
      } catch (e) { toast("⚠️ Неуспешно прикачване на " + file.name); }
    }
    this._renderAttachments();
    const input = document.getElementById("aiChatFileInput");
    if (input) input.value = ""; // за да може същият файл да се избере пак
  },

  removeAttachment(idx) {
    this.pendingAttachments.splice(idx, 1);
    this._renderAttachments();
  },

  /* ---------- ИЗПРАЩАНЕ ---------- */
  async send() {
    if (this.sending) return;
    const input = document.getElementById("aiChatInput");
    const prompt = (input?.value || "").trim();
    if (!prompt && !this.pendingAttachments.length) return;

    const agent = AgentRegistry.get(this.agentId);
    if (!agent) { toast("⚠️ Няма избран агент"); return; }
    if (!AgentRegistry.hasKey(agent)) { toast(`⚠️ "${agent.name}" няма зададен ключ (виж Настройки → API Ключове)`); return; }

    // Проверка за съвместимост на прикачените файлове с избрания агент —
    // спира и предупреждава, вместо тихо да ги изгуби (виж capabilities в
    // js/agent-registry.js).
    const hasImages = this.pendingAttachments.some(a => a.kind === "image");
    const hasPdf = this.pendingAttachments.some(a => a.kind === "pdf");
    if (hasImages && !agent.capabilities.images) { toast(`⚠️ "${agent.name}" не разбира прикачени снимки — превключи на Claude, Gemini или OpenRouter`); return; }
    if (hasPdf && !agent.capabilities.pdf) { toast(`⚠️ "${agent.name}" не разбира прикачен PDF — превключи на Claude или Gemini`); return; }
    if (!agent.capabilities.text && !agent.capabilities.imageGen) { toast(`⚠️ "${agent.name}" не поддържа този тип заявка`); return; }

    const attachmentsForSend = this.pendingAttachments.map(a => ({ base64: a.base64, mimeType: a.mimeType, kind: a.kind }));
    this.messages.push({
      role: "user",
      text: prompt,
      attachments: this.pendingAttachments.map(a => ({ name: a.name, kind: a.kind }))
    });
    this.pendingAttachments = [];
    if (input) input.value = "";
    this._renderAttachments();
    this._renderMessages(true);

    this.sending = true;
    this._setTyping(true);
    try {
      const result = await agent.send(prompt, attachmentsForSend, this.selectedModel);
      this.messages.push({ role: "agent", agentId: agent.id, text: result.text, imageUrl: result.imageUrl, model: result.model });
      this._lastAnsweredModel = result.model || null;
      this._lastAnsweredAgentId = agent.id;
    } catch (e) {
      this.messages.push({ role: "agent", agentId: agent.id, error: e.message || "Неочаквана грешка" });
    } finally {
      this.sending = false;
      this._setTyping(false);
      this._renderAgentAbout();
      this._renderMessages(true);
    }
  },

  clear() {
    this.messages = [];
    this.pendingAttachments = [];
    this._lastAnsweredModel = null;
    this._lastAnsweredAgentId = null;
    this._renderMessages();
    this._renderAttachments();
    this._renderAgentAbout();
  },

  /* ---------- РЕНДИРАНЕ ---------- */
  _setTyping(on) {
    const el = document.getElementById("aiChatTyping");
    if (el) el.style.display = on ? "flex" : "none";
    const btn = document.getElementById("aiChatSendBtn");
    if (btn) btn.disabled = on;
  },

  _renderAgentSelect() {
    const sel = document.getElementById("aiChatAgentSelect");
    if (!sel) return;
    const k = Keys.load();
    sel.innerHTML = AgentRegistry.all().map(a => {
      const has = AgentRegistry.hasKey(a, k);
      return `<option value="${a.id}" ${a.id === this.agentId ? "selected" : ""} ${has ? "" : "disabled"}>${a.icon} ${a.name}${has ? "" : " — няма ключ"}</option>`;
    }).join("");
  },

  // Падащо меню с КОНКРЕТНИТЕ модели на текущия агент (само за агенти с
  // listModels — OpenRouter/Groq/Mistral/Cloudflare) — вместо да оставяш
  // сайта сам да гадае кой от ~50-те модела да отговори, избираш точно
  // кой. Списъкът се тегли АСИНХРОННО (реален živo извикване към
  // доставчика при OpenRouter/Groq/..., виж съответните listModels по-горе
  // в agent-registry.js) — затова първо показваме "⏳ Зареждам модели...".
  async _renderModelSelect() {
    const sel = document.getElementById("aiChatModelSelect");
    if (!sel) return;
    const agent = AgentRegistry.get(this.agentId);
    if (!agent || !agent.listModels) { sel.style.display = "none"; sel.innerHTML = ""; return; }

    sel.style.display = "";
    sel.innerHTML = `<option value="">⏳ Зареждам модели...</option>`;
    const myAgentId = this.agentId; // защита срещу превключване на агент, докато чака мрежата
    let models = [];
    try { models = await agent.listModels(); } catch (e) { models = []; }
    if (this.agentId !== myAgentId) return; // потребителят вече е сменил агента — резултатът вече не важи

    if (!models.length) {
      sel.innerHTML = `<option value="">Автоматично (списъкът не се зареди)</option>`;
      return;
    }
    sel.innerHTML =
      `<option value="">🤖 Автоматично (пробва сам)</option>` +
      models.map(m => `<option value="${_escape(m)}" ${m === this.selectedModel ? "selected" : ""}>${_escape(m)}</option>`).join("");
  },

  _renderAgentAbout() {
    const el = document.getElementById("aiChatAgentAbout");
    if (!el) return;
    const a = AgentRegistry.get(this.agentId);
    if (!a) { el.innerHTML = ""; return; }
    const caps = [];
    if (a.capabilities.text) caps.push("💬 чат");
    if (a.capabilities.images) caps.push("🖼️ разбира снимки");
    if (a.capabilities.pdf) caps.push("📄 разбира PDF");
    if (a.capabilities.imageGen) caps.push("🎨 генерира снимки");
    // Реалният модел, който последно е отговорил ОТ ТОЗИ агент в текущия
    // разговор — полезно най-вече при "Автоматично" (viж AIChat.send() →
    // _lastAnsweredModel), когато не е избран изричен модел от менюто.
    const modelLine = (!this.selectedModel && this._lastAnsweredModel && this._lastAnsweredAgentId === this.agentId && this._lastAnsweredModel !== a.id)
      ? `<div style="margin-top:2px;color:var(--cyan);font-size:11.5px;">В момента говориш с: <strong>${_escape(this._lastAnsweredModel)}</strong></div>`
      : "";
    el.innerHTML = `<div>${_escape(a.about)}</div><div style="margin-top:4px;color:var(--muted-2);font-size:11.5px;">${caps.join(" · ")}</div>${modelLine}`;
  },

  _renderAttachments() {
    const el = document.getElementById("aiChatAttachmentsPreview");
    if (!el) return;
    if (!this.pendingAttachments.length) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "flex";
    el.innerHTML = this.pendingAttachments.map((a, i) =>
      `<span class="chip">${a.kind === "pdf" ? "📄" : "🖼️"} ${_escape(a.name)} <span onclick="AIChat.removeAttachment(${i})" style="cursor:pointer;color:var(--red);margin-left:4px;">✕</span></span>`
    ).join("");
  },

  _renderMessages(scroll) {
    const el = document.getElementById("aiChatMessages");
    if (!el) return;
    el.innerHTML = this.messages.length
      ? this.messages.map(m => this._bubble(m)).join("")
      : `<div class="muted" style="text-align:center;padding:36px 10px;">Избери агент отгоре и напиши съобщение — или прикачи снимка/PDF 📎</div>`;
    if (scroll) el.scrollTop = el.scrollHeight;
  },

  _bubble(m) {
    const isUser = m.role === "user";
    const agent = !isUser ? AgentRegistry.get(m.agentId) : null;
    const showModel = m.model && agent && m.model !== agent.id;
    const label = isUser ? "Ти" : (agent ? `${agent.icon} ${agent.name}${showModel ? " · " + _escape(m.model) : ""}` : "Агент");
    let body = "";
    if (m.error) body = `<div style="color:var(--red);">⚠️ ${_escape(m.error)}</div>`;
    else if (m.imageUrl) body = `<img src="${m.imageUrl}" style="max-width:100%;border-radius:10px;margin-top:2px;" alt="генерирано изображение">`;
    else if (m.text) body = `<div style="white-space:pre-wrap;">${_escape(m.text)}</div>`;

    const atts = (m.attachments || []).length
      ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${m.attachments.map(a => `<span class="chip">${a.kind === "pdf" ? "📄" : "🖼️"} ${_escape(a.name)}</span>`).join("")}</div>`
      : "";

    return `<div style="max-width:82%;margin:${isUser ? "0 0 12px auto" : "0 auto 12px 0"};">
      <div style="font-size:10.5px;color:var(--muted-2);margin-bottom:3px;${isUser ? "text-align:right;" : ""}">${label}</div>
      <div style="background:${isUser ? "var(--grad)" : "var(--panel-2)"};color:${isUser ? "#fff" : "var(--text)"};border:1px solid ${isUser ? "transparent" : "var(--border)"};border-radius:12px;padding:10px 12px;font-size:13.5px;line-height:1.5;">${body}${atts}</div>
    </div>`;
  }
};

function _escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
