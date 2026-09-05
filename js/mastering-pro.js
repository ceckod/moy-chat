/* ============================================================
   js/mastering-pro.js — "Pro Мастеринг" (reference-matching, сървърна
   обработка през GitHub Actions)
   ============================================================
   За разлика от js/mastering.js (изцяло client-side, Web Audio API —
   бърз preview слой), тук РЕАЛНАТА DSP обработка (matchering + true-peak
   лимитер + LUFS + де-есер + мултибанд + дитър) се пуска в
   scripts/master_engine.py на GitHub Actions ubuntu-latest машина —
   неща като 4x oversampled true-peak лимитер и FFT reference matching
   са непрактични за пълноценна имплементация в браузъра.

   Flow:
     1) потребителят пуска TARGET + REFERENCE WAV файлове
     2) upload-ваме и двата (+ job.json мета) в GitHub през Contents API
        (mastering-jobs/<job_id>/...) — repository_dispatch/workflow_dispatch
        payload лимитът е 64KB, недостатъчен за аудио, затова файловете
        минават през Contents API commit, а НЕ през dispatch inputs
     3) тригваме .github/workflows/mastering-pro.yml (workflow_dispatch)
     4) polls-ваме mastering-jobs/<job_id>/status.json (Contents API)
        на всеки MASTERING_PRO_POLL_MS, докато state стане "done"/"error"
     5) при "done" — сваляме result.wav (Contents API GET, base64 decode
        → Blob), показваме плейър + download бутон + LUFS/True-Peak
        метрики до/след

   Зависимости (runtime): Keys, fetchTimeout, toast(), AppLog,
   fileToBase64() (js/ai-helpers.js) — заредени ПРЕДИ този файл в index.html.

   GitHub изисквания за да работи: Keys.load() трябва да съдържа ghToken
   (нужни права: repo contents read/write + Actions read/write) + ghOwner
   + ghRepo (+ опционално ghBranch, по подразбиране "main").
   ============================================================ */

const MASTERING_PRO_WORKFLOW_FILE = "mastering-pro.yml";
const MASTERING_PRO_POLL_MS = 15000;
const MASTERING_PRO_TIMEOUT_MS = 15 * 60 * 1000; // 15 мин — над това спираме polling-а и показваме грешка
// GitHub Contents API практически лимит за base64 upload на един файл.
// (Хард лимитът на GitHub е 100MB суров файл, но base64 добавя ~37%
// overhead към payload-а, а много големи PUT заявки от браузъра стават
// ненадеждни — затова пазим приличен марж.)
const MASTERING_PRO_MAX_FILE_MB = 45;

