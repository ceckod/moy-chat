/* =========================================================
   AI PROVIDER ORDER — в КАКЪВ РЕД да се пробват Claude/Gemini/OpenRouter
   за ВСЯКО място в приложението, което "иска AI" (виж callAI() по-долу).
   Попълва се автоматично от Settings.testKeys(): провайдърите, които
   РЕАЛНО отговориха при последния тест, отиват най-отпред (в реда, в
   който бяха тествани); тези с ключ, но провалени — след тях; провайдър
   без зареден ключ изобщо не участва. callAI() минава по този ред и при
   грешка на текущия автоматично пробва следващия, вместо да спре дотук.
   Ръчният избор в Настройки → Предпочитания ("AI за генериране на
   съдържание") просто бута избрания provider на ПЪРВО място в тази
   поредица — не я заменя изцяло, за да остане fallback-ът жив.
   ========================================================= */
const AI_PROVIDER_ORDER_KEY = "cdb_ai_provider_order_v1";

const AIProviderOrder = {
  get() {
    try { return Storage.get(AI_PROVIDER_ORDER_KEY) || []; } catch (e) { return []; }
  },
  set(order) { Storage.set(AI_PROVIDER_ORDER_KEY, order); },
  label(p) { return p === "claude" ? "Claude" : p === "gemini" ? "Gemini" : p === "openrouter" ? "OpenRouter" : p === "modelfinder" ? "🧠 AI Model Finder" : p; }
};
