/* ============================================================
   js/shorts-pro-render.js — dispatch + poll за "AI Shorts Pro Renderer"
   (.github/workflows/render-pro-short.yml)
   ============================================================
   За разлика от js/shorts-studio.js (изцяло client-side: browser canvas
   рендиране + директен upload в YouTube), ТУК реалната обработка
   (Gemini анализ + Whisper субтитри + FFmpeg композит, 8 визуални стила)
   се пуска сървърно на GitHub Actions ubuntu-latest — виж подробния
   коментар в scripts/render_short_ffmpeg.py защо (per-frame Python в
   браузъра би било непрактично бавно, а Whisper изобщо не тече в
   браузъра).

   Flow:
     1) потребителят избира песен от библиотеката → dispatch(entry)
     2) POST workflow_dispatch с inputs (audio_url/cover_url/song_title/
        artist_name) — ТУК НЕ минаваме през Releases API за входа (за
        разлика от js/mastering-pro.js): audio_url/cover_url са вече
        публични URL-и (DistroKid preview / iTunes artwork), runner-ът ги
        сваля директно сам, няма нужда браузърът да качва бинарни файлове.
     3) workflow_dispatch API-то НЕ връща run_id директно (същият проблем
        като в mastering-pro.js) — ТУК го решаваме различно: mastering-pro
        решава чрез job_id вграден в release tag + status.json на
        предвидим git път; тук няма job_id вход изобщо (по спецификация),
        затова вместо това ПОЛЛВАМЕ списъка от последните run-ове на
        workflow-а веднага след dispatch и намираме нашия по:
          (a) създаден СЛЕД момента на dispatch-а (с малък толеранс)
          (b) run-name-ът (полето "name" в отговора) съдържа song_title
        (виж findOurRun()) — работи надеждно на практика защото ЕДИН
        потребител рядко тригва 2 Shorts рендера в рамките на секунди.
     4) веднъж намерен run_id, поллваме GET .../actions/runs/{id} докато
        status стане "completed"
     5) при успех — резултатното .mp4 е GitHub ARTIFACT, не git commit
        (виж защо в render-pro-short.yml), затова НЕ можем да го покажем
        inline през raw.githubusercontent.com/CORS trick както
        result.wav в mastering-pro.js. Артифактите се сервират само през
        GitHub API с auth хедър — теглим ги като .zip (GET
        .../artifacts/{id}/zip с Authorization: Bearer, fetch следва
        redirect-а автоматично) и предлагаме СВАЛЯНЕ на .zip-а директно
        (БЕЗ клиентско разархивиране — в repo-то няма JS zip библиотека,
        а добавянето само за това е излишно; потребителят разархивира
        локално и отваря .mp4-то). Достатъчно е за работен pipeline —
        подобри по-късно с JSZip ако инлайн preview стане нужен.

   Зависимости (runtime, заредени ПРЕДИ този файл в index.html): Keys,
   fetchTimeout, toast() — същите като js/mastering-pro.js.

   GitHub изисквания: Keys.load() трябва да съдържа ghToken (repo contents
   read/write + Actions read/write), ghOwner, ghRepo (+ опционално
   ghBranch, по подразбиране "main"). GEMINI_API_KEY е GitHub Actions
   secret (сървърна страна, НЕ browser secret) — вече конфигуриран за
   другите AI workflow-и в repo-то (виж youtube-discovery.yml).
   ============================================================ */

const SHORTS_PRO_WORKFLOW_FILE = "render-pro-short.yml";
const SHORTS_PRO_FIND_RUN_TIMEOUT_MS = 60 * 1000;     // до 1 мин да намерим run_id-то
const SHORTS_PRO_FIND_RUN_POLL_MS = 4000;
const SHORTS_PRO_STATUS_POLL_MS = 15000;
const SHORTS_PRO_TIMEOUT_MS = 20 * 60 * 1000;         // Whisper+FFmpeg може да отнеме повече от mastering-а

