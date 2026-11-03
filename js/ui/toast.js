/* =========================================================
   UI: TOAST — извадено от app.js (архитектурен рефакторинг, точка 5:
   ui/). Малко, чисто DOM helper-че — без зависимости от Keys/network/
   providers, затова може да се зареди най-рано от всички <script>
   тагове в index.html (преди network.js дори), без значение за реда.

   Бъдещи UI helper-и (modal/dialog, loader, menu) би трябвало да
   живеят в съседни файлове тук — js/ui/dialog.js, js/ui/loader.js,
   js/ui/menu.js — по същия принцип: чист DOM, никаква бизнес логика.
   ========================================================= */
function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.style.display = "none"), ms);
}
