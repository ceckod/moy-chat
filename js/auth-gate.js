/* =========================================================
   AUTH GATE — по избор "екран за поверителност" пред целия dashboard.

   ВАЖНО — честно за какво реално защитава (моля прочети, преди да
   разчиташ на това):
     - Това е ЧИСТО клиентска проверка (JS + localStorage), няма сървър,
       който да я налага. Спира случаен поглед (някой за момент вдига
       телефона/лаптопа ти) — НЕ спира технически грамотен човек с
       достъп до DevTools: той може директно да изтрие localStorage
       ключа или да редактира CSS класа на <html> и да влезе.
     - Паролата НИКЪДЕ не се пази в чист вид — само PBKDF2 hash (същия
       принцип като Vault-а по-горе в app.js), сравняван при отключване.
     - НЯМА бутон "забравена парола" в самия lock screen — това е
       НАРОЧНО решение, не пропуск: бутон, който байпасва паролата без
       да я знаеш, би направил цялата защита безсмислена за всеки друг,
       който я натисне. Ако забравиш паролата си:
         1. Отвори DevTools конзолата на страницата (F12 → Console)
         2. Изпълни: localStorage.removeItem('cdb_auth_gate_hash_v1')
         3. Презареди страницата
       Данните ти НЕ се трият — трие се само самата ключалка.

   Зависи от app.js (глобалните _b64/_unb64 helper-и, дефинирани до Vault),
   toast() от js/ui/toast.js. Зареден СЛЕД app.js в index.html.
   ========================================================= */

const AUTH_GATE_HASH_KEY = "cdb_auth_gate_hash_v1";
const AUTH_GATE_SESSION_KEY = "cdb_auth_gate_unlocked_v1";

const AuthGate = {
  isEnabled() {
    try { return !!localStorage.getItem(AUTH_GATE_HASH_KEY); } catch (e) { return false; }
  },

  async _hash(password, saltB64) {
    if (!window.crypto?.subtle) throw new Error("Изисква HTTPS (или localhost)");
    const salt = saltB64 ? _unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, baseKey, 256);
    return { saltB64: _b64(salt), hashB64: _b64(bits) };
  },

  // Задава нова парола (от Настройки — виж Settings.authGateSetup()).
  async setup(password) {
    if (!password || password.length < 4) throw new Error("Паролата трябва да е поне 4 символа");
    const { saltB64, hashB64 } = await this._hash(password);
    localStorage.setItem(AUTH_GATE_HASH_KEY, JSON.stringify({ salt: saltB64, hash: hashB64 }));
    // Текущата сесия остава отключена — новата парола важи от СЛЕДВАЩОТО
    // отваряне/презареждане (за да не се самозаключиш веднага след настройка).
    sessionStorage.setItem(AUTH_GATE_SESSION_KEY, "1");
    document.documentElement.classList.add("gate-unlocked");
  },

  // Вика се от бутона на самия lock screen (overlay).
  async unlock() {
    const p = document.getElementById("authGateUnlockPass")?.value || "";
    const errEl = document.getElementById("authGateError");
    if (errEl) errEl.textContent = "";
    try {
      const raw = localStorage.getItem(AUTH_GATE_HASH_KEY);
      if (!raw) { document.documentElement.classList.add("gate-unlocked"); return; } // защитата вече е изключена
      const { salt, hash } = JSON.parse(raw);
      const { hashB64 } = await this._hash(p, salt);
      if (hashB64 === hash) {
        sessionStorage.setItem(AUTH_GATE_SESSION_KEY, "1");
        document.documentElement.classList.add("gate-unlocked");
      } else if (errEl) {
        errEl.textContent = "❌ Грешна парола.";
      }
    } catch (e) {
      if (errEl) errEl.textContent = "❌ " + e.message;
    }
  },

  // Заключва ВЕДНАГА (за споделени компютри) — не чака затваряне на таба.
  lockNow() {
    sessionStorage.removeItem(AUTH_GATE_SESSION_KEY);
    document.documentElement.classList.remove("gate-unlocked");
  },

  // Изключва защитата напълно — изисква текущата парола за проверка
  // (различно от "забравена парола" сценария по-горе, тук пазим намерение).
  async disable(password) {
    const raw = localStorage.getItem(AUTH_GATE_HASH_KEY);
    if (!raw) return;
    const { salt, hash } = JSON.parse(raw);
    const { hashB64 } = await this._hash(password, salt);
    if (hashB64 !== hash) throw new Error("Грешна парола");
    localStorage.removeItem(AUTH_GATE_HASH_KEY);
    sessionStorage.removeItem(AUTH_GATE_SESSION_KEY);
  }
};
