
/* ---------- NAVIGATION (sidebar multi-view router) ---------- */
// Приложението е PWA (standalone display, виж manifest.json) — на телефон, ако
// няма browser history entries между view-овете, бутонът "Назад" на телефона
// излиза директно от приложението вместо да се връща на предишния екран в него.
// Затова всяка навигация през showView() бута нов history запис (pushState),
// а popstate (физическото Назад) само рендира view-а от запазения state,
// без пак да бута нов запис — така стека расте/намалява 1:1 с реалната
// навигация на потребителя, точно като в нативно мобилно приложение.
const Nav = {
  current: "dashboard",
  init() {
    AppState.load();
    const fromHash = location.hash.replace("#", "");
    const validView = fromHash && document.getElementById("view-" + fromHash);
    this.current = validView ? fromHash : this.current;
    history.replaceState({ cdbView: this.current }, "", "#" + this.current);
    window.addEventListener("popstate", (e) => {
      const id = (e.state && e.state.cdbView) || this.current;
      this.showView(id, /*fromHistory*/ true);
    });
    this.showView(this.current, /*fromHistory*/ true);
  },
  showView(id, fromHistory = false) {
    this.current = id;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + id));
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === id));
    if (id === "step2") Step2.syncTitleToVisualizer();
    if (id === "dashboard") { ProjectDashboard.render(); Stats.renderDashboard(); }
    if (id === "stats-analytics") { Stats.renderAnalytics(); TrackRecord.render(); LearningLoop.render(); }
    if (id === "set-project") { ProjectArchive.render(); SystemUpdate.init(); }
    if (id === "set-keys" || id === "set-proxy") Settings.fillFields();
    if (id === "set-keys") { AICallLog.render(); AICallLog.renderLeaderboard(); QuotaTracker.render(); CostTracker.render(); AgentRoster.render(); }
    if (id === "stats-tracker") Settings.fillFields();
    if (id === "yt-discovery") { YouTubeDiscovery.render(); MetadataOptimizer.render(); }
    if (id === "app-logs") AppLog.render();
    if (id === "niche-toolkit") NicheToolkit.Playbook.renderRows();
    if (id === "system-test") { SystemTest.renderHistory(); }
    if (id === "ai-ideas") { SystemTest.renderIdeaBacklog(); }
    if (id === "model-finder") { Settings.fillFields(); ModelFinder.render(); }
    if (id === "suno-preview") { SunoPreview.render(); }
    if (id === "idea-vault") { IdeaVault.render(); }
    window.scrollTo(0, 0);
    if (!fromHistory) history.pushState({ cdbView: id }, "", "#" + id);
    // На мобилен sidebar-ът е overlay меню (виж CSS media query) — след
    // избор на view трябва сам да се затвори, иначе би стоял отгоре на
    // съдържанието. На десктоп тези класове никога не се слагат, така че
    // тук е безобидно да ги махнем и там (viж closeMobileSidebar).
    this.closeMobileSidebar();
  },
  /* ---------- MOBILE NAV (hamburger overlay) ----------
     .sidebar е нормална sticky колона на десктоп; само на <=760px CSS я
     превръща в fixed overlay (виж index.html <style>). Тези две функции
     просто toggle-ват класа "mobile-open" на sidebar-а + backdrop-а зад
     него — няма нужда от JS media-query проверка, защото на десктоп
     класът просто не прави нищо (там .sidebar няма transform в CSS-а). */
  toggleMobileSidebar() {
    document.querySelector(".sidebar")?.classList.toggle("mobile-open");
    document.getElementById("sidebarBackdrop")?.classList.toggle("mobile-open");
  },
  closeMobileSidebar() {
    document.querySelector(".sidebar")?.classList.remove("mobile-open");
    document.getElementById("sidebarBackdrop")?.classList.remove("mobile-open");
  }
};
