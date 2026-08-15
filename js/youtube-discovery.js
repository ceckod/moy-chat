/* =========================================================
   YOUTUBE DISCOVERY ENGINE — Dashboard модул (браузър страна)

   Реалната логика (клъстериране, playlist управление, discovery на нова
   музика, self-track позициониране, freshness/pruning, learning loop)
   живее в scripts/youtube_discovery_engine.py, пуснат от GitHub Actions
   (.github/workflows/youtube-discovery.yml) — този файл САМО:
     1. чете резултатните data/*.json файлове от repo-то (raw.githubusercontent,
        точно като Stats.dataUrl()/fetchData() прави за stats-history.json)
     2. рендира Dashboard таблото
     3. тригва workflow-а ръчно (Run Now / Dry Run / Rebuild) през
        GitHub Actions "workflow_dispatch" API, ползвайки съществуващия
        ghToken (Keys) — същия механизъм като SystemUpdate.upload()
        използва за Contents API
     4. пише data/discovery-config.json обратно (Pause toggle, промяна на
        настройки) — пак през Contents API, PUT с sha на текущата версия

   Зависимости (всички runtime, вътре в методи): Keys, fetchTimeout,
   toast(), Nav.
   ========================================================= */

const YT_DISCOVERY_WORKFLOW_FILE = "youtube-discovery.yml";

