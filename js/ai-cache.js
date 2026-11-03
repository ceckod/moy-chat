/* =========================================================
   AI CACHE — извадено от app.js (Стъпка 8 от одита: по-нататъшно
   разбиване на app.js по namespace обект, едно на итерация).

   За скъпи структурирани анализи (Viral Lab, Ghost Audience), за да не се
   хаби квота, ако потребителят натисне бутона повторно върху ТОЧНО СЪЩИЯ
   текст/жанр/заглавие. Ключиран е по хеш на входните данни; при промяна на
   текста автоматично прави нова заявка (различен хеш). Бутон "🔄 презареди"
   в UI-то може да подаде forceRefresh, за да игнорира кеша нарочно.

   Зареден е като обикновен classic <script> (НЕ module) ПРЕДИ app.js в
   index.html. Единствената външна зависимост е глобалният `Storage`
   (дефиниран в app.js) — но `_load()`/`_save()` се извикват само при
   реално AI извикване по-късно по време (не на топ ниво при зареждане),
   така че редът в index.html не чупи нищо — по същия принцип като
   останалите вече извадени файлове (network.js, system-log.js и т.н. —
   виж бележката в js/providers/claude.js).

   Grep-потвърдено (преди извеждането): AICache/AI_CACHE_KEY/
   AI_CACHE_MAX_ENTRIES/_simpleHash се ползват само вътре в app.js
   (ViralLab, GhostAudience) — нула външни референции от index.html или
   други js/*.js файлове.

   Зависимости: Storage (глобален, остава в app.js).

   Публичен интерфейс:
     - AICache.get(type, inputs) — връща кеширан резултат или null
     - AICache.set(type, inputs, result) — записва резултат в кеша
   ========================================================= */
const AI_CACHE_KEY = "cdb_ai_cache_v1";
const AI_CACHE_MAX_ENTRIES = 20;

function _simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const AICache = {
  _load() {
    try { return Storage.get(AI_CACHE_KEY) || {}; } catch (e) { return {}; }
  },
  _save(data) { Storage.set(AI_CACHE_KEY, data); },
  _key(type, inputs) { return type + ":" + _simpleHash(JSON.stringify(inputs)); },

  get(type, inputs) {
    const entry = this._load()[this._key(type, inputs)];
    return entry ? entry.result : null;
  },

  set(type, inputs, result) {
    const data = this._load();
    data[this._key(type, inputs)] = { ts: Date.now(), result };
    const keys = Object.keys(data);
    if (keys.length > AI_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => data[a].ts - data[b].ts)
        .slice(0, keys.length - AI_CACHE_MAX_ENTRIES)
        .forEach(k => delete data[k]);
    }
    this._save(data);
  }
};
