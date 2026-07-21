/* =========================================================
   CD-B Records — Control Dashboard
   Един файл SPA логика. Всичко локално (localStorage).
   ========================================================= */

const STORAGE_KEY = "cdb_dashboard_state_v1";
const KEYS_STORAGE = "cdb_dashboard_keys_v1";

/* ---------- STATE ---------- */
const AppState = {
  data: null,

  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    this.data = raw ? JSON.parse(raw) : {
      currentStep: 1,
      status: { 1: "blue", 2: "grey", 3: "grey", 4: "grey" },
      project: {
        niches: [], chosenNiche: null, nicheScore: null,
        title: "", stylePrompt: "", hashtags: [],
        lyrics: "", geminiReview: "",
        fxConfig: "", coverPrompt: "", coverImageUrl: "",
        distrokid: {}, youtube: {}
      }
    };
  },
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  }
};

const Keys = {
  load() {
    const raw = localStorage.getItem(KEYS_STORAGE);
    return raw ? JSON.parse(raw) : {};
  },
  save(obj) {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(obj));
  }
};

/* ---------- TOAST ---------- */
function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.style.display = "none"), ms);
}

/* ---------- NAVIGATION / CHECKLIST ---------- */
const Nav = {
  init() {
    AppState.load();
    this.render();
  },
  goTo(step) {
    AppState.data.currentStep = step;
    // ако стъпката е сива (未посетена) и я отваряш, я маркирай синя (in progress)
    if (AppState.data.status[step] === "grey") AppState.data.status[step] = "blue";
    AppState.save();
    this.render();
    if (step === 2) Step2.syncTitleToVisualizer();
  },
  completeStep(step) {
    AppState.data.status[step] = "green";
    const next = step + 1;
    if (next <= 4 && AppState.data.status[next] === "grey") {
      AppState.data.status[next] = "blue";
    }
    AppState.data.currentStep = Math.min(next, 4);
    AppState.save();
    this.render();
    toast(`Стъпка ${step} завършена ✅`);
  },
  render() {
    for (let i = 1; i <= 4; i++) {
      document.getElementById(`panel-${i}`).classList.toggle("active", AppState.data.currentStep === i);
      document.querySelector(`.step-btn[data-step="${i}"]`).classList.toggle("active", AppState.data.currentStep === i);
      const dot = document.getElementById(`dot-${i}`);
      dot.className = "dot " + AppState.data.status[i];
    }
    const doneCount = Object.values(AppState.data.status).filter(s => s === "green").length;
    document.getElementById("progressFill").style.width = (doneCount / 4 * 100) + "%";
  }
};

/* ---------- SETTINGS MODAL ---------- */
const Settings = {
  open() {
    const k = Keys.load();
    document.getElementById("key_claude").value = k.claude || "";
    document.getElementById("key_gemini").value = k.gemini || "";
    document.getElementById("key_yt_client_id").value = k.ytClientId || "";
    document.getElementById("key_yt_apikey").value = k.ytApiKey || "";
    document.getElementById("settingsModal").classList.add("open");
  },
  close() {
    document.getElementById("settingsModal").classList.remove("open");
  },
  save() {
    Keys.save({
      claude: document.getElementById("key_claude").value.trim(),
      gemini: document.getElementById("key_gemini").value.trim(),
      ytClientId: document.getElementById("key_yt_client_id").value.trim(),
      ytApiKey: document.getElementById("key_yt_apikey").value.trim(),
    });
    toast("Ключовете са запазени локално 🔒");
    this.close();
  }
};

/* =========================================================
   API HELPERS
   ========================================================= */

async function callClaude(prompt, maxTokens = 1200) {
  const k = Keys.load();
  if (!k.claude) { toast("⚠️ Липсва Claude API ключ (виж Настройки)"); throw new Error("no key"); }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": k.claude,
      "anthropic-version": "2023-06-01",
      // Позволява директно извикване от браузъра (без бекенд прокси)
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Claude API грешка: " + t);
  }
  const data = await res.json();
  return data.content.map(b => b.text || "").join("\n").trim();
}

async function callGemini(prompt) {
  const k = Keys.load();
  if (!k.gemini) { toast("⚠️ Липсва Gemini API ключ (виж Настройки)"); throw new Error("no key"); }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${k.gemini}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Gemini API грешка: " + t);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "(няма отговор)";
}

