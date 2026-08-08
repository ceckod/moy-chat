/* =========================================================
   AUTH GATE — по избор "екран за поверителност" пред целия dashboard.

   ВАЖНО — честно за какво реално защитава (моля прочети, преди да
   разчиташ на това):
     - Това е ЧИСТО клиентска проверка (JS + localStorage), няма сървър,
       който да я налага. Спира случаен поглед (някой за момент вдига
       телефона/лаптопа ти) — НЕ спира технически грамотен човек с
       достъп до DevTools: той може директно да изтрие localStorage
       ключа или да редактира CSS класа на <html> и да влезе.
     - Пита ПОТРЕБИТЕЛ + ПАРОЛА. Потребителското име се пази в чист
       текст в localStorage (само етикет, не тайна) — реалната проверка
       е PBKDF2 hash на "потребител::парола" заедно (същия принцип като
       Vault-а по-горе в app.js), сравняван при отключване. Паролата
       НИКЪДЕ не се пази в чист вид.
     - НЯМА бутон "забравена парола" в самия lock screen — това е
       НАРОЧНО решение, не пропуск: бутон, който байпасва логина без
       да го знаеш, би направил цялата защита безсмислена за всеки друг,
       който я натисне. Ако забравиш логина си:
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

  // Връща запазеното потребителско име (само за показване в Настройки —
  // НЕ е тайна, само етикет; реалната проверка е върху хеша по-долу).
  getUsername() {
    try {
      const raw = localStorage.getItem(AUTH_GATE_HASH_KEY);
      return raw ? (JSON.parse(raw).username || "") : "";
    } catch (e) { return ""; }
  },

  // Хешираме "потребител::парола" заедно, за да не могат двете полета
  // да се проверяват поотделно (напр. правилно потребителско име +
  // произволна парола не трябва да върне частичен успех).
  async _hash(username, password, saltB64) {
    if (!window.crypto?.subtle) throw new Error("Изисква HTTPS (или localhost)");
    const salt = saltB64 ? _unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const enc = new TextEncoder();
    const combined = `${username}::${password}`;
    const baseKey = await crypto.subtle.importKey("raw", enc.encode(combined), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, baseKey, 256);
    return { saltB64: _b64(salt), hashB64: _b64(bits) };
  },

  // Задава нов потребител+парола (от Настройки — виж Settings.authGateSetup()).
  async setup(username, password) {
    if (!username || !username.trim()) throw new Error("Въведи потребителско име");
    if (!password || password.length < 4) throw new Error("Паролата трябва да е поне 4 символа");
    const uname = username.trim();
    const { saltB64, hashB64 } = await this._hash(uname, password);
    localStorage.setItem(AUTH_GATE_HASH_KEY, JSON.stringify({ username: uname, salt: saltB64, hash: hashB64 }));
    // Текущата сесия остава отключена — новата парола важи от СЛЕДВАЩОТО
    // отваряне/презареждане (за да не се самозаключиш веднага след настройка).
    sessionStorage.setItem(AUTH_GATE_SESSION_KEY, "1");
    document.documentElement.classList.add("gate-unlocked");
  },

  // Вика се от бутона на самия lock screen (overlay).
  async unlock() {
    const u = document.getElementById("authGateUnlockUser")?.value || "";
    const p = document.getElementById("authGateUnlockPass")?.value || "";
    const errEl = document.getElementById("authGateError");
    if (errEl) errEl.textContent = "";
    try {
      const raw = localStorage.getItem(AUTH_GATE_HASH_KEY);
      if (!raw) { document.documentElement.classList.add("gate-unlocked"); return; } // защитата вече е изключена
      const { username, salt, hash } = JSON.parse(raw);
      if ((u || "").trim() !== (username || "")) { if (errEl) errEl.textContent = "❌ Грешен потребител или парола."; return; }
      const { hashB64 } = await this._hash(u.trim(), p, salt);
      if (hashB64 === hash) {
        sessionStorage.setItem(AUTH_GATE_SESSION_KEY, "1");
        document.documentElement.classList.add("gate-unlocked");
      } else if (errEl) {
        errEl.textContent = "❌ Грешен потребител или парола.";
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

  // Изключва защитата напълно — изисква текущия потребител+парола за
  // проверка (различно от "забравена парола" сценария по-горе, тук пазим
  // намерение — само собственикът на текущата парола може да я изключи).
  async disable(username, password) {
    const raw = localStorage.getItem(AUTH_GATE_HASH_KEY);
    if (!raw) return;
    const { username: storedUser, salt, hash } = JSON.parse(raw);
    if ((username || "").trim() !== (storedUser || "")) throw new Error("Грешен потребител или парола");
    const { hashB64 } = await this._hash((username || "").trim(), password, salt);
    if (hashB64 !== hash) throw new Error("Грешен потребител или парола");
    localStorage.removeItem(AUTH_GATE_HASH_KEY);
    sessionStorage.removeItem(AUTH_GATE_SESSION_KEY);
  }
};
