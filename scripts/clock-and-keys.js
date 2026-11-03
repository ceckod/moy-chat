/* =========================================================
   CD-B Records — Digital Clock + Persistent API Keys
   Самостоятелен модул. НЕ променя index.html структурно —
   намира логото "AI Music Suite" и вкарва часовник под него.
   Включва се с един ред преди </body>:
     <script src="scripts/clock-and-keys.js"></script>
   ========================================================= */
(function () {
  "use strict";

  const KEYS_STORAGE = "cdb_dashboard_keys_v1"; // същият ключ, който ползва app.js

  /* ---------------------------------------------------------
     1) ДИГИТАЛЕН ЧАСОВНИК под логото "AI Music Suite"
     --------------------------------------------------------- */
  const CLOCK_ID = "cdbDigitalClock";

  function injectClockStyles() {
    if (document.getElementById("cdbClockStyles")) return;
    const css = document.createElement("style");
    css.id = "cdbClockStyles";
    css.textContent = `
      #${CLOCK_ID}{
        display:block;
        margin:6px 0 2px;
        font-family:"SF Mono",ui-monospace,"Roboto Mono",Consolas,monospace;
        font-size:22px;            /* малко по-голям от заглавието */
        font-weight:600;
        letter-spacing:2px;
        line-height:1.1;
        color:#22d3ee;
        text-shadow:0 0 10px rgba(34,211,238,.45);
        user-select:none;
      }
      #${CLOCK_ID} .cdb-clock-date{
        display:block;
        font-size:11px;
        font-weight:400;
        letter-spacing:.5px;
        color:#8b8fb0;
        text-shadow:none;
        margin-top:2px;
      }
      body.theme-light #${CLOCK_ID}{ color:#0e7490; text-shadow:none; }
    `;
    document.head.appendChild(css);
  }

  // Намира елемента с текста "AI Music Suite" (или най-близкото лого/brand)
  function findLogoElement() {
    const candidates = document.querySelectorAll(
      ".brand, .logo, .sidebar-brand, .sidebar h1, .sidebar h2, .brand-title, aside h1, aside h2, header h1"
    );
    for (const el of candidates) {
      if (/ai\s*music\s*suite/i.test(el.textContent || "")) return el;
    }
    // Fallback: обхождаме всички малки текстови елементи
    const all = document.querySelectorAll("h1,h2,h3,div,span,strong,a");
    for (const el of all) {
      const t = (el.textContent || "").trim();
      if (t.length < 40 && /ai\s*music\s*suite/i.test(t) && el.children.length <= 2) return el;
    }
    // Последен вариант: първия .brand/.logo/.sidebar, каквото има
    return document.querySelector(".brand, .logo, .sidebar-brand, .sidebar, aside");
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function tick() {
    const el = document.getElementById(CLOCK_ID);
    if (!el) return;
    const d = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const date = d.toLocaleDateString("bg-BG", { day: "2-digit", month: "short", year: "numeric" });
    el.innerHTML = `${time}<span class="cdb-clock-date">${date}</span>`;
  }

  function mountClock() {
    if (document.getElementById(CLOCK_ID)) return true;
    const logo = findLogoElement();
    if (!logo) return false;

    injectClockStyles();
    const clock = document.createElement("div");
    clock.id = CLOCK_ID;
    clock.title = "Текущо време";

    // Вкарваме ГО ПОД логото — като следващ съсед в същия контейнер
    if (logo.parentNode) logo.parentNode.insertBefore(clock, logo.nextSibling);
    else logo.appendChild(clock);

    tick();
    setInterval(tick, 1000);
    return true;
  }

  /* ---------------------------------------------------------
     2) ТРАЙНО ЗАПАЗВАНЕ НА API КЛЮЧОВЕ / ПАРОЛИ
     Пази ги в localStorage докато ТИ не ги изтриеш.
     - авто-попълва полетата при всяко зареждане/отваряне на view
     - авто-запазва при всяка промяна (не чака бутон "Запази")
     - добавя и GitHub полетата към Settings.save()
     --------------------------------------------------------- */
  // id на полето -> име на свойството в localStorage обекта
  const FIELD_MAP = {
    key_claude:       "claude",
    key_gemini:       "gemini",
    key_yt_client_id: "ytClientId",
    key_yt_apikey:    "ytApiKey",
    key_proxy_url:    "proxyUrl",
    gh_owner:         "ghOwner",
    gh_repo:          "ghRepo",
    gh_branch:        "ghBranch"
  };

  function loadKeys() {
    try { return JSON.parse(localStorage.getItem(KEYS_STORAGE) || "{}"); }
    catch (e) { return {}; }
  }

  function storeKeys(obj) {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(obj));
  }

  // Попълва всички налични полета от запазените стойности
  function fillAllFields() {
    const k = loadKeys();
    Object.entries(FIELD_MAP).forEach(([id, prop]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const saved = k[prop];
      // не презаписваме, ако потребителят точно в момента пише в полето
      if (document.activeElement === el) return;
      if (saved && !el.value) el.value = saved;
      else if (saved && el.value !== saved && !el.dataset.cdbTouched) el.value = saved;
    });
  }

  // Записва текущите стойности на всички полета
  function saveAllFields() {
    const k = loadKeys();
    let changed = false;
    Object.entries(FIELD_MAP).forEach(([id, prop]) => {
      const el = document.getElementById(id);
      if (!el) return;
      let v = el.value.trim();
      if (prop === "proxyUrl") v = v.replace(/\/$/, "");
      if (prop === "ghBranch" && !v) v = "main";
      // Празно поле НЕ трие запазен ключ автоматично — трие се само
      // ако полето е било пипано ръчно (за да можеш реално да изтриеш ключ).
      if (!v && !el.dataset.cdbTouched) return;
      if (k[prop] !== v) { k[prop] = v; changed = true; }
      if (!v) delete k[prop];
    });
    if (changed) storeKeys(k);
    return changed;
  }

  function bindFieldListeners() {
    Object.keys(FIELD_MAP).forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.cdbBound) return;
      el.dataset.cdbBound = "1";
      el.addEventListener("input", () => {
        el.dataset.cdbTouched = "1";
        saveAllFields();
      });
      el.addEventListener("change", () => {
        el.dataset.cdbTouched = "1";
        saveAllFields();
      });
      el.addEventListener("blur", saveAllFields);
    });
  }

  // Обвиваме Settings.save() и Settings.fillFields(), за да включат и GitHub полетата
  function patchSettings() {
    if (typeof window.Settings !== "object" || !window.Settings) return false;
    if (window.Settings.__cdbPatched) return true;
    window.Settings.__cdbPatched = true;

    const origSave = window.Settings.save?.bind(window.Settings);
    window.Settings.save = function () {
      saveAllFields();                 // първо пазим всичко, включително gh_* полетата
      if (origSave) origSave();        // после оригиналната логика (toast, Google auth и т.н.)
    };

    const origFill = window.Settings.fillFields?.bind(window.Settings);
    window.Settings.fillFields = function () {
      if (origFill) origFill();
      fillAllFields();                 // допълва gh_* полетата, които оригиналът пропуска
      bindFieldListeners();
    };
    return true;
  }

  /* ---------------------------------------------------------
     3) СТАРТ
     --------------------------------------------------------- */
  function boot() {
    mountClock();
    patchSettings();
    fillAllFields();
    bindFieldListeners();

    // SPA-та сменя view-та динамично → следим за нови полета/лого
    const obs = new MutationObserver(() => {
      mountClock();
      patchSettings();
      bindFieldListeners();
      fillAllFields();
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Подсигуряване (ако логото се рендерира по-късно)
    let tries = 0;
    const retry = setInterval(() => {
      if (mountClock() || ++tries > 20) clearInterval(retry);
    }, 500);

    // Запазваме и при затваряне на страницата
    window.addEventListener("beforeunload", saveAllFields);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
