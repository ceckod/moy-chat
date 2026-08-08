/* =========================================================
   SYSTEM LOG — извадено от app.js (Стъпка 8 от одита: по-нататъшно
   разбиване на app.js по namespace обект, едно на итерация).

   Улавя JS грешки в реално време на сесията (window "error" +
   "unhandledrejection") и ги показва в панела "Системни логове"
   (#systemLogOut, view "infra-logs").

   Зареден е като обикновен classic <script> (НЕ module) ПРЕДИ app.js в
   index.html — SystemLog е чист, самостоятелен namespace: единствената му
   външна връзка е SystemLog.init() (извикан от app.js вътре в
   DOMContentLoaded листенъра) и onclick="SystemLog.clear()" в index.html
   (view "infra-logs") — затова редът в HTML не чупи нищо, по същия принцип
   като останалите вече извадени файлове (network.js, agent-roster.js и
   т.н. — виж бележката в js/providers/claude.js).

   Зависимости: няма (чист DOM + window listeners).

   Публичен интерфейс:
     - SystemLog.init()   — закача се веднъж, извиква се от app.js
     - SystemLog.push()   — вътрешен помощник (error/unhandledrejection listeners)
     - SystemLog.clear()  — бутон "🧹 Изчисти" в index.html
     - SystemLog.render() — прерисува #systemLogOut
   ========================================================= */

const SystemLog = {
  entries: [],
  init() {
    window.addEventListener("error", (e) => {
      this.push("error", `${e.message} (${e.filename}:${e.lineno})`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.push("error", "Unhandled promise rejection: " + (e.reason?.message || e.reason));
    });
    this.push("info", "Системата стартира нормално.");
  },
  push(level, msg) {
    this.entries.unshift({ level, msg, time: new Date().toLocaleTimeString("bg-BG") });
    this.entries = this.entries.slice(0, 50);
    this.render();
  },
  clear() {
    this.entries = [];
    this.render();
  },
  render() {
    const el = document.getElementById("systemLogOut");
    if (!el) return;
    if (!this.entries.length) { el.textContent = "Няма логове в тази сесия."; return; }
    el.innerHTML = this.entries.map(e =>
      `<div style="color:${e.level === 'error' ? 'var(--red)' : 'var(--muted)'};margin-bottom:4px;">[${e.time}] ${e.msg}</div>`).join("");
  }
};
