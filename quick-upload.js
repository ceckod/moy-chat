/* =========================================================
   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, четвърта итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   callAI(), callGeminiMultimodal(), toast().
   ========================================================= */
/* =========================================================
   QUICK UPLOAD — "⚡ Бърз ъплоуд за стари песни"
   Прескача концепция/обложка (Стъпки 1 и 3 от основния процес):
   аудио → визуализаторът прави видео → Gemini анализира звука
   (жанр/настроение/енергия) и текста (пейстнат или разпознат от
   аудиото) → Claude генерира заглавие/описание/тагове → авто
   попълване → авто качване в YouTube (unlisted).
   ========================================================= */
const QuickUpload = {
  audioFile: null,
  videoBlob: null,
  videoFileName: "video.webm",
  analysis: null,
  meta: null,
  _msgBound: false,

  // Извиква се веднъж при стартиране на приложението — слуша за отговори
  // от скрития визуализатор-iframe (готово видео / грешка).
  initListener() {
    if (this._msgBound) return;
    this._msgBound = true;
    window.addEventListener("message", (ev) => {
      if (!ev.data) return;
      if (ev.data.type === "cdb-video-ready") {
        this.videoBlob = ev.data.blob;
        this.videoFileName = ev.data.fileName || "video.webm";
        this._setVideoProgress(100);
        this.log("✅ Видеото е готово (" + Math.round(this.videoBlob.size / 1024 / 1024 * 10) / 10 + " MB).");
        this._checkBothReady();
      }
      if (ev.data.type === "cdb-video-progress") {
        this._setVideoProgress(ev.data.percent);
      }
      if (ev.data.type === "cdb-video-error") {
        this.log("❌ Грешка от визуализатора: " + ev.data.message);
        this._setRunning(false);
      }
    });
  },

  _setVideoProgress(pct) {
    const bar = document.getElementById("qVideoProgressBar");
    const wrap = document.getElementById("qVideoProgressWrap");
    const label = document.getElementById("qVideoProgressLabel");
    if (!bar) return;
    if (wrap) wrap.style.display = "block";
    bar.style.width = pct + "%";
    if (label) label.textContent = pct >= 100 ? "Видео: готово ✅" : `Видео: записва се… ${pct}%`;
  },

  onAudioSelected(input) {
    const f = input.files[0];
    const infoEl = document.getElementById("qAudioInfo");
    if (!f) { if (infoEl) infoEl.textContent = ""; this.audioFile = null; return; }
    this.audioFile = f;
    if (infoEl) infoEl.textContent = `Избрано: ${f.name} (${Math.round(f.size / 1024 / 1024 * 10) / 10} MB)`;
    const nameEl = document.getElementById("qSongName");
    if (nameEl && !nameEl.value.trim()) {
      // Само предлагаме — потребителят може да го поправи преди да старира,
      // ако името на файла не е точното име на песента.
      nameEl.value = f.name.replace(/\.[^/.]+$/, "").replace(/[_\-]+/g, " ").trim();
    }
    document.getElementById("qStartBtn").disabled = false;
  },

  log(msg) {
    const el = document.getElementById("qLog");
    if (!el) return;
    const time = new Date().toLocaleTimeString("bg-BG");
    el.innerHTML += `<div>[${time}] ${msg}</div>`;
    el.scrollTop = el.scrollHeight;
  },

  _setRunning(v) {
    const btn = document.getElementById("qStartBtn");
    if (btn) btn.disabled = v;
    const spinner = document.getElementById("qRunning");
    if (spinner) spinner.style.display = v ? "block" : "none";
  },

  // Основен вход — стартира целия pipeline.
  async runFull() {
    if (!this.audioFile) return toast("Първо избери аудио файл");
    this.videoBlob = null;
    this.analysis = null;
    this.meta = null;
    document.getElementById("qLog").innerHTML = "";
    document.getElementById("qResultCard").style.display = "none";
    const progWrap = document.getElementById("qVideoProgressWrap");
    if (progWrap) progWrap.style.display = "none";
    const progBar = document.getElementById("qVideoProgressBar");
    if (progBar) progBar.style.width = "0%";
    this._setRunning(true);
    this.log("🚀 Стартирам — прескачам концепция/обложка, директно видео от аудио.");

    // Точното име на песента, което заглавието е ЗАДЪЛЖИТЕЛНО да започва с него —
    // взето от редактируемото поле (предпопълнено от файла, но потребителят може
    // да го е поправил, ако името на файла не е точно).
    const songNameEl = document.getElementById("qSongName");
    const guessTitle = (songNameEl && songNameEl.value.trim()) || this.audioFile.name.replace(/\.[^/.]+$/, "");
    this._sendAudioToVisualizer(guessTitle);
    this.log("🎬 Пращам аудиото на визуализатора — прави видео във фонов режим...");

    // Паралелно — анализ на звук/текст с Gemini, после заглавие/описание/тагове с Claude.
    // Не чакаме видеото за това, за да вървят двата процеса едновременно.
    this._runAnalysisAndMeta(guessTitle).catch(e => {
      this.log("❌ Грешка при анализ: " + e.message);
      this._setRunning(false);
    });
  },

  _sendAudioToVisualizer(guessTitle) {
    const frame = document.getElementById("quickVisualizerFrame");
    const send = () => frame.contentWindow.postMessage(
      { type: "cdb-quick-audio", file: this.audioFile, title: guessTitle }, "*"
    );
    // Ако iframe вече е зареден (напр. втори пуск в същата сесия) — пращаме веднага,
    // иначе презареждаме iframe-а (за чист старт) и чакаме неговия load.
    frame.onload = send;
    frame.src = "visualizer.html";
  },

  async _runAnalysisAndMeta(guessTitle) {
    this.log("🎧 Gemini анализира жанр/настроение/енергия" + (this._pastedLyrics() ? " и текста (пейстнат)..." : " и се опитва да разпознае текста от аудиото..."));
    const base64 = await fileToBase64(this.audioFile);
    const mimeType = this.audioFile.type || "audio/mpeg";
    const pasted = this._pastedLyrics();

    const prompt = `Ти си музикален анализатор. Слушай приложения аудио файл (стара песен) и анализирай:
1. genre — жанр/поджанр (кратко, 2-4 думи)
2. mood — настроение/атмосфера (2-4 думи)
3. energy — ниво на енергия: "ниско", "средно" или "високо"
4. sound_description — 1-2 изречения свободно описание на звука/инструментите/вокала
5. language — ЕЗИКЪТ, на който се пее/говори в песента (напр. "български", "английски", "китайски мандарин", "руски" и т.н.) — определи го САМО от това, което чуваш/разбираш в аудиото, без значение на какъв език е зададен този промпт
6. language_code — ISO 639-1 код на същия език (напр. "bg", "en", "zh", "ru")
7. lyrics — текстът на песента, на РЕАЛНИЯ й език (НЕ превеждай)${pasted ? " (по-долу е дадена ГОТОВА версия на текста от потребителя — ползвай я КАКТО Е, само провери/довърши срещу това, което чуваш в аудиото, ако има пропуснати редове)" : " (РАЗПОЗНАЙ го directly от аудиото, доколкото е разбираемо; ако не можеш да разпознаеш част, отбележи [неразбираемо])"}
8. lyrics_source — "provided" ако е ползван пейстнатият текст, "extracted" ако е разпознат от аудиото

${pasted ? `Текст, пейстнат от потребителя:\n---\n${pasted}\n---` : ""}

Върни ЧИСТ JSON: {"genre":"...", "mood":"...", "energy":"...", "sound_description":"...", "language":"...", "language_code":"...", "lyrics":"...", "lyrics_source":"..."}`;

    const raw = await callGeminiMultimodal(prompt, base64, mimeType);
    const analysis = extractJson(raw);
    this.analysis = analysis;
    this.log(`✅ Анализ готов — жанр: "${analysis.genre}", настроение: "${analysis.mood}", енергия: "${analysis.energy}", език: "${analysis.language}" (текст: ${analysis.lyrics_source === "provided" ? "пейстнат от теб" : "разпознат от Gemini"}).`);

    this.log("✍️ Claude генерира заглавие, описание и тагове...");
    const metaPrompt = `За стара песен, чието ТОЧНО заглавие/име е: "${guessTitle}"

Допълнителен анализ на звука и текста:
Жанр: ${analysis.genre}
Настроение: ${analysis.mood}
Енергия: ${analysis.energy}
Описание на звука: ${analysis.sound_description}
Език на песента: ${analysis.language} (код: ${analysis.language_code})
Текст (откъс, за контекст на темата — НЕ го копирай изцяло в описанието): ${(analysis.lyrics || "").slice(0, 600)}

ЗАДЪЛЖИТЕЛНО ПРАВИЛО ЗА ЗАГЛАВИЕТО: title ТРЯБВА да започва ТОЧНО с "${guessTitle}" (без промяна, без превод на името), последвано от " - " и кратко, атрактивно описателно подзаглавие базирано на жанр/настроение. Формат: "${guessTitle} - [описателно подзаглавие]". НЕ подменяй и НЕ перифразирай самото име на песента.

ЗАДЪЛЖИТЕЛНО ПРАВИЛО ЗА ЕЗИК: title (описателната част след тирето) и description ТРЯБВА да бъдат написани на езика на самата песен — ${analysis.language} (${analysis.language_code}). Не превеждай и не пиши на друг език (включително не на български), дори ако песента е на съвсем различен от български език. Единствено placeholder редовете за линкове могат да останат с универсални имена на платформи (Spotify/Apple Music/DistroKid).

Генерирай:
- title: "${guessTitle} - [описателно подзаглавие]" (до 60 символа общо), на езика на песента
- description: YouTube описание, на езика на песента — ЗАДЪЛЖИТЕЛНО в този ред: (1) най-горе 2-3 placeholder реда за линкове ("🎧 Spotify: [линк]", "🍏 Apple Music: [линк]", "📀 DistroKid: [линк]"), (2) после кратък абзац (2-3 изречения) описващ песента базирано на жанр/настроение, (3) най-долу 5-8 релевантни хаштага с #
- tags: масив от 8-12 YouTube тагове (думи/кратки фрази, БЕЗ #), предимно на езика на песента; по избор 1-2 общоприети английски тагове за по-широк обхват (напр. името на жанра), ако е уместно

Върни ЧИСТ JSON: {"title":"...", "description":"...", "tags":["...", "..."]}`;
    const metaRaw = await callAI(metaPrompt, 900);
    const meta = extractJson(metaRaw);
    // Гаранция на кода (не само на промпта) — ако генерираното заглавие не
    // започва точно с реалното име на песента, го поправяме тук вместо да
    // разчитаме единствено на това LLM-ът да го спази.
    const normalizedGuess = guessTitle.trim();
    if (!meta.title || !meta.title.trim().toLowerCase().startsWith(normalizedGuess.toLowerCase())) {
      const subtitle = (meta.title || "").replace(/^[^-–—]*[-–—]\s*/, "").trim();
      meta.title = subtitle ? `${normalizedGuess} - ${subtitle}` : normalizedGuess;
    }
    this.meta = meta;
    this.log("✅ Заглавие/описание/тагове готови.");

    this._fillResultFields();
    this._checkBothReady();
  },

  _pastedLyrics() {
    const el = document.getElementById("qLyricsPaste");
    return el ? el.value.trim() : "";
  },

  _fillResultFields() {
    const card = document.getElementById("qResultCard");
    card.style.display = "block";
    document.getElementById("qTitle").value = this.meta.title || "";
    document.getElementById("qDescription").value = this.meta.description || "";
    document.getElementById("qTags").value = (this.meta.tags || []).join(", ");
    document.getElementById("qAnalysisOut").innerHTML = `
      <div class="copy-field"><span><strong>Жанр:</strong> ${this.analysis.genre} · <strong>Настроение:</strong> ${this.analysis.mood} · <strong>Енергия:</strong> ${this.analysis.energy} · <strong>Език:</strong> ${this.analysis.language || "?"}</span></div>`;
    document.getElementById("qLyricsOut").value = this.analysis.lyrics || "";
  },

  _checkBothReady() {
    if (!this.videoBlob || !this.meta) return;
    this.log("🎉 Видео + метаданни готови. Опитвам автоматично качване в YouTube (unlisted)...");
    this._setRunning(false);
    this.autoUpload();
  },

  async autoUpload() {
    if (!this.videoBlob) return toast("Няма готово видео още");
    if (!this.meta) return toast("Няма готови метаданни още");
    if (!Step4.accessToken) {
      this.log("⚠️ Не си вписан с Google — влез с бутона по-долу, после натисни \"Качи в YouTube\" ръчно.");
      return;
    }
    const file = new File([this.videoBlob], this.videoFileName, { type: "video/webm" });
    const tags = document.getElementById("qTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const meta = {
      title: document.getElementById("qTitle").value || this.meta.title,
      description: document.getElementById("qDescription").value || this.meta.description,
      tags,
      madeForKids: false
    };
    try {
      await Step4.uploadVideo(file, meta, "qUploadProgress");
      this.log("✅ Качено в YouTube като unlisted!");
    } catch (e) {
      this.log("❌ Грешка при качване: " + e.message);
    }
  },

  // Ръчен бутон — за случаите, в които auto-upload-а не е минал (напр. Google вход
  // е направен ПОСЛЕ като видеото/метаданните вече са готови).
  async manualUpload() {
    await this.autoUpload();
  }
};
