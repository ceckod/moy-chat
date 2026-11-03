/* =========================================================
   CD-B Records — Control Dashboard
   Bootstrap "лепило" — само window.addEventListener("DOMContentLoaded")
   логиката, която подрежда извикванията при зареждане. Целият
   останал код (17 namespace-а/помощни модула) е в отделни js/*.js
   файлове — виж ARCHITECTURE.md за пълна карта и зависимости.
   ========================================================= */

// Storage, Vault (+VAULT_ENC_KEY/VAULT_FLAG_KEY/_b64/_unb64) и Keys
// (+KEYS_STORAGE) преместени в js/storage.js (виж модула за детайли)

/* =========================================================
   PROVIDERS: CLAUDE / GEMINI
   Целият специфичен код за двата AI доставчика (динамичен списък модели,
   единични извиквания, fallback между модели) вече живее в:
     - js/providers/claude.js  → getClaudeModelList(), callClaude()
     - js/providers/gemini.js  → getGeminiModelList(), callGemini(),
                                   callGeminiMultimodal()
   (заредени преди app.js в index.html). Тук остава само общата
   "оркестрация" (callAI), която избира МЕЖДУ двата провайдъра.
   ========================================================= */

/* ---------- STATE ----------
   AppState (+ STORAGE_KEY) вече живее в js/app-state.js (виж index.html)
   — Стъпка 8 от одита. */


// ModelPref (кой модел е "по подразбиране" за всеки provider) е преместен
// в js/model-pref.js — виж там за пълния коментар/логика.

// AIProviderOrder (в какъв ред се пробват AI providers навсякъде в
// приложението) е преместен в js/ai-provider-order.js — виж там за
// пълния коментар/логика.

// AICallLog (+ AI_CALL_LOG_KEY/AI_CALL_LOG_MAX) вече живее в
// js/ai-call-log.js (виж index.html) — Стъпка 8 от одита.

/* QuotaTracker (+ QUOTA_TRACKER_KEY) вече живее в js/quota-tracker.js
   (виж index.html) — Стъпка 8 от одита. */

/* AICache (+ AI_CACHE_KEY/AI_CACHE_MAX_ENTRIES/_simpleHash) вече живее в
   js/ai-cache.js (виж index.html) — Стъпка 8 от одита. */

/* ---------- TOAST / GUARD CLICK ----------
   toast() и guardClick() вече живеят в js/ui/toast.js и
   js/ui/guard-click.js (виж index.html). */

/* Nav (+ sidebar router/mobile nav) вече живее в js/nav.js
   (виж index.html) — Стъпка 8 от одита. */

/* Settings (+ Vault/AuthGate/ключове UI, export/import, Нов проект) вече
   живее в js/settings.js (виж index.html) — Стъпка 8 от одита. */

// ProjectArchive (+ARCHIVE_STORAGE) преместен в js/project-archive.js (виж модула за детайли)

// callAI(), fileToBase64(), extractJson() преместени в js/ai-helpers.js (виж модула за детайли)

// GeminiValidator преместен в js/gemini-validator.js (виж модула за детайли)

/* =========================================================
   YOUTUBE
   fetchRecentTrendingVideos(), youtubeTopTitles(), youtubeOutlierScan()
   и keywordSuggest() вече живеят в js/youtube.js (виж index.html).
   ========================================================= */
// LyricsHistory преместен в js/lyrics-history.js (виж модула за детайли)

// Step1 преместен в js/step1.js (виж модула за детайли)

// ViralLab (+HookArena, +GhostAudience) преместени в js/viral-lab.js (виж модула за детайли)

// Step2 преместен в js/step2.js (виж модула за детайли)

// Step3 преместен в js/step3.js (виж модула за детайли)

// Step4 преместен в js/step4.js (виж модула за детайли)

// QuickUpload преместен в js/quick-upload.js (виж модула за детайли)

/* Prefs (+ PREFS_STORAGE) вече живее в js/prefs.js (виж index.html) —
   Стъпка 8 от одита. */

/* =========================================================
   STATS — чете data/stats-history.json от GitHub (Actions tracker)
   и рисува KPI карти + графика + таблица с последни видеа.
   ========================================================= */
// TrackRecord (+TRACK_STORAGE) преместен в js/track-record.js (виж модула за детайли)

// Stats преместен в js/stats.js (виж модула за детайли)

/* =========================================================
   INIT
   ========================================================= */
// restoreUI() преместена в js/ui-bootstrap.js (виж модула за детайли)

window.addEventListener("DOMContentLoaded", () => {
  Nav.init();
  restoreUI();
  Step3.buildDistrokidFields();
  GeminiValidator.render();
  SystemLog.init();
  Prefs.init();
  Stats.renderDashboard();
  QuickUpload.initListener();
  updateVaultBanner();
  // Задължителна проверка "работещи AI агенти днес" (виж js/agent-roster.js) —
  // само ако вече има зададен AI ключ И ростърът липсва/е изтекъл. Ако Vault
  // е активен и още заключен, ключовете не са достъпни оттук — проверката се
  // повтаря след Settings.vaultUnlock() по-долу.
  AgentRoster.maybeShowGate();

  // Зареждаме Google Identity Services скрипта динамично
  const gsi = document.createElement("script");
  gsi.src = "https://accounts.google.com/gsi/client";
  gsi.onload = () => Step4.initGoogleAuth();
  document.head.appendChild(gsi);
});

// updateVaultBanner() преместена в js/ui-bootstrap.js (виж модула за детайли)