const ShortsProRender = (() => {
  let currentDispatchToken = 0; // защита срещу overlapping dispatch-и от бързо кликане

  function ghConfig() {
    try { return (typeof Keys !== "undefined") ? Keys.load() : {}; }
    catch { return {}; }
  }

  function authHeaders(k, extra = {}) {
    return { Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json", ...extra };
  }

  // ---------- 1) dispatch ----------

  async function dispatch(entry) {
    // entry: { song, artist, audio_url, cover_url } — audio_url/cover_url
    // трябва да са ВЕЧЕ resolve-нати публични URL-и (виж enrichLibrary()/
    // findLinks() в js/shorts-studio.js за как таблото ги извлича).
    const k = ghConfig();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) {
      toast("❌ Липсва GitHub Token/owner/repo — виж Настройки → API Ключове (нужни права: repo contents + Actions за този токен)");
      return null;
    }
    if (!entry?.audio_url || !entry?.cover_url || !entry?.song || !entry?.artist) {
      toast("❌ Липсва audio_url/cover_url/song/artist за избраната песен");
      return null;
    }

    const myToken = ++currentDispatchToken;
    const dispatchedAt = Date.now();
    const branch = k.ghBranch || "main";

    toast(`▶️ Тригвам AI Shorts рендер за "${entry.song}"...`);
    try {
      const res = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/workflows/${SHORTS_PRO_WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: authHeaders(k, { "Content-Type": "application/json" }),
          body: JSON.stringify({
            ref: branch,
            inputs: {
              audio_url: entry.audio_url,
              cover_url: entry.cover_url,
              song_title: entry.song,
              artist_name: entry.artist,
            },
          }),
        },
        20000
      );
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      console.error(e);
      toast("❌ " + e.message, 6000);
      return null;
    }

    toast("⏳ Търся стартирания run в Actions...");
    const run = await findOurRun(k, entry.song, dispatchedAt, myToken);
    if (!run) {
      if (myToken === currentDispatchToken) {
        toast("⚠ Тригнато е, но не намерих run-а автоматично — провери Actions таба ръчно.", 8000);
      }
      return null;
    }

    toast(`⏳ Рендиране в процес (run #${run.run_number})...`);
    return pollRunUntilDone(k, run.id, myToken);
  }

  // ---------- 2) намиране на нашия run (workflow_dispatch не връща run_id) ----------

  async function findOurRun(k, songTitle, dispatchedAt, myToken) {
    const deadline = Date.now() + SHORTS_PRO_FIND_RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (myToken !== currentDispatchToken) return null; // потребителят е тригнал нов dispatch междувременно
      try {
        const res = await fetchTimeout(
          `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/workflows/${SHORTS_PRO_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`,
          { headers: authHeaders(k) },
          15000
        );
        if (res.ok) {
          const data = await res.json();
          const candidate = (data.workflow_runs || []).find((r) => {
            const created = new Date(r.created_at).getTime();
            return created >= dispatchedAt - 10000 && (r.name || "").includes(songTitle);
          });
          if (candidate) return candidate;
        }
      } catch { /* мрежова грешка при polling — просто опитваме пак */ }
      await new Promise((r) => setTimeout(r, SHORTS_PRO_FIND_RUN_POLL_MS));
    }
    return null;
  }

  // ---------- 3) следене на run-а до completed ----------

  async function pollRunUntilDone(k, runId, myToken) {
    const startedAt = Date.now();
    while (true) {
      if (myToken !== currentDispatchToken) return null;
      if (Date.now() - startedAt > SHORTS_PRO_TIMEOUT_MS) {
        toast("❌ Изтече времето за изчакване — провери Actions таба ръчно.", 8000);
        return null;
      }
      let run;
      try {
        const res = await fetchTimeout(
          `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/runs/${runId}`,
          { headers: authHeaders(k) },
          15000
        );
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        run = await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, SHORTS_PRO_STATUS_POLL_MS));
        continue;
      }
      if (run.status === "completed") {
        if (run.conclusion === "success") {
          toast("✅ Видеото е готово — свалям artifact-а...");
          return await downloadResultZip(k, runId, run);
        }
        toast(`❌ Рендирането се провали (${run.conclusion}) — виж лога: ${run.html_url}`, 10000);
        return { ok: false, run };
      }
      await new Promise((r) => setTimeout(r, SHORTS_PRO_STATUS_POLL_MS));
    }
  }

  // ---------- 4) сваляне на резултата (GitHub Artifact, не git) ----------

  async function downloadResultZip(k, runId, run) {
    let artifacts;
    try {
      const res = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/runs/${runId}/artifacts`,
        { headers: authHeaders(k) },
        15000
      );
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      artifacts = (await res.json()).artifacts || [];
    } catch (e) {
      toast("⚠ Видеото е готово, но не успях да намеря artifact-а автоматично — виж run-а: " + run.html_url, 10000);
      return { ok: true, run, downloaded: false };
    }

    const videoArtifact = artifacts.find((a) => a.name.startsWith("ai-short-") && !a.name.startsWith("ai-short-report-"));
    if (!videoArtifact) {
      toast("⚠ Няма video artifact в този run — виж лога: " + run.html_url, 10000);
      return { ok: true, run, downloaded: false };
    }

    try {
      // Artifact-ите се сервират само с auth хедър (не CORS-friendly публичен
      // URL) — теглим ГИ като .zip (fetch следва redirect-а към временния
      // signed URL автоматично), после предлагаме сваляне на .zip-а. Няма
      // JS zip библиотека в repo-то, затова НЕ разархивираме тук — виж
      // бележката най-горе.
      const zipRes = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/artifacts/${videoArtifact.id}/zip`,
        { headers: authHeaders(k) },
        5 * 60 * 1000
      );
      if (!zipRes.ok) throw new Error(`GitHub ${zipRes.status}`);
      const blob = await zipRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${videoArtifact.name}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast(`✅ Готово! Свален "${videoArtifact.name}.zip" (разархивирай, за да видиш .mp4-то)`, 8000);
      return { ok: true, run, downloaded: true, artifact: videoArtifact, zipUrl: url };
    } catch (e) {
      toast("⚠ Видеото е готово, но свалянето на artifact-а се провали — свали ръчно от: " + run.html_url, 10000);
      return { ok: true, run, downloaded: false };
    }
  }

  return { dispatch };
})();
