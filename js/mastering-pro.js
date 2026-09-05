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
     2) upload-ваме и двата (+ job.json мета) в GitHub — ВСИЧКИ В ЕДИН
        commit, през Git Data API (blobs → tree → commit → ref), а НЕ
        през Contents API (виж бележката "ЗАЩО GIT DATA API" по-долу)
     3) тригваме .github/workflows/mastering-pro.yml (workflow_dispatch)
     4) polls-ваме mastering-jobs/<job_id>/status.json (Contents API —
        status.json е малък, KB-та, тук няма проблем) на всеки
        MASTERING_PRO_POLL_MS, докато state стане "done"/"error"
     5) при "done" — сваляме result.wav (виж ghGetFileBinary — за файлове
        >1MB Contents API не връща 'content', теглим суровия файл през
        'download_url'), показваме плейър + download бутон + LUFS/True-Peak
        метрики до/след

   ЗАЩО GIT DATA API (blobs/trees/commits/refs), А НЕ CONTENTS API:
   -----------------------------------------------------------------
   PUT /repos/{owner}/{repo}/contents/{path} (Contents API) приема base64
   съдържание директно в JSON тялото на заявката — GitHub го отхвърля с
   422 "file is too large" някъде над ~20-25MB base64 payload (недокументиран
   точен праг, но многократно наблюдаван на практика). POST /git/blobs
   (Git Data API) е проектиран точно за големи бинарни файлове и поддържа
   до 100MB суров файл на blob. Затова: правим 1 blob на файл (target.wav,
   reference.wav, job.json), после 1 tree, после 1 commit, после branch
   ref-ът се мести напред към новия commit — ВСИЧКИ ТРИ ФАЙЛА влизат в
   ЕДИН commit (по-бързо и атомарно от 3 отделни Contents API PUT-а).

   Зависимости (runtime): Keys, fetchTimeout, toast(), AppLog,
   fileToBase64() (js/ai-helpers.js) — заредени ПРЕДИ този файл в index.html.

   GitHub изисквания за да работи: Keys.load() трябва да съдържа ghToken
   (нужни права: repo contents read/write + Actions read/write) + ghOwner
   + ghRepo (+ опционално ghBranch, по подразбиране "main").
   ============================================================ */

const MASTERING_PRO_WORKFLOW_FILE = "mastering-pro.yml";
const MASTERING_PRO_POLL_MS = 15000;
const MASTERING_PRO_TIMEOUT_MS = 15 * 60 * 1000; // 15 мин — над това спираме polling-а и показваме грешка
// Git Data API (git/blobs) поддържа до 100MB суров файл на blob — пазим
// разумен марж (browser upload на ~100MB base64 текст, ~137MB stringified
// в паметта, все още е практически поносимо, но с растящ риск от timeout/
// памет при по-бавна връзка, затова спираме на 90MB, не на честите 100MB).
const MASTERING_PRO_MAX_FILE_MB = 90;

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
      toast(`❌ Файлът е ${(file.size / 1024 / 1024).toFixed(1)}MB — максимумът е ~${MASTERING_PRO_MAX_FILE_MB}MB (GitHub Git Data API лимит за един blob). Пробвай по-къс/по-нискокачествен WAV.`, 6000);
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

  // ---- Git Data API (blobs/trees/commits/refs) — за ГОЛЕМИ файлове (WAV) ----

  async function ghGetRef(k, branch) {
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/git/ref/heads/${branch}`,
      { headers: authHeaders(k, false) }
    );
  }

  async function ghGetCommit(k, sha) {
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/git/commits/${sha}`,
      { headers: authHeaders(k, false) }
    );
  }

  async function ghCreateBlob(k, base64Content) {
    // до 100MB суров файл на blob — голям timeout, защото base64 текстът
    // на десетки MB отнема повече от обичайните 20сек за upload+обработка.
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/git/blobs`,
      { method: "POST", headers: authHeaders(k, true), body: JSON.stringify({ content: base64Content, encoding: "base64" }) },
      120000
    );
  }

  async function ghCreateTree(k, baseTreeSha, entries) {
    // entries: [{ path, mode: "100644", type: "blob", sha }, ...]
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/git/trees`,
      { method: "POST", headers: authHeaders(k, true), body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }) },
      30000
    );
  }

  async function ghCreateCommit(k, message, treeSha, parentSha) {
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/git/commits`,
      { method: "POST", headers: authHeaders(k, true), body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }) },
      30000
    );
  }

  async function ghUpdateRef(k, branch, commitSha) {
    return ghJson(
      `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/git/refs/heads/${branch}`,
      { method: "PATCH", headers: authHeaders(k, true), body: JSON.stringify({ sha: commitSha, force: false }) },
      20000
    );
  }

  // Качва множество файлове (base64) в ЕДИН commit чрез Git Data API.
  // files: [{ path, base64 }, ...]
  // С 3 опита при "ref конфликт" (друг commit е минал междувременно между
  // прочитането на HEAD и местенето на branch-а — рядко, но възможно при
  // паралелни job-ове), всеки път пресъздава tree/commit върху свежия HEAD.
  async function ghCommitFilesViaBlobs(k, files, message, onStep) {
    const branch = k.ghBranch || "main";
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (onStep) onStep(`⏳ Чета текущото състояние на ${branch}...`);
        const refData = await ghGetRef(k, branch);
        const latestCommitSha = refData.object.sha;
        const commitData = await ghGetCommit(k, latestCommitSha);
        const baseTreeSha = commitData.tree.sha;

        const entries = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (onStep) onStep(`⏳ Качвам ${f.path} (${i + 1}/${files.length})...`);
          const blob = await ghCreateBlob(k, f.base64);
          entries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
        }

        if (onStep) onStep("⏳ Създавам git tree/commit...");
        const tree = await ghCreateTree(k, baseTreeSha, entries);
        const commit = await ghCreateCommit(k, message, tree.sha, latestCommitSha);

        if (onStep) onStep("⏳ Местя " + branch + " към новия commit...");
        await ghUpdateRef(k, branch, commit.sha);
        return commit;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) continue; // вероятно ref конфликт — пробвай пак върху свеж HEAD
      }
    }
    throw lastErr;
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
      setProgress("⏳ Подготвям файловете за качване (base64)...");
      const targetB64 = await fileToBase64(targetFile);
      const refB64 = await fileToBase64(referenceFile);
      const jobMeta = { created_at: new Date().toISOString(), target_name: targetFile.name, reference_name: referenceFile.name };
      const jobMetaB64 = btoa(unescape(encodeURIComponent(JSON.stringify(jobMeta, null, 2) + "\n")));

      // И трите файла (target.wav + reference.wav + job.json) в ЕДИН commit,
      // през Git Data API — виж бележката "ЗАЩО GIT DATA API" в началото
      // на файла (Contents API 422-ва над ~20-25MB base64 payload).
      await ghCommitFilesViaBlobs(
        k,
        [
          { path: `${jobDir}/target.wav`, base64: targetB64 },
          { path: `${jobDir}/reference.wav`, base64: refB64 },
          { path: `${jobDir}/job.json`, base64: jobMetaB64 }
        ],
        `🎚️ Mastering Pro: upload job ${jobId}`,
        setProgress
      );

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
