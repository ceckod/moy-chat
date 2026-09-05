/* =========================================================
   APP STATE — извадено от app.js (Стъпка 8 от одита: по-нататъшно
   разбиване на app.js по namespace обект, едно на итерация).

   Централното състояние на текущия проект (стъпка, статус на 4-те стъпки,
   заглавие/текст/cover/hashtags и т.н.) — пазено в localStorage под
   STORAGE_KEY, зареждано/записвано през AppState.load()/AppState.save().

   Зареден е като обикновен classic <script> (НЕ module) ПРЕДИ app.js в
   index.html. Единствената зависимост е глобалният `Storage` (дефиниран в
   app.js) — `load()`/`save()` се извикват само по-късно по време (от
   DOMContentLoaded листенъра и от потребителски действия), не на топ ниво
   при зареждане, затова редът не чупи нищо.

   ⚠️ STORAGE_KEY се ползва и извън AppState — в app.js, Settings.newProject()
   директно вика `Storage.remove(STORAGE_KEY)` при "Нов проект". Това работи
   без проблем, защото top-level `const` в отделни classic <script> тагове
   на една страница споделят един и същ глобален lexical scope (стандартно
   поведение на браузъра за non-module скриптове) — точно както KEYS_STORAGE/
   VAULT_ENC_KEY вече се ползват между Vault/Keys и остатъка от app.js.

   2026-09-05 (AI Gateway/State рефакторинг, Фаза 2):
     - sanitizeState() — защита срещу TypeError при зареждане на по-стар
       кеш, на който липсват по-нови полета (виж коментара на функцията).
     - save() вече е debounce-нат (300ms) вместо синхронен на всяко
       извикване (виж коментара на save() по-долу) — с saveNow() safety
       net при beforeunload, за да не се губят последните промени.

   Зависимости: Storage (глобален, остава в app.js).

   Публичен интерфейс:
     - AppState.data      — текущото състояние (обект, мутира се директно
       на много места из app.js — Step1-4, ProjectArchive, GeminiValidator,
       LyricsHistory, Nav и др.)
     - AppState.load()    — чете от localStorage (през sanitizeState) или
       инициализира по подразбиране
     - AppState.save()    — debounce-нат (300ms) запис на текущото this.data
     - AppState.saveNow() — незабавен, синхронен запис (виж коментара му)
   ========================================================= */
const STORAGE_KEY = "cdb_dashboard_state_v1";

// Каноничната "форма" на състоянието — единствен източник на истина за
// подразбиращите се стойности. Ползва се от:
//   1) load() при ПЪРВО зареждане (няма нищо в localStorage все още)
//   2) sanitizeState() при зареждане на ПО-СТАР кеш, на който може да
//      липсват по-нови полета (добавени в по-нова версия на приложението) —
//      без това, `AppState.data.project.someNewField.x` хвърля TypeError
//      ("Cannot read properties of undefined"), защото someNewField просто
//      не съществува в стар запис.
function _defaultAppState() {
  return {
    currentStep: 1,
    status: { 1: "blue", 2: "grey", 3: "grey", 4: "grey" },
    project: {
      niches: [], chosenNiche: null, nicheScore: null,
      title: "", stylePrompt: "", hashtags: [],
      lyrics: "", geminiReview: "",
      fxConfig: "", coverPrompt: "", coverImageUrl: "",
      distrokid: {}, youtube: {}
    }
  };
}

// Плитко-дълбоко слива зареденото състояние върху дефолтната схема:
// липсващ ключ → взима се от дефолта; съществуващ ключ (дори "" или []) →
// запазва се какъвто е зареден (НЕ презаписваме реални данни на потребителя
// с дефолти). За вложени обекти (status, project) прави същото едно ниво
// по-навътре, за да оцелеят стари записи, на които им липсва само 1-2 нови
// под-полета в project (най-честият случай на практика), без целият
// под-обект да бъде заменен.
function sanitizeState(loadedData) {
  const def = _defaultAppState();
  if (!loadedData || typeof loadedData !== "object") return def;

  const merged = { ...def, ...loadedData };
  merged.status = { ...def.status, ...(loadedData.status && typeof loadedData.status === "object" ? loadedData.status : {}) };
  merged.project = { ...def.project, ...(loadedData.project && typeof loadedData.project === "object" ? loadedData.project : {}) };
  return merged;
}

const AppState = {
  data: null,
  _saveTimer: null,

  load() {
    this.data = sanitizeState(Storage.get(STORAGE_KEY));
  },

  // Незабавен, синхронен запис — за случаите, в които СЛЕДВАЩАТА стъпка
  // разчита състоянието вече да е на диска (напр. точно преди Settings.
  // newProject() да презапише всичко, или преди експорт/навигация away).
  // Отменя евентуален чакащ debounce-нат save(), за да не презапише после
  // с по-старо копие.
  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    Storage.set(STORAGE_KEY, this.data);
  },

  // Debounce-нат запис (300ms) — предпочитаният път за ЧЕСТИ промени (typing
  // в textarea/input с oninput="...; AppState.save()", извиквано на ВСЕКИ
  // натиснат клавиш на 59+ места из приложението). Без debounce, всеки клавиш
  // сериализира и записва ЦЕЛИЯ project обект (вкл. потенциално голям
  // coverImageUrl base64 стринг) в localStorage синхронно — забележимо
  // накъсва писането при бърз тайпинг и е чист waste, ако потребителят пише
  // 10 знака в секунда. Публичният интерфейс (AppState.save()) остава
  // непроменен за 59-те съществуващи извиквания из приложението — не е нужно
  // да се пипа нито едно от тях.
  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      Storage.set(STORAGE_KEY, this.data);
    }, 300);
  }
};

// Гарантира, че НИКОГА не губим последните <300ms промени, ако потребителят
// затвори/презареди таба точно докато debounce таймерът тиктака — flush-ва
// синхронно всеки чакащ запис. beforeunload е единственото събитие, което
// браузърите гарантирано изпълняват докато страницата все още е "жива".
window.addEventListener("beforeunload", () => {
  if (AppState._saveTimer) AppState.saveNow();
});
