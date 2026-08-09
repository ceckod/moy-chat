/* =========================================================
   PREFS — извадено от app.js (Стъпка 8 от одита: по-нататъшно разбиване
   на app.js по namespace обект, едно на итерация).

   Тема (тъмна/светла) + тихa проверка на ключовете при зареждане +
   избор на "AI provider за съдържание" (auto/claude/gemini/...) +
   автопилот (верижно генериране без ръчни бутони).

   Зареден е като обикновен classic <script> (НЕ module) ПРЕДИ app.js в
   index.html. Методите му се извикват само по-късно по време (onclick от
   потребителя, или Prefs.init() от DOMContentLoaded в app.js) — не на топ
   ниво при зареждане — затова редът спрямо app.js/AIProviderOrder/Settings
   не чупи нищо (същият established принцип като останалите извадени
   файлове).

   Grep-потвърдено (преди извеждането): PREFS_STORAGE се ползва само вътре
   в Prefs. Външни извиквания (onclick в index.html):
   Prefs.setContentProvider / Prefs.toggleAutopilot /
   Prefs.toggleHealthCheck / Prefs.toggleTheme.

   Зависимости (всички глобални, останали в app.js/js/ui):
     - Storage       (app.js)
     - toast()       (js/ui/toast.js, зареден преди Prefs в index.html)
     - AIProviderOrder.label()  (app.js — извиква се само вътре в
       setContentProvider(), т.е. при реален избор на потребителя, дълго
       след като app.js вече е зареден)
     - Settings.silentHealthCheck()  (app.js — извиква се само вътре в
       init(), извикан от DOMContentLoaded в app.js, т.е. след като
       Settings вече съществува)

   Публичен интерфейс:
     - Prefs.data — { theme, healthCheck, contentProvider, autopilot }
     - Prefs.init() — вика се веднъж от app.js (DOMContentLoaded)
     - Prefs.toggleTheme() / toggleHealthCheck() / toggleAutopilot()
     - Prefs.setContentProvider(value)
   ========================================================= */
const PREFS_STORAGE = "cdb_dashboard_prefs_v1";
const Prefs = {
  data: { theme: "dark", healthCheck: true, contentProvider: "auto", autopilot: false },
  load() {
    const saved = Storage.get(PREFS_STORAGE);
    this.data = saved ? Object.assign({ theme: "dark", healthCheck: true, contentProvider: "auto", autopilot: false }, saved) : this.data;
  },
  save() {
    Storage.set(PREFS_STORAGE, this.data);
  },
  applyTheme() {
    document.body.classList.toggle("theme-light", this.data.theme === "light");
    document.querySelectorAll("#themeSwitch,#themeSwitch2,#themeSwitch3").forEach(s => {
      if (s) s.classList.toggle("on", this.data.theme === "light");
    });
  },
  toggleTheme() {
    this.data.theme = this.data.theme === "light" ? "dark" : "light";
    this.save();
    this.applyTheme();
  },
  applyHealthSwitch() {
    document.querySelectorAll("#healthSwitch,#healthSwitch2").forEach(s => {
      if (s) s.classList.toggle("on", this.data.healthCheck);
    });
  },
  toggleHealthCheck() {
    this.data.healthCheck = !this.data.healthCheck;
    this.save();
    this.applyHealthSwitch();
    toast(this.data.healthCheck ? "Проверка при зареждане: включена" : "Проверка при зареждане: изключена");
  },
  applyContentProvider() {
    document.querySelectorAll("#contentProviderSelect,#contentProviderSelectTop").forEach(s => {
      if (s) s.value = this.data.contentProvider;
    });
  },
  setContentProvider(value) {
    if (!["auto", "claude", "gemini", "openrouter", "modelfinder"].includes(value)) return;
    this.data.contentProvider = value;
    this.save();
    this.applyContentProvider();
    toast(value === "auto" ? "🔄 Генериране на съдържание: автоматично (по резултата от последния тест на ключовете)" : `✍️ Генериране на съдържание: ${AIProviderOrder.label(value)}`);
  },
  applyAutopilotSwitch() {
    document.querySelectorAll("#autopilotSwitch").forEach(s => {
      if (s) s.classList.toggle("on", this.data.autopilot);
    });
  },
  // Автопилот (по избор, изключен по подразбиране): след като най-добрата ниша
  // е избрана, автоматично верижно генерира текст на песента + Viral Lab анализ,
  // без да чакаш ръчно да натискаш всеки бутон поотделно. Вижте _renderNicheResults().
  toggleAutopilot() {
    this.data.autopilot = !this.data.autopilot;
    this.save();
    this.applyAutopilotSwitch();
    toast(this.data.autopilot
      ? "🤖 Автопилот: включен (текст + Viral анализ ще тръгват автоматично)"
      : "🤖 Автопилот: изключен");
  },
  init() {
    this.load();
    this.applyTheme();
    this.applyHealthSwitch();
    this.applyContentProvider();
    this.applyAutopilotSwitch();
    if (this.data.healthCheck) Settings.silentHealthCheck();
    else {
      const txt = document.getElementById("validatorStatusText");
      if (txt) txt.textContent = "Проверката е изключена";
    }
  }
};