/* =========================================================
   STEP 1 — Търсене & Концепция
   ========================================================= */
const Step1 = {
  async scanNiches() {
    const raw = document.getElementById("nicheInput").value.trim();
    if (!raw) return toast("Въведи поне една ниша/жанр");
    const niches = raw.split("\n").map(s => s.trim()).filter(Boolean);

    document.getElementById("nicheResults").innerHTML = "⏳ Анализирам...";

    // NOTE: Истински YouTube/Google Trends данни изискват YouTube Data API
    // (search.list -> pageInfo.totalResults) комбинирано с Google Trends (няма официално API).
    // Тук молим Claude да направи качествена приблизителна пазарна оценка
    // въз основа на общи знания за жанра — реалната бройка search volume
    // може да се добави по-късно през YouTube Data API key от Настройки.
    const prompt = `Ти си музикален A&R / SEO анализатор за 2026 година.
Дадени са следните музикални ниши/жанрове:
${niches.map((n, i) => `${i + 1}. ${n}`).join("\n")}

За всяка ниша дай:
- Score от 0 до 100 (комбинация от търсене и ниска конкуренция)
- Кратка причина (1 изречение)

Върни ЧИСТ JSON масив без обяснения, формат:
[{"niche":"...", "score":number, "reason":"..."}]`;

    try {
      const raw2 = await callClaude(prompt, 600);
      const jsonStr = raw2.replace(/```json|```/g, "").trim();
      const results = JSON.parse(jsonStr);
      results.sort((a, b) => b.score - a.score);

      const best = results[0];
      AppState.data.project.niches = results;
      AppState.data.project.chosenNiche = best.niche;
      AppState.data.project.nicheScore = best.score;
      AppState.save();

      let html = "";
      results.forEach(r => {
        const color = r.score > 75 ? "🟢" : r.score > 50 ? "🟡" : "⚪";
        html += `<div class="copy-field"><span>${color} <strong>${r.niche}</strong> — ${r.score}/100<br><span class="muted">${r.reason}</span></span></div>`;
      });
      document.getElementById("nicheResults").innerHTML = html;

      if (best.score > 75) {
        toast(`🟢 Най-добра ниша: ${best.niche} (${best.score}/100)`);
        document.getElementById("conceptCard").style.display = "block";
        document.getElementById("nicheScore").value = best.score + "/100";
        await this.generateConcept(best.niche);
      } else {
        toast(`Най-добър резултат ${best.score}/100 — под прага 75, но може да продължиш ръчно.`);
        document.getElementById("conceptCard").style.display = "block";
        document.getElementById("nicheScore").value = best.score + "/100";
        await this.generateConcept(best.niche);
      }
    } catch (e) {
      document.getElementById("nicheResults").innerHTML = "❌ " + e.message;
    }
  },

  async generateConcept(niche) {
    const prompt = `За музикалната ниша "${niche}" за 2026 генерирай:
1. Кратко, запомнящо се заглавие на песен (на български или английски, каквото пасва на жанра)
2. Style Prompt за Suno AI (детайлен, максимум 200 символа, описващ звук/настроение/инструменти)
3. Точно 3 хаштага (с #, релевантни за YouTube/TikTok/Instagram)

Върни ЧИСТ JSON: {"title":"...", "style_prompt":"...", "hashtags":["#...","#...","#..."]}`;
    try {
      const raw = await callClaude(prompt, 400);
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      const c = JSON.parse(jsonStr);
      document.getElementById("songTitle").value = c.title;
      document.getElementById("stylePrompt").value = c.style_prompt;
      document.getElementById("hashtagsOut").innerHTML = c.hashtags.map(h => `<span>${h}</span>`).join("");

      AppState.data.project.title = c.title;
      AppState.data.project.stylePrompt = c.style_prompt;
      AppState.data.project.hashtags = c.hashtags;
      AppState.save();
    } catch (e) {
      toast("Грешка при генериране на концепция: " + e.message);
    }
  },

  async generateLyrics() {
    const niche = AppState.data.project.chosenNiche || "modern pop";
    const title = AppState.data.project.title || "(без заглавие)";
    const prompt = `Напиши текст на песен в жанр "${niche}", със заглавие "${title}".
ЗАДЪЛЖИТЕЛНО:
- [Chorus] секцията да е НАЙ-ОТПРЕД (преди първия куплет)
- Използвай ясни мета-тагове: [Chorus], [Verse], [Drop] (ако жанрът позволява drop)
- Текстът да е готов за качване в Suno AI
Върни само текста с таговете, без допълнителни обяснения.`;
    document.getElementById("lyricsOut").value = "⏳ Генерирам...";
    try {
      const lyrics = await callClaude(prompt, 900);
      document.getElementById("lyricsOut").value = lyrics;
      AppState.data.project.lyrics = lyrics;
      AppState.save();
    } catch (e) {
      document.getElementById("lyricsOut").value = "";
      toast("Грешка: " + e.message);
    }
  },

  async validateWithGemini() {
    const lyrics = document.getElementById("lyricsOut").value;
    const niche = AppState.data.project.chosenNiche || "";
    if (!lyrics.trim()) return toast("Първо генерирай текст на песента");
    const prompt = `Анализирай следния текст на песен за жанр "${niche}".
Дай честна, кратка оценка (5-8 изречения) на:
- качеството и логиката на римите
- дали пасва на жанра
- структурата (има ли ясен Chorus/Verse/Drop)
Текст:
${lyrics}`;
    document.getElementById("geminiOut").textContent = "⏳ Анализирам с Gemini...";
    try {
      const review = await callGemini(prompt);
      document.getElementById("geminiOut").textContent = review;
      AppState.data.project.geminiReview = review;
      AppState.save();
    } catch (e) {
      document.getElementById("geminiOut").textContent = "❌ " + e.message;
    }
  }
};

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
      const raw = await callClaude(prompt, 300);
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      document.getElementById("fxConfigOut").value = JSON.stringify(JSON.parse(jsonStr), null, 2);
      AppState.data.project.fxConfig = jsonStr;
      AppState.save();
    } catch (e) {
      document.getElementById("fxConfigOut").value = "";
      toast("Грешка: " + e.message);
    }
  }
  // TODO: renderVisualizer() — ще бъде добавена тук след интеграция
  // на съществуващия ти HTML/JS визуализатор (видео1 + видео2 + лого).
};

