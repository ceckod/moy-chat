/* =========================================================
   SYSTEM UPDATE — статус панел + ъплоуд за Auto Update системата
   (виж update_engine.py в root-а на repo-то + .github/workflows/
   auto-update.yml + AUDIT_PROGRESS.md за пълния разбор на защитите).

   2026-08-13 — АРХИТЕКТУРНА ПРОМЯНА (СЪЗНАТЕЛНА, ПОТВЪРДЕНА ОТ
   ПОТРЕБИТЕЛЯ, отменя предишното решение "без token в браузъра"):
   Модулът вече ПРАВИ commit директно в repo-то (GitHub Contents API,
   PUT /repos/{owner}/{repo}/contents/incoming/{filename}), ползвайки
   GitHub Personal Access Token-а от Настройки (Keys.load().ghToken —
   полето вече съществуваше, досега само тествано с GET /user, никога
   реално писане). ПРЕПОРЪКА, дадена изрично на потребителя: token-ът
   да е fine-grained, ограничен само до repo "moy-chat" и само permission
   "Contents: Read and write" — не classic token с пълен account достъп.
   Токенът си стои само в localStorage/Vault на потребителя (същия модел
   на доверие като Claude/Gemini/OpenRouter ключовете), НЕ се праща
   никъде другаде освен пряко към api.github.com от браузъра му.

   Статус секцията (версия + последен report + чеклист) остава
   непроменена по логика — само read-only, GET заявки, БЕЗ token.
   Само НОВАТА ъплоуд секция долу пише в repo-то.

   ⬆️ Как работи ъплоуда:
     - Ако избереш ТОЧНО 1 файл и той вече е .zip → качва се какъвто е.
     - Ако избереш няколко файла (или 1 файл, който НЕ е .zip) → сайтът
       сам ги пакетира в zip В БРАУЗЪРА (библиотека JSZip, виж index.html)
       преди да ги качи — update_engine.py и workflow-ът остават напълно
       непипнати, продължават да очакват incoming/*.zip както досега.
     - Файлът каца в incoming/ с уникално timestamp-нато име (за да не
       се сблъска със стар upload) → push-ът към incoming/*.zip вече САМ
       тригва auto-update.yml, без нищо допълнително да викаме тук.
     - Преди реалното качване — window.confirm() с ясен текст какво ще
       се случи (commit в repo-то, workflow ще тръгне автоматично).

   ЗАВИСИМОСТ (нова, само за ъплоуд пътя): JSZip — зарежда се ДИНАМИЧНО
   от CDN само при реална нужда (виж _loadJSZip() по-долу), НЕ през
   <script> таг в index.html — нарочно, за да остане цялата промяна
   в един-единствен файл (index.html, System Core/high-risk, не е пипнат).

   Публичен интерфейс:
     - SystemUpdate.init()            — вика се от js/nav.js
     - SystemUpdate.refresh()         — "🔄 CHECK UPDATE" (само статус)
     - SystemUpdate.uploadSelected()  — "⬆️ Качи и обнови" (пише в repo-то)
   ========================================================= */

