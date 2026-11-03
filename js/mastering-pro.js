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
     2) създаваме GitHub Release с таг "mastering-job-<job_id>" и
        upload-ваме target.wav + reference.wav като RELEASE ASSETS
        (Releases API — виж "ЗАЩО RELEASES API ЗА ВХОДА" по-долу), а НЕ
        през Git Data API blobs както преди
     3) тригваме .github/workflows/mastering-pro.yml (workflow_dispatch),
        което сваля 2-та asset-а server-side (`gh release download`)
     4) polls-ваме mastering-jobs/<job_id>/status.json (Contents API —
        status.json е малък, KB-та, тук няма проблем; ТОВА Е НЕПРОМЕНЕНО
        спрямо старата версия) на всеки MASTERING_PRO_POLL_MS, докато
        state стане "done"/"error"
     5) при "done" — сваляме result.wav (ghGetFileBinary — за файлове
        >1MB Contents API не връща 'content', теглим суровия файл през
        'download_url'; ТОВА Е СЪЩО НЕПРОМЕНЕНО), показваме плейър +
        download бутон + LUFS/True-Peak метрики до/след

   ЗАЩО RELEASES API ЗА ВХОДА (target.wav/reference.wav), А НЕ GIT DATA API:
   -----------------------------------------------------------------
   Git Data API (git/blobs) поддържа само до 100MB суров файл на blob —
   недостатъчно за 24-bit/96kHz WAV-ове или по-дълги трекове. GitHub
   Releases API (POST към uploads.github.com/repos/.../releases/{id}/assets)
   приема СУРОВ бинарен body (не base64 — без 33% overhead) и поддържа до
   2GB на asset, затова се използва тук за ВХОДА.

   ЗАЩО ИЗХОДЪТ (result.wav) ПРОДЪЛЖАВА ДА МИНАВА ПРЕЗ GIT (Contents API),
   А НЕ ПРЕЗ RELEASES API:
   -----------------------------------------------------------------
   Release asset-ите се сервират от release-assets.githubusercontent.com,
   който НЕ връща Access-Control-Allow-Origin хедър — браузърът блокира
   fetch() към тях с CORS грешка, дори при публично repo (проверено:
   само обикновена <a href> навигация/сваляне минава, а не JS fetch, а на
   нас ни трябват суровите байтове в паметта, за да ги пуснем в <audio>
   плейъра inline и да покажем LUFS/True-Peak метриките). raw.githubusercontent.com
   (пътят зад Contents API 'download_url', вижте ghGetFileBinary по-долу)
   Е CORS-friendly (връща Access-Control-Allow-Origin: *) — затова
   result.wav продължава да се commit-ва в git от workflow-а, както преди
   промяната. Практическо ограничение от това: изходният файл е все още
   ограничен до ~100MB (git push лимит), т.е. ~8-9 мин при 16-bit/44.1kHz
   стерео — напълно достатъчно за единичен мастъртрак, но не и за цял
   албум като един файл.

   Зависимости (runtime): Keys, fetchTimeout, toast(), AppLog —
   заредени ПРЕДИ този файл в index.html. (fileToBase64() вече НЕ се
   ползва тук — release asset upload-ът праща сурови байтове, не base64.)

   GitHub изисквания за да работи: Keys.load() трябва да съдържа ghToken
   (нужни права: repo contents read/write + Actions read/write) + ghOwner
   + ghRepo (+ опционално ghBranch, по подразбиране "main").
   ============================================================ */

