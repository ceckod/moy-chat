/* =========================================================
   NETWORK LAYER — извадено от app.js (архитектурен рефакторинг, точка 2:
   network/). Съдържа само двете общи мрежови помощни функции, които
   всички AI/YouTube/GitHub извиквания използват. Зареден е като обикновен
   classic <script> (НЕ module) ПРЕДИ app.js в index.html — така всичко
   тук е достъпно в същия глобален scope, без import/export и без риск да
   счупим стотиците inline onclick="..." хендлъри из index.html.
   ========================================================= */

// fetch с вграден timeout — без това, при лоша/нестабилна мрежа (особено на
// телефон) заявката може да увисне БЕЗКРАЙНО (нито успех, нито грешка), и
// spinner-ът никога не спира.
async function fetchTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Заявката отне повече от ${ms / 1000}с и беше прекратена (провери мрежата)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Ако е зададен Proxy URL в Настройки, минаваме заявките през него (полезно
// при CORS грешки, напр. с някои Imagen endpoint-и). Прокси-то се очаква да
// приема ?target=ORIGINAL_URL и да препраща метод/хедъри/тяло 1:1 към него.
function proxied(url) {
  const k = Keys.load();
  if (!k.proxyUrl) return url;
  return `${k.proxyUrl}?target=${encodeURIComponent(url)}`;
}
