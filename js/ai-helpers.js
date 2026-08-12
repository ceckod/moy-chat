/* =========================================================
   AI HELPERS — callAI() (единна точка за генериране на съдържание,
   с fallback между Claude/Gemini/OpenRouter/ModelFinder),
   fileToBase64() и extractJson()

   Преместени 1:1 от app.js (тринадесета итерация — завършва
   модулизацията на app.js докрай) — логиката не е променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво,
   значи редът на <script> таговете не е критичен):
   Keys, Prefs, AIProviderOrder, callClaude(), callGemini(),
   callOpenRouter(), callModelFinder(), toast() (за callAI);
   няма зависимости за fileToBase64()/extractJson().
   Ползва се от: Step1, Step2, Step3, QuickUpload, ViralLab
   (callAI + extractJson), QuickUpload (fileToBase64), и от
   window.addEventListener("DOMContentLoaded") в app.js (индиректно,
   през модулите по-горе).
   ========================================================= */

/* =========================================================
   API HELPERS
   (fetchTimeout и proxied вече живеят в js/network.js — виж index.html)
   ========================================================= */

/* =========================================================
   CALL AI — единна точка за генериране на съдържание (Стъпка 1-3 и
   навсякъде другаде, където е нужен AI — Niche Toolkit, System Test и т.н.).

   Реда, в който се пробват Claude / Gemini / OpenRouter, идва от
   AIProviderOrder (виж по-горе) — попълва се автоматично от "🧪 Тествай
   ключовете": кои реално отговориха при теста, в тестовия им ред. Ако
   потребителят е избрал ръчно конкретен provider (Настройки →
   Предпочитания → "AI за генериране на съдържание"), той просто отива
   най-отпред, останалите пак стоят като fallback.

   Ако провайдър гръмне грешка (изчерпана квота, невалиден ключ и т.н.),
   автоматично пада на следващия в реда, вместо да чупи целия flow — с
   ясен toast, за да знае потребителят кой реално е генерирал резултата.
   Хвърля грешка само ако НИТО ЕДИН зареден provider не отговори.

   ЗАБЕЛЕЖКА: Gemini Validator-ът (autoReview и т.н.) НЕ минава през
   тази функция — той нарочно винаги е Gemini, като "втори, независим
   поглед" върху резултата, дори когато Gemini е и основният генератор.
   ========================================================= */
async function callAI(prompt, maxTokens = 1200, forceFirst = null) {
  const k = Keys.load();
  const hasKey = { claude: !!k.claude, gemini: !!k.gemini, openrouter: !!k.openrouterKey, modelfinder: true };
  const run = { claude: () => callClaude(prompt, maxTokens), gemini: () => callGemini(prompt), openrouter: () => callOpenRouter(prompt, maxTokens), modelfinder: () => callModelFinder(prompt, maxTokens) };

  // Ръчният избор (ако не е "auto") отива първи; после следва редът от
  // последния реален тест; накрая всеки provider с ключ, който по някаква
  // причина липсва от горните (напр. ключ, добавен след последния тест).
  // "modelfinder" (AI Model Finder — Groq/Mistral/GitHub Models/Cloudflare/
  // Pollinations) винаги стои в самия край на списъка по подразбиране —
  // Pollinations работи без никакъв ключ, така че таблото има работещ AI
  // път дори с нулева конфигурация, докато основните 3 провайдъра не бъдат
  // настроени. testKeys() може да го избута напред, ако РЕАЛНО е по-надежден.
  //
  // forceFirst — по избор (напр. "claude"), за конкретни извиквания, където
  // качеството на самия текст е критично (напр. текст на песен — искаме
  // най-естествения резултат, независимо от последния тест на ключовете).
  // Все пак минава през целия fallback синджир, ако forceFirst провайдърът
  // няма ключ или гръмне грешка — просто заема първо място, не изключва
  // останалите.
  const manual = Prefs.data.contentProvider && Prefs.data.contentProvider !== "auto" ? Prefs.data.contentProvider : null;
  const order = [];
  const seen = new Set();
  for (const p of [forceFirst, manual, ...AIProviderOrder.get(), "claude", "gemini", "openrouter", "modelfinder"]) {
    if (!p || seen.has(p) || !hasKey[p]) continue;
    seen.add(p);
    order.push(p);
  }

  if (!order.length) throw new Error("Няма нито един зареден AI ключ (Claude/Gemini/OpenRouter) — виж Настройки → API Ключове.");

  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    try {
      return await run[order[i]]();
    } catch (e) {
      lastErr = e;
      if (i < order.length - 1) {
        toast(`⚠️ ${AIProviderOrder.label(order[i])} гръмна (${e.message}) — превключвам на ${AIProviderOrder.label(order[i + 1])}...`, 4000);
      }
    }
  }
  throw lastErr;
}

// Превръща File/Blob в base64 текст (без "data:...;base64," префикса) — нужно за inline_data.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Неуспешно четене на файла"));
    reader.readAsDataURL(file);
  });
}

// Извлича първия валиден JSON блок (масив или обект) от текст, дори ако
// моделът е добавил коментари/цитати около него (случва се с grounded search).
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "");
  const startArr = cleaned.indexOf("[");
  const startObj = cleaned.indexOf("{");
  let start = -1, isArr = false;
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) { start = startArr; isArr = true; }
  else if (startObj !== -1) { start = startObj; isArr = false; }
  if (start === -1) throw new Error("Няма JSON в отговора на модела");
  const end = isArr ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (end === -1 || end < start) throw new Error("Непълен JSON в отговора на модела");
  return JSON.parse(cleaned.slice(start, end + 1));
}