const MASTERING_PRO_WORKFLOW_FILE = "mastering-pro.yml";
const MASTERING_PRO_POLL_MS = 15000;
const MASTERING_PRO_TIMEOUT_MS = 15 * 60 * 1000; // 15 мин — над това спираме polling-а и показваме грешка
// GitHub Releases API лимит е 2GB (2048MB) на asset — пазим разумен
// марж (по-бавни връзки/browser паметта при много голям файл), затова
// спираме на 1800MB, не на твърдия таван.
const MASTERING_PRO_MAX_FILE_MB = 1800;

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
      toast(`❌ Файлът е ${(file.size / 1024 / 1024).toFixed(1)}MB — максимумът е ~${MASTERING_PRO_MAX_FILE_MB}MB (GitHub Releases API лимит от 2GB на asset, с марж). Пробвай по-къс/по-нискокачествен WAV.`, 6000);
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

  // ---------- GitHub API помощни функции ----------

  function authHeaders(k, isWrite) {
    const h = { Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json" };
    if (isWrite) h["Content-Type"] = "application/json";
    return h;
  }

  async function ghJson(url, opts, timeoutMs) {
    const res = await fetchTimeout(url, opts, timeoutMs || 20000);
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  // ---- Contents API — само за МАЛКИ файлове (status.json, job.json четене) ----

  async function ghGetFile(k, path) {
    const branch = k.ghBranch || "main";
    const url = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/${path}?ref=${branch}&t=${Date.now()}`;
    const res = await fetchTimeout(url, { headers: authHeaders(k, false) }, 20000);
    if (res.status === 404) return null; // все още не съществува — нормално докато чакаме workflow-а
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  function decodeBase64Json(meta) {
    return JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\n/g, "")))));
  }

  // Универсално сваляне на бинарен файл през Contents API мета-обекта:
  // - файлове ≤1MB: GitHub връща 'content' (base64) директно в JSON-а
  // - файлове >1MB (до 100MB): 'content' липсва/е празно, но 'download_url'
  //   сочи към суровия файл (raw.githubusercontent.com) — теглим него.
  async function ghGetFileBinary(k, path) {
    const meta = await ghGetFile(k, path);
    if (!meta) return null;
    if (meta.content && meta.encoding === "base64") {
      const binary = atob(meta.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    if (meta.download_url) {
      const res = await fetchTimeout(meta.download_url, {}, 60000);
      if (!res.ok) throw new Error(`GitHub download_url ${res.status}`);
      return res.arrayBuffer();
    }
    throw new Error("Файлът е върнат без 'content' и без 'download_url' — неочакван GitHub API отговор.");
  }

  // ---- Releases API — за ГОЛЕМИ входни файлове (target.wav/reference.wav) ----

  // Създава нов GitHub Release с даден таг (draft:false, prerelease:true —
  // маркираме го ясно като временен/автоматичен, не истинско издание).
  // Връща release обекта, вкл. 'id' и 'upload_url' (templated, виж по-долу).
  async function ghCreateRelease(k, tagName) {
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/releases`,
      {
        method: "POST",
        headers: authHeaders(k, true),
        body: JSON.stringify({
          tag_name: tagName,
          target_commitish: k.ghBranch || "main",
          name: `🎚️ Mastering Pro job ${tagName}`,
          body: "Автоматично създаден от Mastering Pro за пренос на входни WAV файлове към GitHub Actions. Трие се автоматично до 24ч (виж .github/workflows/mastering-pro-cleanup.yml).",
          draft: false,
          prerelease: true,
        }),
      },
      20000
    );
  }

  // Качва raw бинарен файл като release asset (Releases API, до 2GB) —
  // за разлика от Git Data API blobs, ТУК НЕ base64-ираме файла преди
  // upload (по-малко памет, по-малко overhead, по-бърз upload на голям WAV).
  // uploadUrlTemplate идва от release.upload_url, напр.
  // "https://uploads.github.com/repos/OWNER/REPO/releases/123/assets{?name,label}"
  // — трябва да отрежем "{?name,label}" частта и да сложим ?name= сами.
  async function ghUploadReleaseAsset(k, uploadUrlTemplate, filename, file, contentType) {
    const base = uploadUrlTemplate.replace(/\{.*\}$/, "");
    const url = `${base}?name=${encodeURIComponent(filename)}`;
    const res = await fetchTimeout(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + k.ghToken,
        Accept: "application/vnd.github+json",
        "Content-Type": contentType || "application/octet-stream",
      },
      body: file, // File/Blob — fetch праща суровите байтове директно
    }, 10 * 60 * 1000); // до 10 мин за upload на голям WAV на бавна връзка
    if (!res.ok) throw new Error(`GitHub upload asset ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
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
    const tagName = `mastering-job-${jobId}`;
    const targetPeakDb = parseFloat($("masteringProTargetPeak")?.value) || -1.0;

    $("masteringProResultWrap") && ($("masteringProResultWrap").style.display = "none");
    $("masteringProProcessBtn").disabled = true;

    try {
      // Входните файлове минават през Releases API (виж "ЗАЩО RELEASES API
      // ЗА ВХОДА" в началото на файла) — суров бинарен upload, без base64,
      // до 2GB на файл.
      setProgress("⏳ Създавам GitHub Release за job-а...");
      const release = await ghCreateRelease(k, tagName);

      setProgress(`⏳ Качвам ${targetFile.name} (${(targetFile.size / 1024 / 1024).toFixed(1)}MB)...`);
      await ghUploadReleaseAsset(k, release.upload_url, "target.wav", targetFile, "audio/wav");

      setProgress(`⏳ Качвам ${referenceFile.name} (${(referenceFile.size / 1024 / 1024).toFixed(1)}MB)...`);
      await ghUploadReleaseAsset(k, release.upload_url, "reference.wav", referenceFile, "audio/wav");

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
    let arrayBuf;
    try {
      // result.wav обикновено е >1MB → ghGetFileBinary автоматично минава
      // на 'download_url' вместо base64 'content' (виж коментара при дефиницията ѝ)
      arrayBuf = await ghGetFileBinary(k, `${jobDir}/result.wav`);
    } catch (e) {
      setProgress("❌ Неуспешно сваляне на result.wav: " + e.message);
      toast("❌ " + e.message, 6000);
      $("masteringProProcessBtn").disabled = false;
      return;
    }
    if (!arrayBuf) { setProgress("❌ status.json казва 'done', но result.wav липсва — виж Actions лога."); $("masteringProProcessBtn").disabled = false; return; }

    const blob = new Blob([arrayBuf], { type: "audio/wav" });
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
