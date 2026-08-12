/* =========================================================
   SYSTEM UPDATE — read-only статус панел за Auto Update системата
   (виж update_engine.py в root-а на repo-то + .github/workflows/
   auto-update.yml + AUDIT_PROGRESS.md за пълния разбор на защитите).

   КРИТИЧНО АРХИТЕКТУРНО РЕШЕНИЕ, НЕ СЛУЧАЙНО ОПРОСТЯВАНЕ:
   Този модул НЕ съдържа GitHub token, НЕ прави commit, НЕ тригва
   workflow директно от браузъра. Той САМО чете и показва:
     (а) текущата версия (от README.md хедъра, същия текст, който
         виждаш в браузъра при "Преглед на README")
     (б) последния update_report.txt, ако вече има завършен Auto
         Update run (успешен или неуспешен — и двата се commit-ват,
         виж workflow-а)

   Причината е изрично заявена от потребителя: GitHub credential в
   browser/localStorage/JS = практически компрометируем (DevTools
   достъп до всеки с физически достъп до устройството). Затова
   единственият начин да СТАРТИРАШ update е да качиш ZIP-а в incoming/
   през самия GitHub уеб интерфейс (или git push) — виж инструкциите,
   рендирани от render() по-долу. Dashboard-ът е "контролен панел",
   не мястото, където живее секретът (директен цитат от заявката на
   потребителя, запазен тук нарочно, за да не се "подобри" това по
   грешка занапред).

   Зареден е като обикновен classic <script>, следвайки формàта на
   останалите извадени namespace модули (виж SystemLog за референция).

   Зависимости: fetchTimeout() (js/network.js) — relative fetch на
   собствения произход на сайта (README.md / update_report.txt),
   БЕЗ auth, работи само защото файловете са публични в repo-то.

   Публичен интерфейс:
     - SystemUpdate.init()   — извиква се от js/nav.js при отваряне на
                                view "set-project" ("Проект & Данни"),
                                по същия pattern като ProjectArchive.render()
     - SystemUpdate.refresh()— бутон "🔄 Провери статус"
   ========================================================= */

const SystemUpdate = {
  _lastReport: null,
  _lastVersion: null,

  async init() {
    await this.refresh();
  },

  async refresh() {
    const out = document.getElementById("systemUpdateOut");
    if (out) out.innerHTML = "⏳ Проверявам...";
    try {
      const [version, report] = await Promise.all([
        this._fetchVersion(),
        this._fetchReport()
      ]);
      this._lastVersion = version;
      this._lastReport = report;
      this.render();
    } catch (e) {
      if (out) out.innerHTML = `<span class="muted">Няма данни все още (${e.message}).</span>`;
    }
  },

  async _fetchVersion() {
    // README.md е публичен, статичен файл в самия repo — четем го
    // relative към текущия произход (същия домейн, който сервира
    // index.html), НЕ през GitHub API/token.
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
      if (!res.ok) return null; // нормално — значи още няма минал Auto Update run
      return await res.text();
    } catch {
      return null;
    }
  },

  render() {
    const out = document.getElementById("systemUpdateOut");
    if (!out) return;

    const versionLine = this._lastVersion
      ? `<div><strong>Текуща версия:</strong> ${this._lastVersion}</div>`
      : `<div class="muted">Версията не можа да се прочете от README.md.</div>`;

    let reportHtml;
    if (!this._lastReport) {
      reportHtml = `<div class="muted" style="margin-top:8px;">Все още няма завършен Auto Update — виж инструкциите по-долу как да пуснеш първия.</div>`;
    } else {
      const isOk = /Result: OK|READY TO COMMIT/.test(this._lastReport) && !/Result: FAILED/.test(this._lastReport);
      const badge = isOk ? `<span style="color:#4ade80;">✅ Последен update: успешен</span>` : `<span style="color:#f87171;">❌ Последен update: провалил се (rollback, нищо счупено)</span>`;
      reportHtml = `
        <div style="margin-top:8px;">${badge}</div>
        <pre style="white-space:pre-wrap;font-size:12px;background:rgba(255,255,255,.04);padding:10px;border-radius:8px;margin-top:8px;max-height:260px;overflow:auto;">${this._escapeHtml(this._lastReport)}</pre>`;
    }

    out.innerHTML = versionLine + reportHtml;
  },

  _escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
};
