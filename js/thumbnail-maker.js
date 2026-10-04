/* =========================================================
   THUMBNAIL MAKER — отделен Dashboard модул (раздел "Статистика")
   Подобен на Thumbnails4U, но автоматичен и със СЪЩЕСТВУВАЩИТЕ ключове.

   Как работи (всичко в браузъра):
     1. Текстов AI агент (callAI) получава заглавието и връща 3 КОНЦЕПЦИИ:
        кратък надпис (до 4 думи), описание на фона (EN), цвят, позиция.
        Агентът се избира от списък. По подразбиране "най-добър безплатен
        първо": Gemini → OpenRouter → Model Finder; платеният Claude е
        резерва, освен ако не го избереш изрично.
     2. Фонът се генерира от избран генератор, по подразбиране най-силният
        първо: Gemini image (gemini-3.1-flash-image-preview →
        gemini-2.5-flash-image) → Cloudflare FLUX (8 стъпки) → Pollinations.
        При отказ автоматично се пада на следващия.
        ВАЖНО: текстовите агенти не рисуват. Надписът се слага от нас върху
        canvas, защото генераторите пишат кирилица с грешки.
     3. Canvas 1280×720: фон + затъмняване за четимост + надпис с контур.
        Ръчна настройка на текст/цвят/позиция/размер.
     4. Сваляне като PNG (или JPEG, ако PNG надхвърли 2 MB — лимита на YouTube).

   Нови ключове: НЕ. Ползва Keys.load(): gemini, cfApiToken, cfAccountId (+ AI веригата на callAI).
   Зависимости (runtime): Keys, callAI, fetchTimeout, proxied, cloudflareImageAsync,
   pollinationsImageUrlAsync, toast.
   Чистата логика е в ThumbCore (тествана в test/thumbnail-maker.test.mjs).
   ========================================================= */

const THUMB_W = 1280;
const THUMB_H = 720;
const THUMB_MAX_BYTES = 2 * 1024 * 1024; // YouTube лимит за thumbnail
const THUMB_FONT = '900 {SIZE}px "Arial Black", "Roboto Condensed", Roboto, Impact, sans-serif';
const THUMB_POSITIONS = ["left", "center", "bottom"];