const MasteringPro = (function () {
  let targetFile = null;
  let referenceFile = null;
  let currentJobId = null;
  let pollTimer = null;
  let pollStartedAt = 0;

  function $(id) { return document.getElementById(id); }

  function ghConfig() {
    try { return (typeof Keys !== "undefined") ? Keys.load() : {}; }
    catch (e) { return {}; }
  }

  function init() {
    const dropTarget = $("masteringProTargetInput");
    const dropRef = $("masteringProReferenceInput");
    if (!dropTarget || !dropRef) return; // view-то не е в DOM-а
    dropTarget.addEventListener("change", (e) => setFile("target", e.target.files[0]));
    dropRef.addEventListener("change", (e) => setFile("reference", e.target.files[0]));
    updateProcessButton();
  }

  function setFile(kind, file) {
    if (!file) return;
    if (file.size > MASTERING_PRO_MAX_FILE_MB * 1024 * 1024) {
      toast(`❌ Файлът е ${(file.size / 1024 / 1024).toFixed(1)}MB — максимумът за upload през GitHub е ~${MASTERING_PRO_MAX_FILE_MB}MB. Пробвай по-къс/по-нискокачествен WAV.`, 6000);
      return;
    }
    if (kind === "target") {
      targetFile = file;
      $("masteringProTargetName").textContent = file.name + " (" + (file.size / 1024 / 1024).toFixed(1) + "MB)";
    } else {
      referenceFile = file;
      $("masteringProReferenceName").textContent = file.name + " (" + (file.size / 1024 / 1024).toFixed(1) + "MB)";
    }
    updateProcessButton();
  }

  function updateProcessButton() {
    const btn = $("masteringProProcessBtn");
    if (btn) btn.disabled = !(targetFile && referenceFile);
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // резервен вариант за по-стари браузъри без randomUUID
    return "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function setProgress(msg) {
    const el = $("masteringProProgress");
    if (el) { el.style.display = "block"; el.textContent = msg; }
    AppLog.write("🎚️ Mastering Pro", msg);
  }

  // ---------- GitHub Contents API помощни функции (същия pattern като в mastering.js/metadata-optimizer.js) ----------

  async function ghPutFile(k, path, base64Content, commitMessage) {
    const branch = k.ghBranch || "main";
    const url = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/${path}`;
    const res = await fetchTimeout(url, {
      method: "PUT",
      headers: { Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message: commitMessage, content: base64Content, branch }),
    }, 60000);
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async function ghGetFile(k, path) {
    const branch = k.ghBranch || "main";
    const url = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/${path}?ref=${branch}&t=${Date.now()}`;
    const res = await fetchTimeout(url, {
      headers: { Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json" },
    }, 20000);
    if (res.status === 404) return null; // все още не съществува — нормално докато чакаме workflow-а
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  function decodeBase64Json(meta) {
    return JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\n/g, "")))));
  }

  // ---------- Главен flow ----------

  async function process() {
    const k = ghConfig();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) {
      toast("❌ Липсва GitHub Token/owner/repo — виж Настройки → API Ключове (нужни права: repo contents + Actions за този токен)");
      return;
    }
    if (!targetFile || !referenceFile) { toast("❌ Избери и TARGET, и REFERENCE файл"); return; }

    const jobId = uuid();
    currentJobId = jobId;
    const jobDir = `mastering-jobs/${jobId}`;
    const targetPeakDb = parseFloat($("masteringProTargetPeak")?.value) || -1.0;

    $("masteringProResultWrap") && ($("masteringProResultWrap").style.display = "none");
    $("masteringProProcessBtn").disabled = true;

    try {
      setProgress("⏳ Качвам TARGET файла в GitHub...");
      const targetB64 = await fileToBase64(targetFile);
      await ghPutFile(k, `${jobDir}/target.wav`, targetB64, `🎚️ Mastering Pro: upload target (${jobId})`);

      setProgress("⏳ Качвам REFERENCE файла в GitHub...");
      const refB64 = await fileToBase64(referenceFile);
      await ghPutFile(k, `${jobDir}/reference.wav`, refB64, `🎚️ Mastering Pro: upload reference (${jobId})`);

      setProgress("⏳ Записвам мета информация за job-а...");
      const jobMeta = { created_at: new Date().toISOString(), target_name: targetFile.name, reference_name: referenceFile.name };
      const jobMetaB64 = btoa(unescape(encodeURIComponent(JSON.stringify(jobMeta, null, 2) + "\n")));
      await ghPutFile(k, `${jobDir}/job.json`, jobMetaB64, `🎚️ Mastering Pro: job meta (${jobId})`);

      setProgress("▶️ Тригвам GitHub Actions (Mastering Pro Engine)...");
      const branch = k.ghBranch || "main";
      const dispatchRes = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/workflows/${MASTERING_PRO_WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: { Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ ref: branch, inputs: { job_id: jobId, target_peak_db: String(targetPeakDb) } }),
        }, 20000
      );
      if (!dispatchRes.ok) throw new Error(`GitHub ${dispatchRes.status}: ${(await dispatchRes.text()).slice(0, 300)}`);

      setProgress("⏳ Обработка стартирана — обикновено отнема 1-3 мин (matchering + лимитер + LUFS анализ)...");
      pollStartedAt = Date.now();
      schedulePoll(jobId);
    } catch (e) {
      console.error(e);
      toast("❌ " + e.message, 6000);
      setProgress("❌ Грешка: " + e.message);
      $("masteringProProcessBtn").disabled = false;
    }
  }

  function schedulePoll(jobId) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => pollStatus(jobId), MASTERING_PRO_POLL_MS);
  }

  async function pollStatus(jobId) {
    if (jobId !== currentJobId) return; // потребителят е стартирал нов job междувременно
    if (Date.now() - pollStartedAt > MASTERING_PRO_TIMEOUT_MS) {
      setProgress("❌ Изтече времето за изчакване (15 мин) — провери Actions таба в GitHub ръчно за причината.");
      $("masteringProProcessBtn").disabled = false;
      return;
    }
    const k = ghConfig();
    const jobDir = `mastering-jobs/${jobId}`;
    try {
      const statusMeta = await ghGetFile(k, `${jobDir}/status.json`);
      if (!statusMeta) { schedulePoll(jobId); return; } // все още обработва
      const status = decodeBase64Json(statusMeta);
      if (status.state === "done") {
        await onJobDone(jobId, status, k);
      } else if (status.state === "error") {
        setProgress("❌ Engine-ът се провали: " + (status.message || "неизвестна грешка"));
        toast("❌ Mastering Pro се провали: " + (status.message || ""), 6000);
        $("masteringProProcessBtn").disabled = false;
      } else {
        schedulePoll(jobId);
      }
    } catch (e) {
      // мрежова грешка при polling — не се отказваме, просто опитваме пак
      schedulePoll(jobId);
    }
  }

  async function onJobDone(jobId, status, k) {
    setProgress("⏳ Готово! Свалям резултата...");
    const jobDir = `mastering-jobs/${jobId}`;
    const resultMeta = await ghGetFile(k, `${jobDir}/result.wav`);
    if (!resultMeta) { setProgress("❌ status.json казва 'done', но result.wav липсва — виж Actions лога."); return; }

    const binary = atob(resultMeta.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);

    const player = $("masteringProPlayer");
    if (player) player.src = url;
    const dl = $("masteringProDownloadBtn");
    if (dl) {
      dl.onclick = () => {
        const a = document.createElement("a");
        a.href = url; a.download = (targetFile?.name || "mastered").replace(/\.wav$/i, "") + "_pro_mastered.wav";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      };
    }
    const statsEl = $("masteringProStats");
    if (statsEl) {
      statsEl.innerHTML = `
        <div>LUFS (integrated): ${status.lufs_before ?? "—"} → <strong>${status.lufs_after ?? "—"}</strong></div>
        <div>True Peak: ${status.true_peak_before_db ?? "—"} dBTP → <strong>${status.true_peak_after_db ?? "—"} dBTP</strong> (таван: ${status.target_peak_db ?? "—"} dBTP)</div>
      `;
    }
    $("masteringProResultWrap") && ($("masteringProResultWrap").style.display = "block");
    setProgress("✅ Готово!");
    toast("✅ Pro мастеринг готов");
    $("masteringProProcessBtn").disabled = false;
  }

  init();

  return { process };
})();
