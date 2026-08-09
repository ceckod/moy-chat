/* =========================================================
   LYRICS HISTORY — версии на текста
   Пази предишните версии (при ново генериране или при "Подобри"
   от ViralLab), за да може да се върнеш назад, ако подобрението
   всъщност не е по-добро.

   Преместен 1:1 от app.js (дванадесета итерация) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво,
   значи редът на <script> таговете не е критичен):
   AppState. Ползва се от Step1 (js/step1.js) и ViralLab
   (js/viral-lab.js) — LyricsHistory.push() — и директно от
   index.html ("🕐 История на версиите" бутон) —
   LyricsHistory.toggle()/.revert().
   ========================================================= */


/* =========================================================
   LYRICS HISTORY — версии на текста
   Пази предишните версии (при ново генериране или при "Подобри"
   от ViralLab), за да може да се върнеш назад, ако подобрението
   всъщност не е по-добро.
   ========================================================= */
const LyricsHistory = {
  push(label) {
    const current = (document.getElementById("lyricsOut")?.value || "").trim();
    if (!current) return;
    const p = AppState.data.project;
    p.lyricsHistory = p.lyricsHistory || [];
    p.lyricsHistory.unshift({ label, text: current, time: new Date().toLocaleTimeString("bg-BG") });
    p.lyricsHistory = p.lyricsHistory.slice(0, 15);
    AppState.save();
  },

  render() {
    const el = document.getElementById("lyricsHistoryOut");
    if (!el) return;
    const hist = AppState.data.project.lyricsHistory || [];
    if (!hist.length) { el.innerHTML = `<p class="muted">Все още няма запазени версии.</p>`; return; }
    el.innerHTML = hist.map((v, i) => `
      <div class="copy-field"><span><strong>${v.label}</strong> <span class="muted">· ${v.time}</span><br>
        <span class="muted">${v.text.slice(0, 90).replace(/\n/g, " ")}${v.text.length > 90 ? "…" : ""}</span></span>
        <button onclick="LyricsHistory.revert(${i})">↩️ Върни</button></div>`).join("");
  },

  toggle() {
    const el = document.getElementById("lyricsHistoryOut");
    if (!el) return;
    const showing = el.style.display !== "none";
    if (showing) { el.style.display = "none"; return; }
    el.style.display = "block";
    this.render();
  },

  revert(i) {
    const hist = AppState.data.project.lyricsHistory || [];
    const v = hist[i];
    if (!v) return;
    this.push("Преди връщане назад");
    document.getElementById("lyricsOut").value = v.text;
    AppState.data.project.lyrics = v.text;
    AppState.save();
    toast(`Върнато към версия "${v.label}"`);
    this.render();
  }
};
