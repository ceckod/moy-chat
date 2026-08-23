/* =========================================================
   AGENT REGISTRY — единен, разширяем списък от AI "агенти" за новата
   чат секция (виж js/ai-chat.js). Всеки запис описва:
     - id/name/icon         — визуално
     - keyField              — кое поле в Keys.load() трябва да е
                                попълнено, за да е "наличен" агентът
                                (null = винаги наличен, без ключ)
     - capabilities          — какво РЕАЛНО поддържа агентът точно
                                сега (текст / прикачени снимки /
                                прикачени PDF / генериране на снимка)
     - about                 — кратко описание за потребителя (за
                                какво да го ползва), показва се в
                                агент-превключвателя в чата
     - send(prompt, atts)    — реалното извикване; винаги връща или
                                { text } или { imageUrl } (виж
                                js/ai-chat.js/_renderReply)

   ВАЖНО за бъдещи агенти: добавянето на СЪВСЕМ НОВ доставчик (не
   Claude/Gemini/OpenRouter/Model Finder/Pollinations) винаги ще
   изисква малко реален код за самото API извикване (различни
   доставчици говорят различни протоколи) — регистърът прави
   превключването/UI-то автоматично, но не измисля API-то на
   доставчика вместо теб. Затова е отделен файл: нов агент = нов
   запис тук + евентуално нова функция в js/providers/, БЕЗ да се
   пипа js/ai-chat.js или index.html.

   Зависи от: Keys (storage.js), callClaude (providers/claude.js),
   callGeminiChat (providers/gemini.js), callOpenRouter
   (providers/openrouter.js), callModelFinder (providers/model-finder.js),
   pollinationsImageUrl (providers/pollinations-image.js) — всички
   викани само ВЪТРЕ във функции, затова редът на <script> таговете
   не е критичен (виж бележката в providers/claude.js).
   ========================================================= */

const AGENT_REGISTRY = [
  {
    id: "claude",
    name: "Claude",
    icon: "🟣",
    keyField: "claude",
    capabilities: { text: true, images: true, pdf: true, imageGen: false },
    about: "Разговор, анализ, код, по-дълъг текст. Разбира прикачени снимки и PDF файлове.",
    async send(prompt, attachments) {
      const text = await callClaude(prompt, 1600, attachments);
      return { text };
    }
  },
  {
    id: "gemini",
    name: "Gemini",
    icon: "🔵",
    keyField: "gemini",
    capabilities: { text: true, images: true, pdf: true, imageGen: false },
    about: "Разговор, анализ + достъп до Google Search за актуални резултати. Разбира прикачени снимки и PDF файлове.",
    async send(prompt, attachments) {
      const text = await callGeminiChat(prompt, attachments, false);
      return { text };
    }
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🟠",
    keyField: "openrouterKey",
    capabilities: { text: true, images: true, pdf: false, imageGen: false },
    about: "Безплатни модели от различни доставчици. Част от тях разбират прикачени снимки — PDF не се поддържа тук.",
    async send(prompt, attachments) {
      const text = await callOpenRouter(prompt, 1200, attachments);
      return { text };
    }
  },
  {
    id: "modelfinder",
    name: "AI Model Finder",
    icon: "🧠",
    keyField: null, // винаги наличен — вътре пада на безплатен Pollinations текст, ако няма нито един ключ
    capabilities: { text: true, images: false, pdf: false, imageGen: false },
    about: "Резервен текстов агент (Groq/Mistral/GitHub Models/Cloudflare, ако имаш ключове + винаги достъпен безплатен fallback). Не приема прикачени файлове.",
    async send(prompt) {
      const text = await callModelFinder(prompt, 1200);
      return { text };
    }
  },
  {
    id: "pollinations",
    name: "Pollinations",
    icon: "🎨",
    keyField: null, // без ключ
    capabilities: { text: false, images: false, pdf: false, imageGen: true },
    about: "Не е чат агент — превръща описанието ти в готова генерирана снимка, без нужда от ключ. Пиши какво искаш да видиш.",
    async send(prompt) {
      return { imageUrl: pollinationsImageUrl(prompt) };
    }
  }
];

const AgentRegistry = {
  all() { return AGENT_REGISTRY; },
  get(id) { return AGENT_REGISTRY.find(a => a.id === id) || null; },
  // Само агентите, които РЕАЛНО могат да бъдат ползвани точно сега
  // (имат нужния ключ, или изобщо не изискват ключ).
  available() {
    const k = Keys.load();
    return AGENT_REGISTRY.filter(a => !a.keyField || !!k[a.keyField]);
  },
  hasKey(agent, k) {
    k = k || Keys.load();
    return !agent.keyField || !!k[agent.keyField];
  }
};
