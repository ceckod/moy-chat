/* =========================================================
   STORAGE / VAULT / KEYS
   (Storage + Vault (+VAULT_ENC_KEY/VAULT_FLAG_KEY/_b64/_unb64) + Keys
   (+KEYS_STORAGE) — базовите модули, от които зависи почти всичко
   останало в проекта: AppState, ModelPref, AICallLog, QuotaTracker,
   AICache, Prefs, TrackRecord и т.н. минават през Storage; Keys
   минава през Vault, когато е включен.)

   Преместени 1:1 от app.js (десета итерация — последната от плана
   за изнасяне на namespace-и) — логиката не е променена.
   Зависимости: няма външни (само помежду си — Keys използва Vault
   и Storage; Vault използва Storage). Всичко runtime, вътре в
   методи — редът на <script> таговете не е критичен, но е
   поставен рано (преди js/app-state.js и останалите, които го
   ползват), за яснота.
   ========================================================= */

const KEYS_STORAGE = "cdb_dashboard_keys_v1";

/* =========================================================
   STORAGE — тънък wrapper над localStorage вместо localStorage.get/setItem
   пръснато на 35+ места из целия файл. Всеки модул по-долу (AppState, Keys,
   ModelPref, AICallLog, QuotaTracker, AICache, Prefs, TrackRecord...) минава
   през него. Ползи:
     - JSON.parse/stringify + try/catch на ЕДНО място, не преповторени 20 пъти
     - Ако утре решим да сменим localStorage с нещо друго (IndexedDB, remote
       sync и т.н.), пипаме само тук, не 35 различни функции.
   .get/.set работят с произволни JS стойности (обект/масив/число) — сами
   правят JSON сериализация. .getRaw/.setRaw са за чисто текстови флагове
   (напр. "1"/"0"), където JSON би бил излишен overhead (виж Vault).
   ========================================================= */
const Storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn(`Storage.get: счупени данни за "${key}", връщам fallback.`, e);
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      // QuotaExceededError (диск пълен) — вместо направо да се откажем,
      // опитваме ЕДНОКРАТНО автоматично възстановяване: AppLog (js/app-log.js)
      // е най-вероятният "тих" консуматор на място с течение на времето
      // (виж бележката там за _MAX_LINES_PER_GROUP) — принудително го
      // подрязваме и пробваме записа още веднъж. Ако AppLog не е зареден
      // още (ред на <script> таговете) или пак не стигне, се предаваме
      // както преди — просто с по-ясно съобщение защо точно.
      const isQuota = e.name === "QuotaExceededError" || e.code === 22;
      if (isQuota && typeof AppLog !== "undefined" && key !== AppLog._KEY) {
        try {
          AppLog._save({}); // спешно пълно изчистване, не само подрязване — приоритет е основният запис да мине
          localStorage.setItem(key, JSON.stringify(value));
          console.warn(`Storage.set: localStorage беше пълен — изчистих логовете (AppLog) и записът за "${key}" мина при повторен опит.`);
          return true;
        } catch (e2) { /* и след почистване пак не стигна — предай се долу */ }
      }
      console.warn(`Storage.set: неуспешен запис за "${key}" ${isQuota ? "(localStorage е ПЪЛЕН — почисти данни от Настройки)" : "(диск пълен?)"}.`, e);
      return false;
    }
  },
  remove(key) { localStorage.removeItem(key); },
  has(key) { return localStorage.getItem(key) !== null; },

  getRaw(key, fallback = null) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  },
  setRaw(key, value) { localStorage.setItem(key, value); }
};

/* =========================================================
   VAULT — опционално криптиране на API ключовете "at rest" в
   localStorage с парола (Web Crypto: PBKDF2 → AES-GCM). ИЗКЛЮЧЕНО по
   подразбиране — нищо не се променя, ако не го включиш ръчно от Настройки.
   Когато е включено:
     - localStorage пази САМО криптиран blob (сол + IV + ciphertext),
       никога чист текст.
     - Дешифрираните ключове живеят САМО в паметта (RAM) на текущия таб,
       докато не презаредиш/затвориш страницата — тогава пак трябва парола
       ("🔓 Отключи трезора" в Настройки), преди AI/GitHub функциите да
       проработят отново.
     - Самата парола НИКЪДЕ не се пази — само изведеният от нея AES ключ
       стои в паметта (не може да се прочете обратно), докато е отключен.
   Това не е военна сигурност (клиентски JS все пак може да бъде инспектиран
   в момента на употреба), но е сериозно по-добре от чист текст на диска.
   ========================================================= */
