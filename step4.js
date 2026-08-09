/* =========================================================
   Преместен 1:1 от app.js (Стъпка "Нова стъпка след одита" —
   останалите namespace-и, шеста итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   Keys, AppState, QuickUpload, toast().
   ========================================================= */
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
        document.querySelectorAll(".g-auth-status").forEach(el => { el.textContent = "✅ Вписан"; el.className = "chip green g-auth-status"; });
        toast("Успешен вход в Google");
        // Ако Бърз ъплоуд вече има готово видео + метаданни и е чакал само Google вход — качва автоматично.
        if (window.QuickUpload) QuickUpload._checkBothReady();
      }
    });
    document.querySelectorAll(".g-signin-slot").forEach(el => {
      el.innerHTML = `<button class="ghost" onclick="Step4.tokenClient.requestAccessToken()">🔑 Вход с Google</button>`;
    });
  },

  // fileOverride/metaOverride/progressElId — по избор, ползва се от QuickUpload режима,
  // за да качи видео Blob-а от визуализатора директно, без потребителят да минава
  // през ръчния <input type="file"> на Стъпка 3.
  async uploadVideo(fileOverride, metaOverride, progressElId) {
    if (!this.accessToken) return toast("⚠️ Първо влез с Google бутона по-горе");
    const progressEl = document.getElementById(progressElId || "ytUploadProgress");

    let file = fileOverride;
    if (!file) {
      const fileInput = document.getElementById("youtubeVideoFile");
      if (!fileInput.files.length) return toast("Избери видео файл");
      file = fileInput.files[0];
    }

    const title = metaOverride?.title ?? (document.getElementById("ytTitle").value || AppState.data.project.title || "Untitled");
    const description = metaOverride?.description ?? document.getElementById("ytDescription").value;
    const tags = metaOverride?.tags ?? document.getElementById("ytTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const madeForKids = metaOverride?.madeForKids ?? document.getElementById("ytMadeForKids").checked;

    const metadata = {
      snippet: { title, description, tags },
      status: {
        privacyStatus: "unlisted", // ЗАДЪЛЖИТЕЛНО — не се променя
        selfDeclaredMadeForKids: madeForKids,
        containsSyntheticMedia: true // Synthetic/AI content отметка
      }
    };

    progressEl.textContent = "⏳ Качвам видеото...";
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

      progressEl.innerHTML =
        `✅ Качено! Video ID: <strong>${result.id}</strong> (unlisted)`;
      AppState.data.project.youtube = { videoId: result.id, title };
      AppState.save();
      return result;
    } catch (e) {
      progressEl.textContent = "❌ " + e.message;
      throw e;
    }
  }
};