const ThumbCore = {
  // Подава се само текст → връща до 3 нормализирани концепции или [].
  parseConcepts(raw) {
    let data = null;
    const cleaned = String(raw || "").replace(/```(?:json)?/g, "").trim();
    try { data = JSON.parse(cleaned); } catch (e) {
      const m = /\[[\s\S]*\]|\{[\s\S]*\}/.exec(cleaned);
      if (m) { try { data = JSON.parse(m[0]); } catch (e2) { data = null; } }
    }
    if (data && !Array.isArray(data)) data = data.concepts || data.items || null;
    if (!Array.isArray(data)) return [];
    return data.slice(0, 3).map(c => ({
      headline: this.cleanHeadline(c.headline || c.text || ""),
      imagePrompt: String(c.imagePrompt || c.image_prompt || c.prompt || "").slice(0, 600).trim(),
      accent: /^#[0-9a-f]{6}$/i.test(c.accent || "") ? c.accent : "#ffd400",
      position: THUMB_POSITIONS.includes(c.position) ? c.position : "left",
    })).filter(c => c.headline && c.imagePrompt);
  },

  // Главни букви, макс. 4 думи, макс. 28 символа — по-дълго не се чете на малък екран.
  cleanHeadline(text) {
    const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4);
    return words.join(" ").toUpperCase().slice(0, 28).trim();
  },

  // Пренасяне по ширина. measure(str) → пиксели (инжектира се, за да се тества без canvas).
  wrapLines(text, measure, maxWidth) {
    const words = text.split(" ").filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? cur + " " + w : w;
      if (cur && measure(next) > maxWidth) { lines.push(cur); cur = w; } else { cur = next; }
    }
    if (cur) lines.push(cur);
    return lines;
  },

  // Най-големият размер ≤ startSize, при който текстът е до 3 реда и нито един не е по-широк от maxWidth.
  fitFont(text, measureAt, maxWidth, startSize, minSize = 48) {
    for (let size = startSize; size >= minSize; size -= 4) {
      const lines = this.wrapLines(text, s => measureAt(s, size), maxWidth);
      if (lines.length <= 3 && lines.every(l => measureAt(l, size) <= maxWidth)) return { size, lines };
    }
    return { size: minSize, lines: this.wrapLines(text, s => measureAt(s, minSize), maxWidth) };
  },

  IMAGE_PROVIDERS: ["gemini", "cloudflare", "pollinations"], // от най-силния към най-слабия

  // Кои генератори на фон са използваеми с наличните ключове, в ред на пробване.
  // choice: "auto" (най-силният първо) или конкретно име (пробва се първо, останалите — резерва).
  imageProviderOrder(choice, keys) {
    const has = { gemini: !!keys.gemini, cloudflare: !!(keys.cfApiToken && keys.cfAccountId), pollinations: true };
    const order = [];
    for (const p of [choice, ...this.IMAGE_PROVIDERS]) {
      if (p && p !== "auto" && has[p] && !order.includes(p)) order.push(p);
    }
    return order;
  },

  // Кой текстов агент да е първи за callAI(forceFirst). null = редът от Настройки.
  // "free" = най-добрият безплатен с ключ; платеният Claude остава само като резерва в callAI веригата.
  textFirst(choice, keys) {
    const has = {
      claude: !!keys.claude, gemini: !!keys.gemini, openrouter: !!keys.openrouterKey,
      modelfinder: !!(keys.groqKey || keys.mistralKey || (keys.cfApiToken && keys.cfAccountId)),
    };
    if (choice === "auto") return null;
    if (choice === "free") return ["gemini", "openrouter", "modelfinder"].find(p => has[p]) || null;
    return has[choice] ? choice : null;
  },

  // PNG, а ако е над лимита — JPEG. blobs: {png, jpeg} (Blob-подобни със size).
  chooseExport(blobs, maxBytes = THUMB_MAX_BYTES) {
    if (blobs.png && blobs.png.size <= maxBytes) return { kind: "png", blob: blobs.png };
    if (blobs.jpeg && blobs.jpeg.size <= maxBytes) return { kind: "jpeg", blob: blobs.jpeg };
    return { kind: blobs.jpeg ? "jpeg" : "png", blob: blobs.jpeg || blobs.png, tooBig: true };
  },
};

const THUMB_SYSTEM = `You design high-CTR YouTube thumbnails for music videos.
Return ONLY valid JSON: an array of exactly 3 objects with keys:
"headline" (max 4 words, same language as the video title, ALL CAPS-friendly, punchy, not a copy of the title),
"imagePrompt" (English, 1-2 sentences, describes ONLY the background image: bold composition, high contrast,
vivid colors, a clear empty area for text. NO text, letters, logos, brand names, real people or celebrities),
"accent" (hex color like #ffd400 that pops on the image),
"position" ("left", "center" or "bottom" — where the text goes).
The 3 concepts must differ clearly in mood and composition.`;

const Thumb = {
  _bg: null,        // HTMLImageElement на текущия фон
  _variants: [],    // [{concept, bgUrl, preview}]
  _busy: false,

  _esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },
  _el(id) { return document.getElementById(id); },
  _out(id, html) { const el = this._el(id); if (el) el.innerHTML = html; },

  render() {
    const c = this._el("thumbCanvas");
    if (c && !c.dataset.ready) { c.width = THUMB_W; c.height = THUMB_H; c.dataset.ready = "1"; this.draw(); }
    this._refreshKeyHint();
  },

  _refreshKeyHint() {
    const k = Keys.load();
    const order = ThumbCore.imageProviderOrder(this._el("thumbImgProvider")?.value || "auto", k);
    const names = { gemini: "Gemini image", cloudflare: "Cloudflare FLUX", pollinations: "Pollinations (публична услуга без ключ)" };
    this._out("thumbKeyHint", `<span class="muted">🎨 Ред на фоновете: ${order.map(p => names[p]).join(" → ")}.${order[0] === "pollinations" ? " Няма Gemini/Cloudflare ключ — описанието на фона се изпраща към публична услуга." : ""}</span>`);
  },

  // Пробва генераторите по ред; връща {url, provider}. Хвърля само ако ВСИЧКИ откажат.
  async _generateBg(prompt) {
    const k = Keys.load();
    const order = ThumbCore.imageProviderOrder(this._el("thumbImgProvider")?.value || "auto", k);
    const errors = [];
    for (const p of order) {
      try {
        if (p === "gemini") return { url: await this._bgGemini(prompt, k.gemini), provider: "Gemini" };
        if (p === "cloudflare") return { url: await cloudflareImageAsync(prompt, { width: 1024, height: 576, steps: 8 }, k.cfApiToken, k.cfAccountId), provider: "Cloudflare FLUX" };
        const url = await pollinationsImageUrlAsync(prompt, { width: 1024, height: 576 });
        return { url, provider: "Pollinations" };
      } catch (e) {
        errors.push(`${p}: ${String(e.message).slice(0, 120)}`);
        toast(`⚠️ ${p} не се справи — пробвам следващия...`, 2500);
      }
    }
    throw new Error("Всички генератори отказаха — " + errors.join(" | "));
  },

  // Модели, проверени в документацията на Google; първият, който отговори, печели.
  async _bgGemini(prompt, key) {
    const models = ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"];
    let lastErr = "";
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetchTimeout(proxied(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${prompt}. Wide 16:9 YouTube thumbnail background, no text, no letters.` }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
        }),
      }, 90000);
      if (!res.ok) { lastErr = `${model} HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`; continue; }
      const data = await res.json();
      const part = data.candidates?.[0]?.content?.parts?.find(x => x.inlineData || x.inline_data);
      const inl = part?.inlineData || part?.inline_data;
      if (inl) return `data:${inl.mimeType || inl.mime_type || "image/png"};base64,${inl.data}`;
      lastErr = `${model}: няма изображение в отговора`;
    }
    throw new Error(lastErr || "Gemini не върна изображение");
  },

  // ---------- Рисуване ----------
  draw(canvas = this._el("thumbCanvas"), state = this._state()) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const k = canvas.width / THUMB_W; // мащаб (за миниатюрите)
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, THUMB_W, THUMB_H);

    // фон (cover)
    if (state.bg) {
      const iw = state.bg.naturalWidth || state.bg.width, ih = state.bg.naturalHeight || state.bg.height;
      const s = Math.max(THUMB_W / iw, THUMB_H / ih);
      ctx.drawImage(state.bg, (THUMB_W - iw * s) / 2, (THUMB_H - ih * s) / 2, iw * s, ih * s);
    } else {
      const g = ctx.createLinearGradient(0, 0, THUMB_W, THUMB_H);
      g.addColorStop(0, "#1b1035"); g.addColorStop(1, state.accent);
      ctx.fillStyle = g; ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    }

    // затъмняване откъм текста (четимост на малък екран)
    const a = Math.max(0, Math.min(100, state.overlay)) / 100;
    if (a > 0) {
      let g;
      if (state.position === "bottom") { g = ctx.createLinearGradient(0, THUMB_H, 0, THUMB_H * 0.25); }
      else if (state.position === "center") { g = ctx.createLinearGradient(0, 0, 0, THUMB_H); }
      else { g = ctx.createLinearGradient(0, 0, THUMB_W * 0.75, 0); }
      g.addColorStop(0, `rgba(0,0,0,${0.85 * a})`);
      g.addColorStop(state.position === "center" ? 0.5 : 1, `rgba(0,0,0,${state.position === "center" ? 0.55 * a : 0})`);
      if (state.position === "center") g.addColorStop(1, `rgba(0,0,0,${0.85 * a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    }

    // надпис
    const text = ThumbCore.cleanHeadline(state.headline);
    if (!text) { ctx.setTransform(1, 0, 0, 1, 0, 0); return; }
    const maxW = state.position === "left" ? THUMB_W * 0.58 : THUMB_W * 0.86;
    const measureAt = (s, size) => { ctx.font = THUMB_FONT.replace("{SIZE}", size); return ctx.measureText(s).width; };
    const { size, lines } = ThumbCore.fitFont(text, measureAt, maxW, state.fontSize);
    ctx.font = THUMB_FONT.replace("{SIZE}", size);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const lh = size * 1.08;
    const blockH = lh * lines.length;
    const align = state.position === "left" ? "left" : "center";
    ctx.textAlign = align;
    const x = state.position === "left" ? 60 : THUMB_W / 2;
    let y0 = state.position === "bottom" ? THUMB_H - blockH - 40 : (THUMB_H - blockH) / 2;
    lines.forEach((line, i) => {
      const y = y0 + lh * i + lh / 2;
      ctx.lineWidth = size * 0.16;
      ctx.strokeStyle = "#000";
      ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = size * 0.1; ctx.shadowOffsetY = size * 0.05;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = "transparent";
      ctx.fillStyle = i === lines.length - 1 ? state.accent : "#fff"; // последният ред е в акцентния цвят
      ctx.fillText(line, x, y);
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },

  _state() {
    return {
      bg: this._bg,
      headline: this._el("thumbHeadline")?.value || "",
      accent: this._el("thumbAccent")?.value || "#ffd400",
      position: this._el("thumbPosition")?.value || "left",
      overlay: +(this._el("thumbOverlay")?.value ?? 55),
      fontSize: +(this._el("thumbFont")?.value ?? 150),
    };
  },

  _loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Не успях да заредя изображението"));
      img.src = url;
    });
  },

  // ---------- Автоматичен поток ----------
  async autoCreate() {
    if (this._busy) return;
    const title = (this._el("thumbTitle")?.value || "").trim();
    if (!title) return toast("❌ Въведи заглавие на видеото");
    const vibe = (this._el("thumbVibe")?.value || "").trim();
    this._busy = true;
    this._variants = [];
    try {
      this._out("thumbStatus", `<p class="muted">🤖 AI измисля 3 концепции...</p>`);
      const prompt = `${THUMB_SYSTEM}\n\nЗаглавие на видеото: "${title}"${vibe ? `\nЖелано настроение/стил: ${vibe}` : ""}`;
      const first = ThumbCore.textFirst(this._el("thumbTextAgent")?.value || "free", Keys.load());
      const raw = await callAI(prompt, 900, first);
      const concepts = ThumbCore.parseConcepts(raw);
      if (!concepts.length) throw new Error("AI не върна валидни концепции — опитай пак.");

      let failed = 0;
      for (let i = 0; i < concepts.length; i++) {
        const c = concepts[i];
        this._out("thumbStatus", `<p class="muted">🎨 Фон ${i + 1}/${concepts.length}: ${this._esc(c.headline)}...</p>`);
        let bg = null, provider = "—";
        try {
          const r = await this._generateBg(c.imagePrompt);
          bg = await this._loadImage(r.url);
          provider = r.provider;
        } catch (e) {
          failed++;
          toast("❌ " + e.message.slice(0, 160), 5000);
        }
        this._variants.push({ concept: c, bg, provider, preview: this._preview(c, bg) });
        this._showVariants();
      }
      this._out("thumbStatus", failed
        ? `<p style="color:#e90;">⚠️ ${failed} от ${concepts.length} фона не се генерираха (всички генератори отказаха) — виждаш градиент. Опитай пак след ~30 сек.</p>`
        : `<p class="muted">✅ Готово — избери вариант за редакция.</p>`);
      if (this._variants.length) this.pick(0);
    } catch (e) {
      this._out("thumbStatus", `<p style="color:#e66;">❌ ${this._esc(e.message)}</p>`);
    } finally {
      this._busy = false;
    }
  },

  _preview(concept, bg) {
    const c = document.createElement("canvas");
    c.width = 480; c.height = 270;
    this.draw(c, { bg, headline: concept.headline, accent: concept.accent, position: concept.position, overlay: 55, fontSize: 150 });
    return c.toDataURL("image/jpeg", 0.8);
  },

  _showVariants() {
    this._out("thumbVariants", `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px;">${
      this._variants.map((v, i) => `<button class="btn ghost" style="padding:4px;" onclick="Thumb.pick(${i})"><img src="${v.preview}" alt="Вариант ${i + 1}" style="width:100%;border-radius:6px;display:block;"><div class="muted" style="font-size:11px;margin-top:3px;">Вариант ${i + 1} · ${this._esc(v.provider)}</div></button>`).join("")
    }</div>`);
  },

  pick(i) {
    const v = this._variants[i];
    if (!v) return;
    this._bg = v.bg;
    this._el("thumbHeadline").value = v.concept.headline;
    this._el("thumbAccent").value = v.concept.accent;
    this._el("thumbPosition").value = v.concept.position;
    this.draw();
  },

  // ---------- Ръчна нова картинка за текущия фон ----------
  async regenBackground() {
    if (this._busy) return;
    const p = (this._el("thumbBgPrompt")?.value || "").trim();
    if (!p) return toast("❌ Опиши фона (на английски дава по-добър резултат)");
    this._busy = true;
    try {
      this._out("thumbStatus", `<p class="muted">🎨 Генерирам фон...</p>`);
      const { url, provider } = await this._generateBg(p);
      this._bg = await this._loadImage(url);
      this.draw();
      this._out("thumbStatus", `<p class="muted">✅ Новият фон е сложен (${this._esc(provider)}).</p>`);
    } catch (e) {
      this._out("thumbStatus", `<p style="color:#e66;">❌ ${this._esc(e.message)}</p>`);
    } finally {
      this._busy = false;
    }
  },

  uploadBackground(input) {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => { this._bg = await this._loadImage(reader.result); this.draw(); };
    reader.readAsDataURL(f);
    input.value = "";
  },

  // ---------- Сваляне ----------
  async download() {
    const canvas = this._el("thumbCanvas");
    const toBlob = (type, q) => new Promise(res => canvas.toBlob(res, type, q));
    const [png, jpeg] = [await toBlob("image/png"), await toBlob("image/jpeg", 0.92)];
    const pick = ThumbCore.chooseExport({ png, jpeg });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(pick.blob);
    a.download = `thumbnail-${Date.now()}.${pick.kind === "png" ? "png" : "jpg"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(pick.tooBig ? "⚠️ Файлът е над 2 MB — YouTube може да го откаже" : pick.kind === "jpeg" ? "✅ Свалено като JPEG (PNG беше над 2 MB)" : "✅ Свалено (PNG, 1280×720)", 4000);
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ThumbCore };
}
