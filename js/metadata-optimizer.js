/* =========================================================
   METADATA OPTIMIZER — Dashboard модул (браузър страна)

   Реалната логика (AI генериране на title/description/tags, прилагане
   през YouTube videos.update) живее в scripts/metadata_optimizer.py,
   пуснат от GitHub Actions (.github/workflows/metadata-optimizer.yml).
   Този файл САМО:
     1. чете data/catalog.json + data/metadata-suggestions.json (raw.
        githubusercontent — преизползва YouTubeDiscovery._rawUrl(), СЪЩИЯТ
        repo config, за да не дублираме owner/repo/branch логика)
     2. рендира песен-picker + списък с pending/approved/applied предложения
     3. тригва workflow-а (generate/apply) през workflow_dispatch API
     4. пише data/metadata-suggestions.json обратно за Approve/Reject
        (Contents API, PUT със sha на текущата версия — same pattern
        като YouTubeDiscovery._writeState)

   Зависимости (runtime): Keys, fetchTimeout, toast(), YouTubeDiscovery
   (за _rawUrl/_fetchJson реизползване — зареден ПРЕДИ този файл в index.html).
   ========================================================= */

const METADATA_OPTIMIZER_WORKFLOW_FILE = "metadata-optimizer.yml";

const MetadataOptimizer = {
  _cache: {},

  async loadAll(force = false) {
    if (this._cache.loaded && !force) return this._cache;
    const [catalog, suggestions] = await Promise.all([
      YouTubeDiscovery._fetchJson("catalog.json", { tracks: [] }),
      YouTubeDiscovery._fetchJson("metadata-suggestions.json", { items: {} }),
    ]);
    this._cache = { catalog, suggestions, loaded: true };
    return this._cache;
  },

  async render(force = false) {
    const out = document.getElementById("metadataOptimizerOut");
    if (!out) return;
    out.innerHTML = `<p class="muted">⏳ Зареждам...</p>`;
    const { catalog, suggestions } = await this.loadAll(force);
    const items = Object.values(suggestions.items || {}).sort(
      (a, b) => (b.generated_at || "").localeCompare(a.generated_at || "")
    );
    const byId = Object.fromEntries((catalog.tracks || []).map(t => [t.youtube_video_id, t]));
    const resolvedCount = items.filter(i => i.status === "applied" || i.status === "rejected").length;

    const rows = items.map(item => {
      const track = byId[item.video_id];
      const statusBadge = {
        pending: `<span class="badge">⏳ pending</span>`,
        approved: `<span class="badge" style="background:#2a6;">✅ approved</span>`,
        applied: `<span class="badge" style="background:#268;">🚀 applied</span>`,
        rejected: `<span class="badge muted">🚫 rejected</span>`,
        failed: `<span class="badge" style="background:#a33;">❌ failed</span>`,
      }[item.status] || item.status;

      const titlesHtml = (item.suggested_titles || []).map((t, i) => `
        <div class="copy-field" style="padding:6px 8px;margin-top:4px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="radio" name="title-${item.video_id}" value="${i}" ${i === 0 ? "checked" : ""}>
            <span>${t}</span>
          </label>
        </div>`).join("");

      return `
        <div class="card" style="margin-top:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <strong>${track?.title || item.video_id}</strong>
            <span style="display:flex;align-items:center;gap:6px;">${statusBadge}
              <button class="btn ghost sm" title="Изтрий този запис" onclick="MetadataOptimizer.remove('${item.video_id}')">🗑️</button>
            </span>
          </div>
          <p class="muted" style="margin-top:4px;font-size:12px;">Текущо заглавие: ${item.current_title}</p>
          <p class="muted" style="font-size:12px;">Предложени заглавия (избери едно):</p>
          ${titlesHtml}
          <details style="margin-top:8px;">
            <summary class="muted" style="cursor:pointer;font-size:12px;">Описание + tags</summary>
            <p style="font-size:12px;white-space:pre-wrap;margin-top:6px;">${item.suggested_description || ""}</p>
            <p class="muted" style="font-size:11px;margin-top:6px;">${(item.suggested_tags || []).join(", ")}</p>
          </details>
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
            ${item.status === "pending" ? `
              <button class="btn sm" onclick="MetadataOptimizer.approve('${item.video_id}', this)">✅ Одобри</button>
              <button class="btn ghost sm" onclick="MetadataOptimizer.reject('${item.video_id}')">🚫 Отхвърли</button>
            ` : ""}
            ${item.status === "approved" ? `
              <button class="btn sm" onclick="MetadataOptimizer.apply('${item.video_id}')">🚀 Приложи в YouTube</button>
              <button class="btn ghost sm" onclick="MetadataOptimizer.reject('${item.video_id}')">🚫 Отхвърли</button>
            ` : ""}
            ${item.status === "applied" ? `<span class="muted" style="font-size:11px;">Приложено: ${(item.applied_at || "").slice(0, 16).replace("T", " ")}</span>` : ""}
            ${item.status === "failed" ? `<span style="font-size:11px;color:#c55;">${item.failed_reason && item.failed_reason.includes("HTTP 403") ? "YouTube отказа промяната (вероятно CMS/дистрибуторско съдържание — DistroKid и т.н., не се управлява през личен OAuth)." : (item.failed_reason || "Грешка при прилагане.")}</span>` : ""}
          </div>
        </div>`;
    }).join("");

    out.innerHTML = `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <button class="btn" onclick="MetadataOptimizer.openGeneratePicker()">➕ Генерирай предложение за песен</button>
        ${resolvedCount ? `<button class="btn ghost sm" onclick="MetadataOptimizer.cleanupResolved()">🧹 Изчисти приложени/отхвърлени (${resolvedCount})</button>` : ""}
      </div>
      ${rows || `<p class="muted" style="margin-top:10px;">Няма предложения още.</p>`}
    `;
  },

  // ---------- Генериране: избери песен от каталога, тригни workflow ----------
  async openGeneratePicker() {
    const { catalog } = await this.loadAll();
    const tracks = [...(catalog.tracks || [])].sort((a, b) => (b.release_date || "").localeCompare(a.release_date || ""));
    if (!tracks.length) { toast("❌ Каталогът е празен."); return; }

    const overlay = document.createElement("div");
    overlay.id = "moTrackPickerOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";
    overlay.innerHTML = `
      <div class="card" style="max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;">
        <strong>🏷️ Избери песен за AI метаданни предложение</strong>
        <input type="text" id="moTrackPickerSearch" placeholder="Търси по заглавие..." style="margin-top:10px;width:100%;" autofocus>
        <div id="moTrackPickerList" style="overflow-y:auto;margin-top:10px;flex:1;min-height:0;"></div>
        <div style="margin-top:10px;display:flex;justify-content:flex-end;">
          <button class="btn ghost sm" id="moTrackPickerClose">Отказ</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector("#moTrackPickerList");
    const searchEl = overlay.querySelector("#moTrackPickerSearch");
    const close = () => overlay.remove();
    overlay.querySelector("#moTrackPickerClose").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const renderList = (filterText) => {
      const q = (filterText || "").trim().toLowerCase();
      const filtered = q ? tracks.filter(t => (t.title || "").toLowerCase().includes(q)) : tracks;
      listEl.innerHTML = filtered.slice(0, 200).map(t => `
        <div class="copy-field" style="padding:8px 10px;cursor:pointer;" data-vid="${t.youtube_video_id}">
          ${t.title || t.youtube_video_id}
        </div>`).join("") || `<p class="muted">Няма съвпадения.</p>`;
      listEl.querySelectorAll("[data-vid]").forEach(row => {
        row.onclick = () => { close(); this._dispatch("generate", row.getAttribute("data-vid")); };
      });
    };
    renderList("");
    searchEl.addEventListener("input", () => renderList(searchEl.value));
  },

  // ---------- GitHub Actions dispatch (преизползва Keys/token, отделен workflow файл) ----------
  async _dispatch(mode, videoId) {
    const k = Keys.load();
    if (!k.ghToken) return toast("❌ Липсва GitHub Token — виж Настройки → API Ключове");
    if (!k.ghOwner || !k.ghRepo) return toast("❌ Липсват GitHub owner/repo — виж Настройки → YouTube Тракер");
    const branch = k.ghBranch || "main";
    AppLog.write("🏷️ Metadata Optimizer", `▶️ ${mode} стартиран за ${videoId}`);
    try {
      const res = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/actions/workflows/${METADATA_OPTIMIZER_WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ ref: branch, inputs: { mode, video_id: videoId } }),
        }, 20000
      );
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
      toast(`▶️ ${mode === "apply" ? "Прилагане" : "Генериране"} стартирано — виж резултата след ~1-2 мин`);
      AppLog.write("🏷️ Metadata Optimizer", `✅ ${mode} успешно тригнат в GitHub Actions за ${videoId}`);
      setTimeout(() => this.render(true), 90000);
    } catch (e) {
      toast("❌ " + e.message);
      AppLog.write("🏷️ Metadata Optimizer", `❌ ${mode} неуспешен: ${e.message}`);
    }
  },

  apply(videoId) { this._dispatch("apply", videoId); },

  // ---------- Contents API write за metadata-suggestions.json (Approve/Reject) ----------
  async _writeSuggestions(mutatorFn) {
    const k = Keys.load();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) { toast("❌ Липсва GitHub Token/owner/repo — виж Настройки"); return false; }
    const branch = k.ghBranch || "main";
    const path = `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/data/metadata-suggestions.json`;
    try {
      const shaRes = await fetchTimeout(`${path}?ref=${branch}`, { headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json" } });
      if (!shaRes.ok) throw new Error(`Не мога да прочета текущия metadata-suggestions.json (${shaRes.status})`);
      const { sha } = await shaRes.json();
      const { suggestions } = await this.loadAll();
      const updated = mutatorFn(suggestions);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(updated, null, 2) + "\n")));
      const putRes = await fetchTimeout(path, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: "🏷️ Metadata Optimizer: manual approve/reject от Dashboard-а", content, sha, branch }),
      }, 20000);
      if (!putRes.ok) throw new Error(`GitHub ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
      return true;
    } catch (e) {
      toast("❌ " + e.message);
      return false;
    }
  },

  async approve(videoId, btnEl) {
    const cardEl = btnEl?.closest?.(".card");
    const chosenIdx = cardEl ? [...cardEl.querySelectorAll(`input[name="title-${videoId}"]`)].findIndex(r => r.checked) : 0;
    toast("⏳ Записвам...");
    const ok = await this._writeSuggestions(suggestions => {
      const item = suggestions.items[videoId];
      if (item && chosenIdx >= 0) {
        // подрежда избраното заглавие първо, apply() винаги взима suggested_titles[0]
        const titles = [...item.suggested_titles];
        const [chosen] = titles.splice(chosenIdx, 1);
        item.suggested_titles = [chosen, ...titles];
      }
      if (item) item.status = "approved";
      return suggestions;
    });
    if (ok) { toast("✅ Одобрено — сега можеш да натиснеш 'Приложи в YouTube'"); this.render(true); }
  },

  async reject(videoId) {
    toast("⏳ Записвам...");
    const ok = await this._writeSuggestions(suggestions => {
      if (suggestions.items[videoId]) suggestions.items[videoId].status = "rejected";
      return suggestions;
    });
    if (ok) { toast("✅ Отхвърлено"); this.render(true); }
  },

  // ---------- Чистене на стари записи (2026-08-17, по молба на потребителя) ----------
  async remove(videoId) {
    if (!confirm("Изтрий този запис от Metadata Optimizer? (не пипа самото видео в YouTube)")) return;
    toast("⏳ Изтривам...");
    const ok = await this._writeSuggestions(suggestions => {
      delete suggestions.items[videoId];
      return suggestions;
    });
    if (ok) { toast("✅ Изтрито"); this.render(true); }
  },

  async cleanupResolved() {
    const { suggestions } = await this.loadAll();
    const items = Object.values(suggestions.items || {});
    const count = items.filter(i => i.status === "applied" || i.status === "rejected").length;
    if (!count) return toast("Няма приложени/отхвърлени записи за чистене.");
    if (!confirm(`Изтрий ${count} приложени/отхвърлени записа? (само записа в Dashboard-а, не пипа видеата в YouTube; "pending"/"approved" не се пипат)`)) return;
    toast("⏳ Чистя...");
    const ok = await this._writeSuggestions(suggestions => {
      for (const [vid, item] of Object.entries(suggestions.items)) {
        if (item.status === "applied" || item.status === "rejected") delete suggestions.items[vid];
      }
      return suggestions;
    });
    if (ok) { toast(`✅ Изчистени ${count} записа`); this.render(true); }
  },
};