const SystemUpdate = {
  _lastReport: null,
  _lastVersion: null,
  _loading: false,
  _fetchError: null,

  async init() {
    await this.refresh();
  },

  // ---------------- STATUS (read-only, непроменено по логика) ----------------

  async refresh() {
    this._loading = true;
    this._fetchError = null;
    this.render();
    try {
      const [version, report] = await Promise.all([
        this._fetchVersion(),
        this._fetchReport()
      ]);
      this._lastVersion = version;
      this._lastReport = report;
    } catch (e) {
      this._fetchError = e.message;
    } finally {
      this._loading = false;
      this.render();
    }
  },

  async _fetchVersion() {
    try {
      const res = await fetchTimeout("./README.md", {}, 8000);
      if (!res.ok) return null;
      const text = await res.text();
      const m = text.match(/\*\*Версия:\*\*\s*([\d.]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  },

  async _fetchReport() {
    try {
      const res = await fetchTimeout(`./update_report.txt?_=${Date.now()}`, {}, 8000);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  },

  _parsePackageName(report) {
    if (!report) return null;
    const m = report.match(/([A-Za-z0-9_\-.]+\.zip)/);
    return m ? m[1] : null;
  },

  _parseOverallOk(report) {
    if (!report) return null;
    const ok = /Result:\s*OK|READY TO COMMIT/i.test(report);
    const failed = /Result:\s*FAILED/i.test(report);
    if (failed) return false;
    if (ok) return true;
    return null;
  },

  _checkFor(report, patterns) {
    if (!report) return null;
    for (const p of patterns) if (p.test(report)) return true;
    return null;
  },

  _buildChecklist(report) {
    return [
      { label: "Backup на текущата версия", state: this._checkFor(report, [/backup/i]) },
      { label: "Валидация на пакета (secret scan, критични файлове)", state: this._checkFor(report, [/valid(at(e|ion))?/i, /secret scan/i]) },
      { label: "Тестове (npm test)", state: this._checkFor(report, [/npm test/i, /\d+\/\d+\s*(tests?)?/i]) },
      { label: "visualizer.html защитен/недосегаем", state: this._checkFor(report, [/visualizer.*(preserved|protected|недосегаем|защитен)/i]) }
    ];
  },

  _checklistIcon(state) {
    if (state === true) return "✅";
    if (state === false) return "❌";
    return "➖";
  },

  // ---------------- UPLOAD (ново, пише в repo-то) ----------------

  _ts() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  },

  // Динамично зареждане на JSZip САМО когато реално се ползва ъплоуд с
  // повече от 1 файл / файл, който не е .zip — нарочно НЕ в index.html
  // (System Core, high-risk), за да остане тази цяла функционалност
  // самостоятелна в един-единствен файл (js/system-update.js). Кешира
  // се (_jszipPromise), за да не се тегли повторно при следващ ъплоуд.
  _loadJSZip() {
    if (typeof JSZip !== "undefined") return Promise.resolve();
    if (this._jszipPromise) return this._jszipPromise;
    this._jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("JSZip не можа да се зареди от CDN — провери интернет връзката"));
      document.head.appendChild(s);
    });
    return this._jszipPromise;
  },

  async _blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  },

  async uploadSelected() {
    const input = document.getElementById("systemUpdateFileInput");
    const files = input ? Array.from(input.files || []) : [];
    return this.uploadFiles(files);
  },

  async uploadFiles(files) {
    const out = document.getElementById("systemUpdateUploadOut");
    const input = document.getElementById("systemUpdateFileInput");
    const setOut = html => { if (out) out.innerHTML = html; };

    if (!files || !files.length) return toast("⚠️ Не си избрал файл(ове)");

    const k = Keys.load();
    if (!k.ghToken) return toast("❌ Липсва GitHub Token — виж Настройки → API Ключове");
    if (!k.ghOwner || !k.ghRepo) return toast("❌ Липсва GitHub потребител/организация или repo — виж Настройки → YouTube Тракер (същите полета)");

    let blob, filename;
    try {
      if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
        blob = files[0];
        filename = files[0].name.replace(/\.zip$/i, "") + "-" + this._ts() + ".zip";
      } else {
        setOut("⏳ Зареждам zip библиотека...");
        await this._loadJSZip();
        const zip = new JSZip();
        for (const f of files) zip.file(f.name, await f.arrayBuffer());
        blob = await zip.generateAsync({ type: "blob" });
        filename = "update-" + this._ts() + ".zip";
      }
    } catch (e) {
      setOut(`❌ Грешка при подготовка на файла: ${this._escapeHtml(e.message)}`);
      return;
    }

    const sizeKb = Math.round(blob.size / 1024);
    const ok = confirm(
      `Ще качиш "${filename}" (~${sizeKb} KB) директно в incoming/ на GitHub repo "${k.ghOwner}/${k.ghRepo}".\n\n` +
      `Това е РЕАЛЕН commit — веднага ще тригне Auto Update workflow-а ` +
      `(backup → validate → тестове → commit или автоматичен rollback при провал).\n\nПродължаваш ли?`
    );
    if (!ok) return;

    setOut("⏳ Качвам...");
    try {
      const base64 = await this._blobToBase64(blob);
      const branch = k.ghBranch || "main";
      const res = await fetchTimeout(
        `https://api.github.com/repos/${k.ghOwner}/${k.ghRepo}/contents/incoming/${encodeURIComponent(filename)}`,
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${k.ghToken}`,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: `Auto Update: качен ${filename} през dashboard-а`,
            content: base64,
            branch
          })
        },
        30000
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GitHub ${res.status}: ${body.slice(0, 300)}`);
      }

      toast("✅ Качено — workflow-ът тръгва автоматично");
      setOut(
        `✅ "${this._escapeHtml(filename)}" качен успешно.<br>` +
        `<a href="https://github.com/${k.ghOwner}/${k.ghRepo}/actions" target="_blank" rel="noopener">Виж Actions →</a> ` +
        `<span class="muted">(отнема обикновено 1-2 мин)</span>`
      );
      if (input) input.value = "";
      setTimeout(() => this.refresh(), 20000);
    } catch (e) {
      setOut(`❌ ${this._escapeHtml(e.message)}`);
      toast("❌ " + e.message);
    }
  },

  // ---------------- RENDER ----------------

  render() {
    const out = document.getElementById("systemUpdateOut");
    if (!out) return;

    if (this._loading) {
      out.innerHTML = `<div class="muted">⏳ Проверявам...</div>`;
      return;
    }

    const version = this._lastVersion || "—";
    const pkgName = this._parsePackageName(this._lastReport) || "— (няма данни)";
    const overallOk = this._parseOverallOk(this._lastReport);
    const checklist = this._buildChecklist(this._lastReport);

    const statusBadge = this._lastReport
      ? (overallOk === true
          ? `<span style="color:#4ade80;">✅ Успешен</span>`
          : overallOk === false
            ? `<span style="color:#f87171;">❌ Провалил се (rollback, нищо счупено)</span>`
            : `<span class="muted">Статусът не можа да се разпознае от текста</span>`)
      : `<span class="muted">Все още няма завършен Auto Update</span>`;

    const checklistHtml = checklist.map(item => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
        <span style="width:1.2em;text-align:center;">${this._checklistIcon(item.state)}</span>
        <span>${item.label}</span>
      </div>
    `).join("");

    const rawReportHtml = this._lastReport
      ? `<details style="margin-top:10px;">
           <summary style="cursor:pointer;color:var(--accent,#8ab4f8);">Пълен текст на последния report</summary>
           <pre style="white-space:pre-wrap;font-size:12px;background:rgba(255,255,255,.04);padding:10px;border-radius:8px;margin-top:8px;max-height:260px;overflow:auto;">${this._escapeHtml(this._lastReport)}</pre>
         </details>`
      : `<div class="muted" style="margin-top:8px;">Все още няма минал update.</div>`;

    const errorHtml = this._fetchError
      ? `<div class="muted" style="margin-top:6px;">(${this._escapeHtml(this._fetchError)})</div>`
      : "";

    out.innerHTML = `
      <div style="border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px 18px;max-width:520px;">
        <div style="font-weight:700;letter-spacing:.03em;margin-bottom:10px;">🔄 SYSTEM UPDATE</div>
        <div style="border-top:1px solid rgba(255,255,255,.1);margin-bottom:12px;"></div>

        <div style="margin-bottom:4px;"><strong>Текуща версия:</strong> ${version}</div>
        <div style="margin-bottom:12px;"><strong>Последен обработен пакет:</strong> ${pkgName}</div>

        <div style="margin-bottom:8px;">${statusBadge}</div>

        <div style="margin:10px 0;">
          ${checklistHtml}
        </div>

        <button type="button" onclick="SystemUpdate.refresh()"
          style="margin-top:6px;padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.2);
                 background:rgba(255,255,255,.06);cursor:pointer;font-weight:600;">
          🔄 CHECK UPDATE
        </button>

        ${errorHtml}
        ${rawReportHtml}

        <div style="border-top:1px solid rgba(255,255,255,.1);margin:16px 0 12px;"></div>

        <div style="font-weight:600;margin-bottom:6px;">⬆️ Качи update</div>
        <div class="muted" style="font-size:12px;margin-bottom:8px;">
          Избери готов <code>update.zip</code> (с няколко файла) ИЛИ един/няколко отделни
          файла — при отделни файлове сайтът сам ги пакетира в zip преди качване.
          Изисква GitHub Token + owner/repo, зададени в Настройки → API Ключове.
        </div>
        <input type="file" id="systemUpdateFileInput" multiple style="margin-bottom:8px;display:block;width:100%;">
        <button type="button" onclick="SystemUpdate.uploadSelected()"
          style="padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.2);
                 background:rgba(255,255,255,.06);cursor:pointer;font-weight:600;">
          ⬆️ Качи и обнови
        </button>
        <div id="systemUpdateUploadOut" style="margin-top:8px;font-size:13px;"></div>
      </div>
    `;
  },

  _escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
};
