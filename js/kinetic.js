/* Kinetic Video — качваш песен + снимки в сайта, GitHub Actions рендира, виждаш резултата тук.
   Поток: Release (tag kinetic-job-<id>) ← audio + снимки + scenario.json → workflow dispatch →
   проверка на run-а + на release asset result.mp4. Нужен е workflow .github/workflows/kinetic-video.yml */
const Kinetic = (() => {
  const WF = "kinetic-video.yml", POLL_MS = 6000, TIMEOUT_MS = 20 * 60 * 1000;
  let audio = null, music = null, rows = [], timer = null, t0 = 0, jobId = null;
  const $ = (id) => document.getElementById(id);
  const cfg = () => { try { return Keys.load() || {}; } catch (e) { return {}; } };
  const note = (m) => { if (typeof toast === "function") toast(m, 5000); };
  const hdr = (k, w) => ({ Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json", ...(w ? { "Content-Type": "application/json" } : {}) });
  const api = (k, p) => `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/${p}`;
  const ext = (f, d) => ((f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || d).toLowerCase();
  function log(m) { const e = $("kineticStatus"); if (e) { e.style.display = "block"; e.textContent = m; } if (typeof AppLog !== "undefined") AppLog.write("🎬 Kinetic", m); }
  async function j(url, o) { const r = await fetch(url, o); if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json(); }

  function init() {
    if (!$("kineticAudio")) return;
    $("kineticAudio").onchange = (e) => { audio = e.target.files[0] || null; music = null; $("kineticAudioName").textContent = audio ? audio.name : ""; btn(); if (audio) listen(); };
    $("kineticImages").onchange = (e) => { [...e.target.files].forEach((f, i) => { rows[i] = rows[i] || { text: "", effect: "", prompt: "" }; rows[i].file = f; }); render(); btn(); };
    refreshAgents();
  }
  const btn = () => { const b = $("kineticGoBtn"); if (b) b.disabled = !(audio && rows.some((r) => r.file)); };
  const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function render() {
    $("kineticScenes").innerHTML = rows.length ? rows.map((r, i) => `<div style="display:flex;gap:8px;align-items:center;margin:6px 0;">
      ${r.file ? `<img src="${URL.createObjectURL(r.file)}" style="width:44px;height:78px;object-fit:cover;border-radius:6px;">` : `<div style="width:44px;height:78px;border:1px dashed var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;" class="muted">няма</div>`}
      <b>${i + 1}</b><input style="flex:1;min-width:0" maxlength="30" placeholder="1-3 думи" value="${esc(r.text)}" oninput="Kinetic.setText(${i},this.value)">
      <select onchange="Kinetic.setEffect(${i},this.value)"><option value="">авто</option>${["slam", "glitch", "stretch", "zoom", "slide"].map((x) => `<option ${r.effect === x ? "selected" : ""}>${x}</option>`).join("")}</select>
      ${r.prompt ? `<button class="btn ghost sm" title="Копирай промпта за снимката" onclick="Kinetic.copyPrompt(${i})">📋</button>` : ""}</div>`).join("") : '<span class="muted">Още няма сцени — питай агентите или качи снимки.</span>';
  }

  // ---------- Анализ на песента (в браузъра) ----------
  async function analyze(file, maxSec) {
    const AC = window.AudioContext || window.webkitAudioContext, ctx = new AC();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer()); if (ctx.close) ctx.close();
    const sr = buf.sampleRate, ch = buf.getChannelData(0), dur = Math.min(buf.duration, maxSec), hop = Math.round(sr * 0.01), n = Math.floor(dur * sr / hop);
    const rms = new Float32Array(n), on = new Float32Array(n);
    for (let i = 0; i < n; i++) { let t = 0; const o = i * hop; for (let j = 0; j < hop; j += 2) { const v = ch[o + j] || 0; t += v * v; } rms[i] = Math.sqrt(t / (hop / 2)); }
    for (let i = 1; i < n; i++) on[i] = Math.max(rms[i] - rms[i - 1], 0);
    let best = 0, bpm = 120;
    for (let b = 70; b <= 180; b++) { const lag = Math.round(6000 / b); let t = 0; for (let i = lag; i < n; i++) t += on[i] * on[i - lag]; if (t > best) { best = t; bpm = b; } }
    while (bpm < 80) bpm *= 2; while (bpm > 160) bpm /= 2;
    const segN = Math.max(1, Math.round(dur / 4)), per = Math.floor(n / segN), en = [];
    for (let i = 0; i < segN; i++) { let t = 0; for (let j = i * per; j < (i + 1) * per; j++) t += rms[j]; en.push(t / per); }
    const sorted = [...en].sort((x, y) => x - y), lo = sorted[Math.floor(sorted.length / 3)], hi = sorted[Math.floor(sorted.length * 2 / 3)];
    const lvl = en.map((e) => (e <= lo ? "спокойно" : e >= hi ? "интензивно" : "средно")), parts = [];
    lvl.forEach((l, i) => { const t0 = Math.round(i * dur / segN), t1 = Math.round((i + 1) * dur / segN); if (parts.length && parts[parts.length - 1].l === l) parts[parts.length - 1].t1 = t1; else parts.push({ l, t0, t1 }); });
    let drop = null, jump = 0; for (let i = 1; i < en.length; i++) if (en[i] - en[i - 1] > jump) { jump = en[i] - en[i - 1]; drop = i; }
    const beat = 60 / bpm; let len = beat * (bpm < 90 ? 2 : 4); while (len < 1.1) len *= 2; while (len > 3) len /= 2;
    return { dur, bpm: Math.round(bpm), len, count: Math.min(24, Math.max(4, Math.round(dur / len))), sections: parts.map((p) => `${p.t0}-${p.t1}с ${p.l}`).join(", "), drop: drop && jump > (hi || 0) * 0.3 ? Math.round(drop * dur / segN) : null };
  }
  async function listen() {
    const st = $("kineticMusic"); st.style.display = "block"; st.textContent = "🎧 Слушам песента…";
    try {
      music = await analyze(audio, +$("kineticSecs").value || 30);
      $("kineticCount").value = music.count; $("kineticSecs").value = Math.min(Math.ceil(music.dur), 60);
      st.textContent = `🎵 ${Math.round(music.dur)} сек · ~${music.bpm} BPM · ${music.sections}${music.drop ? ` · силен момент ~${music.drop}с` : ""}\n➡️ Препоръчвам ${music.count} сцени (смяна на ~${music.len.toFixed(1)} сек).`;
      if ($("kineticGemini") && $("kineticGemini").checked && typeof callGeminiMultimodal === "function" && audio.size < 15e6) {
        st.textContent += "\n🎧 Gemini слуша за настроение…";
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(audio); });
        music.mood = String(await callGeminiMultimodal("Опиши в 2 кратки изречения настроението, жанра и енергията на тази песен. Без списъци.", b64, audio.type || "audio/mpeg")).slice(0, 400);
        st.textContent += "\n💬 " + music.mood;
      }
    } catch (e) { st.textContent = "⚠ Не успях да анализирам песента (" + e.message + "). Задай броя сцени на ръка."; }
  }

  // ---------- AI агентите ----------
  function refreshAgents() {
    const box = $("kineticAgents"); if (!box || typeof AgentRegistry === "undefined") return;
    let av = []; try { av = AgentRegistry.available().filter((a) => a.capabilities && a.capabilities.text); } catch (e) {}
    box.innerHTML = av.length ? av.map((a) => `<label style="display:inline-flex;gap:4px;margin:3px 10px 3px 0;"><input type="checkbox" class="kAgent" value="${a.id}" ${av.length < 3 || ["claude", "gemini"].includes(a.id) ? "checked" : ""}> ${a.icon || ""} ${a.name}</label>`).join("") : '<span class="muted">Няма агенти с ключ (Настройки → API Ключове).</span>';
  }
  function buildPrompt() {
    const n = $("kineticCount").value, lang = $("kineticLang").value;
    return `Ти си режисьор на кинетични вертикални видеа (TikTok/Reels/Shorts), в които силни думи изскачат в такт с музиката върху снимки.
Тема/идея: ${$("kineticIdea").value.trim()}
${music ? `МУЗИКА (анализирана): ${Math.round(music.dur)} сек, ~${music.bpm} BPM. Енергия по части: ${music.sections}.${music.drop ? ` Най-силният момент е около ${music.drop}-тата секунда.` : ""}${music.mood ? ` Настроение: ${music.mood}` : ""}\nСмяната на сцените ще е на бийт — приблизително на всеки ${music.len.toFixed(1)} сек. Следвай енергията: спокойните части = по-малко и по-тихи думи, ефекти slide/zoom; интензивните и силния момент = резки думи и ефекти slam/glitch/stretch. Последната сцена да е силно затваряне.` : ""}
Направи точно ${n} сцени. За всяка сцена:
- "text": 1-3 думи, ГЛАВНИ БУКВИ, на ${lang}, силни и кратки (като заглавия, не изречения);
- "effect": един от slam, glitch, stretch, zoom, slide — редувай ги;
- "image_prompt": подробен промпт НА АНГЛИЙСКИ за снимка 9:16, кинематографична, контрастна, БЕЗ текст в кадъра, с обща визуална идея и цветова гама за целия клип.
Избери и "style" от: slam_red, glitch, stretch, zoom_punch, clean.
Върни САМО валиден JSON, без обяснения и без markdown: {"style":"...","scenes":[{"text":"","effect":"","image_prompt":""}]}`;
  }
  const parsePlan = (t) => { const m = String(t).match(/\{[\s\S]*\}/); const d = JSON.parse(m ? m[0] : t); if (!Array.isArray(d.scenes) || !d.scenes.length) throw new Error("няма scenes"); return d; };
  let plans = {};
  async function askAgents() {
    if (!$("kineticIdea").value.trim()) return note("❌ Напиши идея за видеото");
    const ids = [...document.querySelectorAll(".kAgent:checked")].map((x) => x.value);
    if (!ids.length) return note("❌ Избери поне един агент");
    const out = $("kineticAgentOut"), prompt = buildPrompt(); plans = {}; $("kineticAskBtn").disabled = true;
    out.innerHTML = ids.map((id) => `<div class="card" id="kp-${id}" style="margin:8px 0;"><b>${AgentRegistry.get(id).icon || ""} ${AgentRegistry.get(id).name}</b> <span class="muted">⏳ мисли…</span></div>`).join("");
    await Promise.all(ids.map(async (id) => {
      const el = $("kp-" + id), ag = AgentRegistry.get(id);
      try {
        const r = await ag.send(prompt, []); const d = parsePlan(r.text); plans[id] = d;
        el.innerHTML = `<b>${ag.icon || ""} ${ag.name}</b> <span class="muted">· ${d.scenes.length} сцени · ${esc(d.style || "")}</span>
          <div style="margin:6px 0;font-size:13px;">${d.scenes.map((s) => esc(s.text)).join(" · ")}</div>
          <button class="btn grad sm" onclick="Kinetic.usePlan('${id}')">✅ Използвай този сценарий</button>`;
      } catch (e) { el.innerHTML = `<b>${ag.name}</b> <span class="muted">❌ ${esc(e.message).slice(0, 120)}</span>`; }
    }));
    $("kineticAskBtn").disabled = false;
  }
  function usePlan(id) {
    const d = plans[id]; if (!d) return;
    if (d.style && [...$("kineticStyle").options].some((o) => o.value === d.style)) $("kineticStyle").value = d.style;
    d.scenes.forEach((s, i) => { rows[i] = rows[i] || {}; Object.assign(rows[i], { text: String(s.text || "").slice(0, 30), effect: ["slam", "glitch", "stretch", "zoom", "slide"].includes(s.effect) ? s.effect : "", prompt: s.image_prompt || "" }); });
    render(); btn();
    $("kineticPrompts").innerHTML = `<div class="muted" style="margin:8px 0 4px;">📋 Промптове за снимките (генерирай ги по ред и ги качи горе):</div><button class="btn ghost sm" onclick="Kinetic.copyAll()">Копирай всички промпти</button>`;
    note("✅ Сценарият е приложен — виж сцените долу, после качи снимките по ред");
  }
  const copy = (t) => navigator.clipboard.writeText(t).then(() => note("📋 Копирано"), () => prompt("Копирай:", t));
  const copyAll = () => copy(rows.map((r, i) => `${i + 1}. ${r.prompt || ""}`).join("\n\n"));
  function applyJson() {
    try { const d = JSON.parse($("kineticJson").value); const id = "_manual"; plans[id] = Array.isArray(d) ? { scenes: d.map((x) => (typeof x === "string" ? { text: x } : x)) } : d; usePlan(id); }
    catch (e) { note("❌ Невалиден JSON: " + e.message); }
  }

  async function up(k, rel, name, file, type) {
    const url = rel.upload_url.replace(/\{.*\}$/, "") + "?name=" + encodeURIComponent(name);
    const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + k.ghToken, Accept: "application/vnd.github+json", "Content-Type": type || "application/octet-stream" }, body: file });
    if (!r.ok) throw new Error(`upload ${name}: ${r.status} ${(await r.text()).slice(0, 150)}`);
  }

  async function start() {
    const k = cfg();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) return note("❌ Липсва GitHub Token/owner/repo (Настройки → API Ключове)");
    jobId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8);
    const tag = "kinetic-job-" + jobId; $("kineticGoBtn").disabled = true; $("kineticResult").innerHTML = "";
    try {
      log("⏳ Създавам job в GitHub…");
      const rel = await j(api(k, "releases"), { method: "POST", headers: hdr(k, true), body: JSON.stringify({ tag_name: tag, target_commitish: k.ghBranch || "main", name: "🎬 Kinetic " + jobId, body: "Автоматичен job от Kinetic Video.", prerelease: true }) });
      const aname = "audio." + ext(audio, "mp3");
      log(`⏳ Качвам песента (${(audio.size / 1048576).toFixed(1)}MB)…`); await up(k, rel, aname, audio, audio.type);
      const scenes = [], use = rows.filter((r) => r.file || (r.text || "").trim());
      for (let i = 0; i < use.length; i++) {
        const r = use[i], sc1 = { text: r.text || "WOW", ...(r.effect ? { effect: r.effect } : {}) };
        if (r.file) { const n = `${i + 1}.${ext(r.file, "jpg")}`; log(`⏳ Качвам снимка ${i + 1}/${use.length}…`); await up(k, rel, n, r.file, r.file.type); sc1.image = n; }
        scenes.push(sc1);
      }
      const sc = { style: $("kineticStyle").value, audio: aname, max_seconds: +$("kineticSecs").value || 30, scenes };
      await up(k, rel, "scenario.json", new Blob([JSON.stringify(sc)], { type: "application/json" }), "application/json");
      log("▶️ Пускам рендера в GitHub Actions…");
      const d = await fetch(api(k, `actions/workflows/${WF}/dispatches`), { method: "POST", headers: hdr(k, true), body: JSON.stringify({ ref: k.ghBranch || "main", inputs: { job_id: jobId, size: $("kineticSize").value } }) });
      if (!d.ok) throw new Error(`Workflow: ${d.status} ${(await d.text()).slice(0, 200)} — качен ли е .github/workflows/${WF}?`);
      t0 = Date.now(); poll(k, tag);
    } catch (e) { log("❌ " + e.message); $("kineticGoBtn").disabled = false; }
  }

  async function poll(k, tag) {
    clearTimeout(timer);
    const sec = Math.round((Date.now() - t0) / 1000), left = () => { timer = setTimeout(() => poll(k, tag), POLL_MS); };
    if (Date.now() - t0 > TIMEOUT_MS) { log("❌ Изтече времето (20 мин). Виж Actions таба в GitHub."); $("kineticGoBtn").disabled = false; return; }
    try {
      const rel = await j(api(k, "releases/tags/" + tag), { headers: hdr(k) });
      const res = rel.assets.find((a) => a.name === "result.mp4"), err = rel.assets.find((a) => a.name === "error.txt");
      if (res) return done(k, res, rel);
      if (err) { const t = await (await fetch(err.browser_download_url)).text().catch(() => ""); log("❌ Рендерът се провали:\n" + t.slice(-600)); $("kineticGoBtn").disabled = false; return; }
      let st = "чака ред";
      try { const runs = await j(api(k, `actions/workflows/${WF}/runs?event=workflow_dispatch&per_page=10`), { headers: hdr(k) });
        const r = runs.workflow_runs.find((x) => (x.display_title || x.name || "").includes(jobId));
        if (r) st = r.status === "in_progress" ? "рендира (анализ на бийтове + кадри)" : r.status === "completed" ? "приключи: " + r.conclusion : "стартира"; } catch (e) {}
      log(`⏳ ${st} · ${sec} сек (обикновено 2-5 мин)`);
    } catch (e) { log(`⏳ чакам… ${sec} сек`); }
    left();
  }

  async function done(k, asset, rel) {
    log("✅ Готово! Свалям видеото…");
    const link = `<a class="btn grad sm" href="${asset.browser_download_url}" target="_blank" rel="noopener">⬇️ Свали MP4</a>`;
    try {
      const r = await fetch(api(k, "releases/assets/" + asset.id), { headers: { ...hdr(k), Accept: "application/octet-stream" } });
      if (!r.ok) throw new Error(r.status);
      const url = URL.createObjectURL(await r.blob());
      $("kineticResult").innerHTML = `<video src="${url}" controls playsinline style="width:100%;max-width:360px;border-radius:10px;"></video><div style="margin-top:8px"><a class="btn grad sm" href="${url}" download="kinetic-${jobId}.mp4">⬇️ Свали MP4</a></div>`;
    } catch (e) { $("kineticResult").innerHTML = link; }
    log("✅ Видеото е готово.");
    $("kineticGoBtn").disabled = false;
  }

  return { init, start, applyJson, askAgents, usePlan, copyAll, refreshAgents, copyPrompt: (i) => copy(rows[i].prompt), setText: (i, v) => { rows[i].text = v; }, setEffect: (i, v) => { rows[i].effect = v; } };
})();
document.addEventListener("DOMContentLoaded", () => Kinetic.init());