const VAULT_ENC_KEY = "cdb_keys_vault_enc_v1";
const VAULT_FLAG_KEY = "cdb_keys_vault_flag_v1";

function _b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function _unb64(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

const Vault = {
  _plain: null,  // дешифрирани ключове — само в паметта, докато е отключен
  _key: null,    // derived CryptoKey — само в паметта, докато е отключен

  isEnabled() { return Storage.getRaw(VAULT_FLAG_KEY) === "1"; },
  isUnlocked() { return this._plain !== null; },

  async _deriveKey(passphrase, saltBytes) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  },

  // Включва трезора: криптира текущите (чист текст) ключове с нова парола,
  // трие чист текст от localStorage завинаги и ги пази оттук нататък само в RAM.
  async enable(passphrase) {
    if (!window.crypto?.subtle) throw new Error("Криптирането изисква HTTPS (или localhost).");
    if (!passphrase || passphrase.length < 6) throw new Error("Паролата трябва да е поне 6 символа.");
    const plain = Keys.load(); // все още чист текст в този момент (Vault не е активен)
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this._deriveKey(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(plain)));
    Storage.set(VAULT_ENC_KEY, { salt: _b64(salt), iv: _b64(iv), data: _b64(ciphertext) });
    Storage.setRaw(VAULT_FLAG_KEY, "1");
    Storage.remove(KEYS_STORAGE); // никога повече чист текст на диска
    this._key = key;
    this._plain = plain;
  },

  // Опитва да отключи с подадена парола за тази сесия/таб; хвърля грешка при грешна парола.
  async unlock(passphrase) {
    const blob = Storage.get(VAULT_ENC_KEY);
    if (!blob) throw new Error("Няма криптирани ключове в този браузър.");
    const salt = _unb64(blob.salt), iv = _unb64(blob.iv), data = _unb64(blob.data);
    const key = await this._deriveKey(passphrase, salt);
    let plainBuf;
    try { plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data); }
    catch (e) { throw new Error("Грешна парола."); }
    const plain = JSON.parse(new TextDecoder().decode(plainBuf));
    this._key = key;
    this._plain = plain;
    return plain;
  },

  // Заключва само RAM копието (криптираният blob на диска остава недокоснат).
  lock() { this._plain = null; this._key = null; },

  // Изключва трезора напълно: изисква парола за проверка, връща ключовете
  // обратно в чист текст в localStorage (поведение отпреди включване на Vault).
  async disable(passphrase) {
    const plain = await this.unlock(passphrase); // хвърля при грешна парола
    Storage.set(KEYS_STORAGE, plain);
    Storage.remove(VAULT_ENC_KEY);
    Storage.remove(VAULT_FLAG_KEY);
    this._plain = null;
    this._key = null;
  },

  // Презаписва криптирания blob със същия (кеширан) ключ — вика се от
  // Keys.save(), когато трезорът е активен и вече отключен в тази сесия.
  async _reencrypt(plain) {
    if (!this._key) return; // заключен — не бива да се стига дотук по нормален път
    const blob = Storage.get(VAULT_ENC_KEY);
    const salt = blob ? _unb64(blob.salt) : crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this._key, new TextEncoder().encode(JSON.stringify(plain)));
    Storage.set(VAULT_ENC_KEY, { salt: _b64(salt), iv: _b64(iv), data: _b64(ciphertext) });
  }
};

const Keys = {
  load() {
    if (Vault.isEnabled()) return Vault._plain ? { ...Vault._plain } : {};
    return Storage.get(KEYS_STORAGE) || {};
  },
  save(obj) {
    if (Vault.isEnabled()) {
      Vault._plain = obj;
      Vault._reencrypt(obj); // async, "fire and forget" — RAM копието е вярно веднага
      return;
    }
    Storage.set(KEYS_STORAGE, obj);
  }
};
