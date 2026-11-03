/* =========================================================
   UI BOOTSTRAP — restoreUI() + updateVaultBanner()
   Двете функции, които хидратират екрана веднага след зареждане:
   restoreUI() връща запазените полета/резултати от AppState (F5
   вече не губи прогреса), updateVaultBanner() показва/скрива
   лентата "🔒 Ключовете са заключени" горе на екрана.

   Преместени 1:1 от app.js (тринадесета итерация — завършва
   модулизацията на app.js докрай) — логиката не е променена.
   Зависимости (всички runtime, значи редът на <script> таговете
   не е критичен):
   restoreUI(): AppState, ViralLab.
   updateVaultBanner(): Vault.
   Извикват се от window.addEventListener("DOMContentLoaded") в
   app.js (единственото място, което ги ползва — app.js вече е само
   bootstrap "лепило").
   ========================================================= */

/* =========================================================
   RESTORE UI — хидратира екрана от localStorage след презареждане
   Преди това: AppState.save() пазеше всичко, но при F5 полетата
   (заглавие, текст, Viral Report...) оставаха празни, въпреки че
   данните бяха налични. Сега при зареждане екранът се "връща" на
   мястото, където си спрял — без нищо да е загубено.
   ========================================================= */
function restoreUI() {
  const p = AppState.data?.project;
  if (!p) return;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = "block"; };

  setVal("songTitle", p.title);
  setVal("stylePrompt", p.stylePrompt);
  setVal("lyricsOut", p.lyrics);
  if (p.nicheScore != null) setVal("nicheScore", p.nicheScore + "/100");

  if (p.hashtags?.length) {
    const h = document.getElementById("hashtagsOut");
    if (h) h.innerHTML = p.hashtags.map(x => `<span>${x}</span>`).join("");
  }
  if (p.title) { show("conceptCard"); show("albumSprintCard"); }

  if (p.niches?.length) {
    const el = document.getElementById("nicheResults");
    if (el) {
      el.innerHTML = p.niches.map(r => {
        const color = r.score > 75 ? "🟢" : r.score > 50 ? "🟡" : "⚪";
        return `<div class="copy-field"><span>${color} <strong>${r.niche}</strong> — ${r.score}/100<br><span class="muted">${r.reason || ""}</span></span></div>`;
      }).join("");
    }
  }
  if (p.viralReport) ViralLab.render(p.viralReport);
}

// Показва/скрива лентата "🔒 Ключовете са заключени" горе на екрана — вика
// се при зареждане и след всяко действие върху трезора (enable/unlock/lock/disable).
function updateVaultBanner() {
  const el = document.getElementById("vaultBanner");
  if (!el) return;
  el.style.display = (Vault.isEnabled() && !Vault.isUnlocked()) ? "block" : "none";
}
