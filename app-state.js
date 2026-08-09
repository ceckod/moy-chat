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

   Зависимости: Storage (глобален, остава в app.js).

   Публичен интерфейс:
     - AppState.data   — текущото състояние (обект, мутира се директно на
       много места из app.js — Step1-4, ProjectArchive, GeminiValidator,
       LyricsHistory, Nav и др.)
     - AppState.load()  — чете от localStorage или инициализира по подразбиране
     - AppState.save()  — записва текущото this.data
   ========================================================= */
const STORAGE_KEY = "cdb_dashboard_state_v1";

const AppState = {
  data: null,

  load() {
    this.data = Storage.get(STORAGE_KEY) || {
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
  },
  save() {
    Storage.set(STORAGE_KEY, this.data);
  }
};