const YouTubeDiscovery = {
  _cache: {},
  _lastLoggedRunId: null,

  _rawUrl(filename) {
    const k = Keys.load();
    if (!k.ghOwner || !k.ghRepo) return null;
    const branch = k.ghBranch || "main";
    // no-cache query param — raw.githubusercontent кешира агресивно по CDN,
    // а искаме винаги последния commit след Run Now/Dry Run.
    return `https://raw.githubusercontent.com/${k.ghOwner}/${k.ghRepo}/${branch}/data/${filename}?t=${Date.now()}`;
  },

  async _fetchJson(filename, fallback = null) {
    const url = this._rawUrl(filename);
    if (!url) return fallback;
    try {
      const res = await fetchTimeout(url);
      if (!res.ok) return fallback;
      return await res.json();
    } catch (e) {
      return fallback;
    }
  },

  async loadAll(force = false) {
    if (this._cache.loaded && !force) return this._cache;
    const [catalog, state, log, config] = await Promise.all([
      this._fetchJson("catalog.json", { tracks: [] }),
      this._fetchJson("playlists-state.json", { playlists: [] }),
      this._fetchJson("discovery-log.json", { runs: [] }),
      this._fetchJson("discovery-config.json", {}),
    ]);
    this._cache = { catalog, state, log, config, loaded: true };
    return this._cache;
  },

  // ---------- GitHub Actions trigger (Run Now / Dry Run) ----------
  async _dispatchWorkflow(dryRun) {
    const k = Keys.load();
    if (!k.ghToken) return toast("❌ Липсва GitHub Token — виж Настройки → API Ключове");
    if (!k.ghOwner || !k.ghRepo) return toast("❌ Липсват GitHub owner/repo — виж Настройки → YouTube Тракер");
    const branch = k.ghBranch || "main";
    const label = dryRun ? "Dry Run" : "Run Now";
    AppLog.write("🎧 YouTube Discovery Engine", `▶️ ${label} стартиран от Dashboard-а`);
    try {
      const res = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/workflows/${YT_DISCOVERY_WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ ref: branch, inputs: { dry_run: dryRun ? "true" : "false" } }),
        }, 20000
      );
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
      toast(dryRun ? "🧪 Dry Run стартиран — виж резултата след ~1-2 мин" : "▶️ Run стартиран — виж резултата след ~1-2 мин");
      AppLog.write("🎧 YouTube Discovery Engine", `✅ ${label} успешно тригнат в GitHub Actions`);
      setTimeout(() => this.render(true), 90000);
    } catch (e) {
      toast("❌ " + e.message);
      AppLog.write("🎧 YouTube Discovery Engine", `❌ ${label} неуспешен: ${e.message}`);
    }
  },
  runNow() { this._dispatchWorkflow(false); },
  dryRun() { this._dispatchWorkflow(true); },

  // ---------- Contents API write за playlists-state.json (manual overrides, т.34) ----------
  async _writeState(mutatorFn) {
    const k = Keys.load();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) { toast("❌ Липсва GitHub Token/owner/repo — виж Настройки"); return false; }
    const branch = k.ghBranch || "main";
    const path = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/data/playlists-state.json`;
    try {
      const shaRes = await fetchTimeout(`${path}?ref=${branch}`, { headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json" } });
      if (!shaRes.ok) throw new Error(`Не мога да прочета текущия playlists-state.json (${shaRes.status})`);
      const { sha } = await shaRes.json();
      const { state } = await this.loadAll();
      const updated = mutatorFn(state);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(updated, null, 2) + "\n")));
      const putRes = await fetchTimeout(path, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: "🎧 Discovery Engine: manual override от Dashboard-а", content, sha, branch }),
      }, 20000);
      if (!putRes.ok) throw new Error(`GitHub ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
      return true;
    } catch (e) {
      toast("❌ " + e.message);
      return false;
    }
  },

  async toggleLock(clusterKey) {
    toast("⏳ Записвам...");
    const ok = await this._writeState(state => ({
      ...state,
      playlists: state.playlists.map(p => p.cluster_key === clusterKey ? { ...p, locked: !p.locked } : p),
    }));
    if (ok) { toast("✅ Готово"); this.render(true); }
  },

  async toggleDisabled(clusterKey) {
    toast("⏳ Записвам...");
    const ok = await this._writeState(state => ({
      ...state,
      playlists: state.playlists.map(p => p.cluster_key === clusterKey ? { ...p, disabled: !p.disabled } : p),
    }));
    if (ok) { toast("✅ Готово"); this.render(true); }
  },

  async excludeTrack(clusterKey) {
    this._openTrackPicker(clusterKey, "exclude");
  },

  async forceTrack(clusterKey) {
    this._openTrackPicker(clusterKey, "force");
  },

  // ---------- Song picker модал (замества стария prompt() за Video ID) ----------
  async _openTrackPicker(clusterKey, mode) {
    const { catalog } = await this.loadAll();
    const tracks = [...(catalog.tracks || [])].sort((a, b) => (b.release_date || "").localeCompare(a.release_date || ""));
    if (!tracks.length) { toast("❌ Каталогът е празен — няма песни за избор."); return; }

    const title = mode === "force"
      ? "📌 Избери песен за принудително добавяне (никога не се маха, само се пренарежда)"
      : "🚫 Избери песен за изключване от този playlist";

    const overlay = document.createElement("div");
    overlay.id = "ytdTrackPickerOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";
    overlay.innerHTML = `
      <div class="card" style="max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;">
        <strong>${title}</strong>
        <p class="muted" style="margin:6px 0 0;font-size:12px;">Менюто показва само песните от твоя каталог. За чужда/външна песен постави линк или Video ID:</p>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <input type="text" id="ytdTrackPickerManualUrl" placeholder="https://youtube.com/watch?v=... или само ID" style="flex:1;">
          <button class="btn ghost sm" id="ytdTrackPickerManualBtn">Добави</button>
        </div>
        <input type="text" id="ytdTrackPickerSearch" placeholder="...или търси по заглавие в каталога" style="margin-top:10px;width:100%;">
        <div id="ytdTrackPickerList" style="overflow-y:auto;margin-top:10px;flex:1;min-height:0;"></div>
        <div style="margin-top:10px;display:flex;justify-content:flex-end;">
          <button class="btn ghost sm" id="ytdTrackPickerClose">Отказ</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const extractVideoId = (input) => {
      const s = input.trim();
      const m = s.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
      if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
      return null;
    };
    overlay.querySelector("#ytdTrackPickerManualBtn").onclick = async () => {
      const raw = overlay.querySelector("#ytdTrackPickerManualUrl").value;
      const vid = extractVideoId(raw);
      if (!vid) { toast("❌ Не разпознавам валиден YouTube Video ID/линк"); return; }
      close();
      await this._applyTrackOverride(clusterKey, mode, vid);
    };


    const listEl = overlay.querySelector("#ytdTrackPickerList");
    const searchEl = overlay.querySelector("#ytdTrackPickerSearch");
    const close = () => overlay.remove();
    overlay.querySelector("#ytdTrackPickerClose").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const renderList = (filterText) => {
      const q = (filterText || "").trim().toLowerCase();
      const filtered = q ? tracks.filter(t => (t.title || "").toLowerCase().includes(q) || t.youtube_video_id.toLowerCase().includes(q)) : tracks;
      listEl.innerHTML = filtered.slice(0, 200).map(t => `
        <div class="copy-field" style="padding:8px 10px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;" data-vid="${t.youtube_video_id}">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.title || t.youtube_video_id}</span>
          <span class="muted" style="font-size:11px;white-space:nowrap;">${t.subgenre || t.genre || ""}${t.distribution === "distrokid" ? " · 💿" : ""}</span>
        </div>`).join("") || `<p class="muted">Няма съвпадения.</p>`;
      listEl.querySelectorAll("[data-vid]").forEach(row => {
        row.onclick = async () => {
          close();
          await this._applyTrackOverride(clusterKey, mode, row.getAttribute("data-vid"));
        };
      });
    };
    renderList("");
    searchEl.addEventListener("input", () => renderList(searchEl.value));
  },

  async _applyTrackOverride(clusterKey, mode, videoId) {
    toast("⏳ Записвам...");
    const field = mode === "force" ? "forced_video_ids" : "excluded_video_ids";
    const ok = await this._writeState(state => ({
      ...state,
      playlists: state.playlists.map(p => p.cluster_key === clusterKey
        ? { ...p, [field]: [...new Set([...(p[field] || []), videoId.trim()])] }
        : p),
    }));
    if (ok) {
      toast(mode === "force" ? "✅ Ще бъде добавена (и защитена от махане) при следващия run" : "✅ Добавено в excluded");
      this.render(true);
    }
  },

  async _removeTrackOverride(clusterKey, mode, videoId) {
    toast("⏳ Записвам...");
    const field = mode === "force" ? "forced_video_ids" : "excluded_video_ids";
    const ok = await this._writeState(state => ({
      ...state,
      playlists: state.playlists.map(p => p.cluster_key === clusterKey
        ? { ...p, [field]: (p[field] || []).filter(id => id !== videoId) }
        : p),
    }));
    if (ok) { toast("✅ Премахнато"); this.render(true); this._openManageList(clusterKey, mode); }
  },

  // ---------- Управление на вече force-нати/excluded песни (badge клик) ----------
  async _openManageList(clusterKey, mode) {
    const { catalog, state } = await this.loadAll();
    const byId = Object.fromEntries((catalog.tracks || []).map(t => [t.youtube_video_id, t]));
    const p = (state.playlists || []).find(pl => pl.cluster_key === clusterKey);
    if (!p) return;
    const field = mode === "force" ? "forced_video_ids" : "excluded_video_ids";
    const ids = p[field] || [];
    const title = mode === "force" ? `📌 Force-нати песни за "${p.label}"` : `🚫 Excluded песни за "${p.label}"`;

    document.getElementById("ytdTrackPickerOverlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "ytdTrackPickerOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";
    overlay.innerHTML = `
      <div class="card" style="max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;">
        <strong>${title}</strong>
        <div style="overflow-y:auto;margin-top:10px;flex:1;min-height:0;">
          ${ids.length ? ids.map(vid => `
            <div class="copy-field" style="padding:8px 10px;display:flex;justify-content:space-between;gap:8px;align-items:center;">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${byId[vid]?.title || vid}</span>
              <button class="btn ghost sm" data-remove="${vid}">✕ Премахни</button>
            </div>`).join("") : `<p class="muted">Няма записи.</p>`}
        </div>
        <div style="margin-top:10px;display:flex;justify-content:flex-end;">
          <button class="btn ghost sm" id="ytdTrackPickerClose">Затвори</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#ytdTrackPickerClose").onclick = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelectorAll("[data-remove]").forEach(btn => {
      btn.onclick = () => this._removeTrackOverride(clusterKey, mode, btn.getAttribute("data-remove"));
    });
  },

  // ---------- Contents API write за discovery-config.json (Pause, настройки) ----------
  async _writeConfig(newConfig) {
    const k = Keys.load();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) { toast("❌ Липсва GitHub Token/owner/repo — виж Настройки"); return false; }
    const branch = k.ghBranch || "main";
    const path = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/data/discovery-config.json`;
    try {
      const shaRes = await fetchTimeout(`${path}?ref=${branch}`, { headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json" } });
      const sha = shaRes.ok ? (await shaRes.json()).sha : undefined;
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(newConfig, null, 2) + "\n")));
      const putRes = await fetchTimeout(path, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: "🎧 Discovery Engine: настройки обновени от Dashboard-а", content, sha, branch }),
      }, 20000);
      if (!putRes.ok) throw new Error(`GitHub ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
      return true;
    } catch (e) {
      toast("❌ " + e.message);
      return false;
    }
  },

  async togglePause() {
    const { config } = await this.loadAll();
    const updated = { ...config, paused: !config.paused };
    toast("⏳ Записвам...");
    if (await this._writeConfig(updated)) {
      toast(updated.paused ? "⏸️ Пауза включена" : "▶️ Пауза изключена");
      this.render(true);
    }
  },

  async saveSettingsFromForm() {
    const { config } = await this.loadAll();
    const num = (id) => parseFloat(document.getElementById(id)?.value);
    const bool = (id) => document.getElementById(id)?.checked ?? true;
    const updated = {
      ...config,
      self_track_ratio_min: num("dsc_ratio_min"),
      self_track_ratio_max: num("dsc_ratio_max"),
      min_external_between_self: num("dsc_min_distance"),
      min_cluster_size: num("dsc_min_cluster"),
      max_playlists: num("dsc_max_playlists"),
      max_playlist_size: num("dsc_max_size"),
      min_playlist_size: num("dsc_min_size"),
      max_track_age_days: num("dsc_max_age"),
      fresh_track_target_days: num("dsc_fresh_target"),
      candidate_cache_ttl_days: num("dsc_cache_ttl"),
      min_candidate_pool: num("dsc_min_pool"),
      cross_playlist_similarity_threshold: num("dsc_cross_threshold"),
      max_track_duration_seconds: num("dsc_max_duration"),
      min_track_duration_seconds: num("dsc_min_duration"),
      enable_external_discovery: bool("dsc_enable_discovery"),
      enable_auto_playlist_creation: bool("dsc_enable_creation"),
      enable_auto_reorder: bool("dsc_enable_reorder"),
      enable_auto_removal_of_external_tracks: bool("dsc_enable_removal"),
    };
    toast("⏳ Записвам настройки...");
    if (await this._writeConfig(updated)) { toast("✅ Настройките са запазени"); this.render(true); }
  },

  // ---------- Rebuild (per-playlist): нулира candidate cache и тригва run ----------
  async rebuildPlaylist(clusterKey) {
    const { state } = await this.loadAll();
    const pl = state.playlists.find(p => p.cluster_key === clusterKey);
    if (!pl) return;
    if (!confirm(`Опресни кандидатите за "${pl.label}" при следващия run?`)) return;
    const k = Keys.load();
    const branch = k.ghBranch || "main";
    const path = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/data/playlists-state.json`;
    try {
      const shaRes = await fetchTimeout(`${path}?ref=${branch}`, { headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json" } });
      const sha = shaRes.ok ? (await shaRes.json()).sha : undefined;
      const updatedState = { ...state, playlists: state.playlists.map(p => p.cluster_key === clusterKey ? { ...p, last_candidate_search_at: null } : p) };
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(updatedState, null, 2) + "\n")));
      await fetchTimeout(path, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: `🎧 Rebuild заявка за "${pl.label}"`, content, sha, branch }),
      }, 20000);
      toast("✅ Ще опресни кандидатите — пусни 'Run Now' или изчакай следващия daily run");
      this._dispatchWorkflow(false);
    } catch (e) {
      toast("❌ " + e.message);
    }
  },

  // ---------- RENDER ----------
  async render(force = false) {
    const el = document.getElementById("ytDiscoveryOut");
    if (!el) return;
    el.innerHTML = `<p class="muted">⏳ Зареждам данни от GitHub...</p>`;
    const { catalog, state, log, config } = await this.loadAll(force);

    if (!Keys.load().ghOwner || !Keys.load().ghRepo) {
      el.innerHTML = `<div class="card muted">Настрой GitHub repo (owner/repo/branch) в <strong>Настройки → YouTube Тракер</strong> — Discovery Engine чете същия repo.</div>`;
      return;
    }

    const runs = log.runs || [];
    const lastRun = runs.length ? runs[runs.length - 1] : null;
    if (lastRun && lastRun.run_id && lastRun.run_id !== this._lastLoggedRunId) {
      this._lastLoggedRunId = lastRun.run_id;
      const summary = lastRun.no_changes
        ? "✅ NO CHANGES"
        : `Добавени: ${lastRun.tracks_added ?? 0} · Премахнати: ${lastRun.tracks_removed ?? 0} · Пренаредени: ${lastRun.tracks_reordered ?? 0} · Нови playlist-и: ${lastRun.playlists_created ?? 0}`;
      AppLog.write("🎧 YouTube Discovery Engine",
        `Run #${lastRun.run_id} (${lastRun.dry_run ? "dry run" : "реален"}) — ${summary}` +
        `${(lastRun.errors || []).length ? ` — ⚠️ ${lastRun.errors.length} грешки` : ""}` +
        `${(lastRun.warnings || []).length ? ` — ⚠️ ${lastRun.warnings.length} предупреждения` : ""}`);
    }
    const playlists = state.playlists || [];
    const activePlaylists = playlists.filter(p => !p.archived);
    const totalMine = activePlaylists.reduce((s, p) => s + p.tracks.filter(t => t.is_mine).length, 0);
    const totalExternal = activePlaylists.reduce((s, p) => s + p.tracks.filter(t => !t.is_mine).length, 0);

    el.innerHTML = `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Активни Playlist-и</div><div class="value">${activePlaylists.length}</div></div>
        <div class="kpi"><div class="label">Мои / Външни песни</div><div class="value" style="font-size:18px;">${totalMine} / ${totalExternal}</div></div>
        <div class="kpi"><div class="label">Последен run</div><div class="value" style="font-size:13px;">${lastRun ? new Date(lastRun.started_at).toLocaleString("bg-BG") : "—"}</div></div>
        <div class="kpi"><div class="label">Статус</div><div class="value" style="font-size:14px;">${config.paused ? "⏸️ На пауза" : "🟢 Активен"}</div></div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn grad" onclick="YouTubeDiscovery.runNow()">▶️ Run Now</button>
          <button class="btn ghost" onclick="YouTubeDiscovery.dryRun()">🧪 Dry Run</button>
          <button class="btn ghost" onclick="YouTubeDiscovery.togglePause()">${config.paused ? "▶️ Resume" : "⏸️ Pause"}</button>
          <button class="btn ghost" onclick="YouTubeDiscovery.render(true)">🔄 Refresh</button>
        </div>
        ${lastRun ? `<p class="muted" style="margin-top:10px;">Run #${lastRun.run_id || "—"} · ${lastRun.dry_run ? "🧪 dry run" : "реален"} ·
          ${lastRun.no_changes ? "✅ NO CHANGES" : `Добавени: ${lastRun.tracks_added ?? 0} · Премахнати: ${lastRun.tracks_removed ?? 0} · Пренаредени: ${lastRun.tracks_reordered ?? 0} · Нови playlist-и: ${lastRun.playlists_created ?? 0}`} ·
          Нови мои песни: ${lastRun.new_own_tracks ?? 0} · Search заявки: ${lastRun.candidate_searches ?? 0} · Quota: ~${lastRun.quota_spent_units ?? 0} units
          ${(lastRun.errors || []).length ? ` · ⚠️ ${lastRun.errors.length} грешки` : ""}${(lastRun.warnings || []).length ? ` · ⚠️ ${lastRun.warnings.length} предупреждения` : ""}</p>
          ${(lastRun.warnings || []).length ? `<div class="muted" style="margin-top:6px;font-size:12px;">${lastRun.warnings.map(w => `⚠️ ${w}`).join("<br>")}</div>` : ""}` :
          `<p class="muted" style="margin-top:10px;">Все още няма запис за run — пусни "Run Now" или изчакай daily cron-а (11:00 UTC).</p>`}
      </div>

      <div class="section-title" style="margin-top:20px;">Playlist-и</div>
      ${activePlaylists.length ? activePlaylists.map(p => this._playlistCard(p)).join("") : `<div class="card muted">Още няма създадени playlist-и — трябват поне ${config.min_cluster_size || 6} песни в един стил в каталога. Каталог: ${catalog.tracks?.length || 0} класифицирани песни.</div>`}

      <div class="section-title" style="margin-top:20px;">Настройки</div>
      <div class="card">
        <div class="grid cols-2">
          <div><label>Self-track ratio мин.</label><input type="number" step="0.01" id="dsc_ratio_min" value="${config.self_track_ratio_min ?? 0.10}"></div>
          <div><label>Self-track ratio макс.</label><input type="number" step="0.01" id="dsc_ratio_max" value="${config.self_track_ratio_max ?? 0.20}"></div>
          <div><label>Мин. дистанция между мои песни</label><input type="number" id="dsc_min_distance" value="${config.min_external_between_self ?? 3}"></div>
          <div><label>Мин. размер на клъстер</label><input type="number" id="dsc_min_cluster" value="${config.min_cluster_size ?? 6}"></div>
          <div><label>Макс. брой playlist-и</label><input type="number" id="dsc_max_playlists" value="${config.max_playlists ?? 12}"></div>
          <div><label>Макс. размер на playlist</label><input type="number" id="dsc_max_size" value="${config.max_playlist_size ?? 60}"></div>
          <div><label>Мин. размер на playlist</label><input type="number" id="dsc_min_size" value="${config.min_playlist_size ?? 15}"></div>
          <div><label>Макс. възраст на песен (дни)</label><input type="number" id="dsc_max_age" value="${config.max_track_age_days ?? 540}"></div>
          <div><label>Freshness target (дни)</label><input type="number" id="dsc_fresh_target" value="${config.fresh_track_target_days ?? 90}"></div>
          <div><label>Candidate cache TTL (дни)</label><input type="number" id="dsc_cache_ttl" value="${config.candidate_cache_ttl_days ?? 5}"></div>
          <div><label>Мин. candidate pool</label><input type="number" id="dsc_min_pool" value="${config.min_candidate_pool ?? 8}"></div>
          <div><label>Cross-playlist similarity threshold</label><input type="number" step="0.05" id="dsc_cross_threshold" value="${config.cross_playlist_similarity_threshold ?? 0.5}"></div>
          <div><label>Макс. дължина на песен (сек.) — филтрира компилации/mix-ове</label><input type="number" id="dsc_max_duration" value="${config.max_track_duration_seconds ?? 720}"></div>
          <div><label>Мин. дължина на песен (сек.) — филтрира Shorts/teaser клипове</label><input type="number" id="dsc_min_duration" value="${config.min_track_duration_seconds ?? 60}"></div>
        </div>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">
          <label><input type="checkbox" id="dsc_enable_discovery" ${config.enable_external_discovery !== false ? "checked" : ""}> Enable External Discovery (search.list)</label>
          <label><input type="checkbox" id="dsc_enable_creation" ${config.enable_auto_playlist_creation !== false ? "checked" : ""}> Enable Auto Playlist Creation</label>
          <label><input type="checkbox" id="dsc_enable_reorder" ${config.enable_auto_reorder !== false ? "checked" : ""}> Enable Auto Reorder</label>
          <label><input type="checkbox" id="dsc_enable_removal" ${config.enable_auto_removal_of_external_tracks !== false ? "checked" : ""}> Enable Auto Removal (external tracks)</label>
        </div>
        <button class="btn grad" style="margin-top:14px;" onclick="YouTubeDiscovery.saveSettingsFromForm()">💾 Запази настройки</button>
      </div>`;
  },

  _playlistCard(p) {
    const mine = p.tracks.filter(t => t.is_mine).length;
    const ext = p.tracks.filter(t => !t.is_mine).length;
    const recent = [...p.tracks].slice(-5).reverse();
    const badges = [
      p.locked ? `<span class="badge">🔒 Locked</span>` : "",
      p.disabled ? `<span class="badge">⏸️ Disabled</span>` : "",
      (p.excluded_video_ids || []).length ? `<span class="badge" style="cursor:pointer;" onclick="YouTubeDiscovery._openManageList('${p.cluster_key}','exclude')">🚫 ${p.excluded_video_ids.length} excluded</span>` : "",
      (p.forced_video_ids || []).length ? `<span class="badge" style="cursor:pointer;" onclick="YouTubeDiscovery._openManageList('${p.cluster_key}','force')">📌 ${p.forced_video_ids.length} forced</span>` : "",
    ].filter(Boolean).join(" ");
    return `<div class="card" style="margin-bottom:12px;">
      <strong>${p.label}</strong> <span class="muted">· ${p.tracks.length} песни (${mine} мои / ${ext} външни) · обновен ${p.last_updated ? new Date(p.last_updated).toLocaleDateString("bg-BG") : "—"}</span>
      ${badges ? `<div style="margin-top:6px;">${badges}</div>` : ""}
      ${p.youtube_playlist_id && p.youtube_playlist_id !== "DRY_RUN_PENDING" ? `<br><a href="https://www.youtube.com/playlist?list=${p.youtube_playlist_id}" target="_blank" rel="noopener">Отвори в YouTube →</a>` : ""}
      <div style="margin-top:8px;">
        ${recent.map(t => `<div class="copy-field" style="padding:6px 10px;"><span>${t.is_mine ? "⭐" : "🎵"} ${t.title || t.youtube_video_id}</span></div>`).join("")}
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn ghost sm" onclick="YouTubeDiscovery.rebuildPlaylist('${p.cluster_key}')">🔁 Rebuild</button>
        <button class="btn ghost sm" onclick="YouTubeDiscovery.toggleLock('${p.cluster_key}')">${p.locked ? "🔓 Unlock" : "🔒 Lock"}</button>
        <button class="btn ghost sm" onclick="YouTubeDiscovery.toggleDisabled('${p.cluster_key}')">${p.disabled ? "▶️ Enable" : "⏸️ Disable"}</button>
        <button class="btn ghost sm" onclick="YouTubeDiscovery.excludeTrack('${p.cluster_key}')">🚫 Exclude track</button>
        <button class="btn ghost sm" onclick="YouTubeDiscovery.forceTrack('${p.cluster_key}')">📌 Force track</button>
      </div>
    </div>`;
  },
};
