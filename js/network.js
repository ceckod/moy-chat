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
//
// Ако НЕ е зададен собствен Proxy URL, връщаме оригиналния адрес НЕПРОМЕНЕН —
// директна заявка. (Преди тук имаше автоматичен fallback към безплатната
// публична CORS прокси услуга CodeTabs — премахнат на 2026-09-04, защото
// CodeTabs поддържа САМО GET заявки, а Gemini/Claude/OpenRouter извикванията
// през тази функция са POST. Резултатът: всяка AI заявка без ръчно зададен
// Proxy URL мълчаливо увисваше/пропадаше — засегнат бъг "чакам отговор и
// няма такъв" в AI Чат/Gemini и "🤖 Питай AI екипа" в Системния тест.
// Директните POST извиквания към Gemini/Claude/OpenRouter си работят и без
// прокси — Google/Anthropic/OpenRouter поддържат CORS директно от браузъра
// за нормални заявки. Proxy URL остава наличен за случаите, в които
// потребителят РЕАЛНО има нужда от прокси — виж коментара по-горе.)
function proxied(url) {
  const k = Keys.load();
  if (k.proxyUrl) return `${k.proxyUrl}?target=${encodeURIComponent(url)}`;
  return url;
}