/* =========================================================
   STEP 3 — DistroKid & Обложка
   ========================================================= */
const Step3 = {
  async generateCoverPrompt() {
    const title = AppState.data.project.title || "untitled";
    const niche = AppState.data.project.chosenNiche || "pop";
    const prompt = `Създай детайлен визуален промпт (на английски, за Imagen/Flow Music AI) за квадратна
обложка на песен (3000x3000px, streaming cover art) със заглавие "${title}" в жанр "${niche}".
Опиши стил, цветова палитра, композиция, настроение. Максимум 4-5 изречения, само промпта.`;
    document.getElementById("coverPromptOut").value = "⏳ Генерирам...";
    try {
      const p = await callClaude(prompt, 300);
      document.getElementById("coverPromptOut").value = p;
      AppState.data.project.coverPrompt = p;
      AppState.save();
    } catch (e) {
      document.getElementById("coverPromptOut").value = "";
      toast("Грешка: " + e.message);
    }
  },

  async generateCoverImage() {
    const prompt = document.getElementById("coverPromptOut").value.trim();
    if (!prompt) return toast("Първо генерирай визуалния промпт");
    const k = Keys.load();
    if (!k.gemini) return toast("⚠️ Нужен е Gemini/Imagen API ключ в Настройки");

    document.getElementById("coverImgOut").innerHTML = "⏳ Генерирам обложка...";
    try {
      // ЗАБЕЛЕЖКА: Точният endpoint/модел за Imagen генериране на изображения
      // през Gemini API може да варира — провери актуалното име на модела
      // в Google AI Studio (напр. модел с "image-generation" в името).
      // Тук е генеричен пример с responseModalities.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${k.gemini}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Square album cover art, 3000x3000px composition: ${prompt}` }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
        })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const imgPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imgPart) throw new Error("Моделът не върна изображение — провери името на модела в Настройки/документацията.");
      const imgUrl = `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
      document.getElementById("coverImgOut").innerHTML = `<img src="${imgUrl}" style="max-width:300px;border-radius:8px;">`;
      AppState.data.project.coverImageUrl = imgUrl;
      AppState.save();
    } catch (e) {
      document.getElementById("coverImgOut").innerHTML = `❌ ${e.message}<br><span class="muted">Ако Imagen откаже директен браузър достъп (CORS), ще трябва малък proxy — виж бележките в разговора.</span>`;
    }
  },

  buildDistrokidFields() {
    const p = AppState.data.project;
    const fields = [
      { label: "Заглавие", value: p.title || "" },
      { label: "Изпълнител", value: "CD-B Records" },
      { label: "Жанр", value: p.chosenNiche || "" },
      { label: "Цена", value: "$5.99" },
      { label: "AI отметки", value: "✅ Съдържа AI-генерирана музика / текст" },
      { label: "Хаштагове", value: (p.hashtags || []).join(" ") },
    ];
    let html = "";
    fields.forEach((f, i) => {
      html += `<label>${f.label}</label>
        <div class="copy-field">
          <span id="dk-field-${i}">${f.value || "(няма данни — попълни Стъпка 1)"}</span>
          <button onclick="Step3.copyField(${i})">📋 Copy</button>
        </div>`;
    });
    document.getElementById("distrokidFields").innerHTML = html;
    AppState.data.project.distrokid = fields;
    AppState.save();
  },

  copyField(i) {
    const text = document.getElementById(`dk-field-${i}`).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Копирано ✅"));
  }
};

/* =========================================================
   STEP 4 — YouTube Публикуване (Unlisted)
   ========================================================= */
const Step4 = {
  tokenClient: null,
  accessToken: null,

  initGoogleAuth() {
    const k = Keys.load();
    if (!k.ytClientId || !window.google) return;
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: k.ytClientId,
      scope: "https://www.googleapis.com/auth/youtube.upload",
      callback: (resp) => {
        this.accessToken = resp.access_token;
        document.getElementById("gAuthStatus").textContent = "✅ Вписан";
        document.getElementById("gAuthStatus").className = "badge ok";
        toast("Успешен вход в Google");
      }
    });
    document.getElementById("gSignInBtn").innerHTML =
      `<button class="ghost" onclick="Step4.tokenClient.requestAccessToken()">🔑 Вход с Google</button>`;
  },

  async uploadVideo() {
    if (!this.accessToken) return toast("⚠️ Първо влез с Google бутона по-горе");
    const fileInput = document.getElementById("youtubeVideoFile");
    if (!fileInput.files.length) return toast("Избери видео файл");
    const file = fileInput.files[0];

    const title = document.getElementById("ytTitle").value || AppState.data.project.title || "Untitled";
    const description = document.getElementById("ytDescription").value;
    const tags = document.getElementById("ytTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const madeForKids = document.getElementById("ytMadeForKids").checked;

    const metadata = {
      snippet: { title, description, tags },
      status: {
        privacyStatus: "unlisted", // ЗАДЪЛЖИТЕЛНО — не се променя
        selfDeclaredMadeForKids: madeForKids,
        containsSyntheticMedia: true // Synthetic/AI content отметка
      }
    };

    document.getElementById("ytUploadProgress").textContent = "⏳ Качвам видеото...";
    try {
      // Стъпка 1: инициализация на resumable upload сесия
      const initRes = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": file.type
          },
          body: JSON.stringify(metadata)
        }
      );
      if (!initRes.ok) throw new Error(await initRes.text());
      const uploadUrl = initRes.headers.get("Location");

      // Стъпка 2: качване на самия файл
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });
      if (!uploadRes.ok) throw new Error(await uploadRes.text());
      const result = await uploadRes.json();

      document.getElementById("ytUploadProgress").innerHTML =
        `✅ Качено! Video ID: <strong>${result.id}</strong> (unlisted)`;
      AppState.data.project.youtube = { videoId: result.id, title };
      AppState.save();
    } catch (e) {
      document.getElementById("ytUploadProgress").textContent = "❌ " + e.message;
    }
  }
};

/* =========================================================
   INIT
   ========================================================= */
window.addEventListener("DOMContentLoaded", () => {
  Nav.init();
  Step3.buildDistrokidFields();

  // Зареждаме Google Identity Services скрипта динамично
  const gsi = document.createElement("script");
  gsi.src = "https://accounts.google.com/gsi/client";
  gsi.onload = () => Step4.initGoogleAuth();
  document.head.appendChild(gsi);
});
