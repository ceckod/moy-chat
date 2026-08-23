/* =========================================================
   AGENT REGISTRY — единен, разширяем списък от AI "агенти" за чат
   секцията (виж js/ai-chat.js). Всеки запис описва:
     - id/name/icon         — визуално
     - keyField/extraKeyField — кое(и) полета в Keys.load() трябва да
                                са попълнени, за да е "наличен" агентът
                                (null = винаги наличен, без ключ)
     - capabilities          — какво РЕАЛНО поддържа агентът точно
                                сега (текст / прикачени снимки / PDF /
                                генериране на снимка)
     - about                 — кратко описание за потребителя
     - send(prompt, atts)    — реалното извикване; ВИНАГИ връща
                                { text, model } или { imageUrl } —
                                model е РЕАЛНОТО име на конкретния
                                модел, който е отговорил (виж
                                getLastAgentAnswer() в fallback-loop.js)
                                — показва се в чата вместо само общото
                                име на агента.

   ВАЖНО: всеки запис тук говори САМО с посочения доставчик — никога не
   прескача към друга компания при грешка (напр. избереш ли Mistral,
   получаваш отговор от Mistral или ясна грешка, никога тихо от Groq).
   Единствената "верига" вътре е между МОДЕЛИТЕ на СЪЩИЯ доставчик
   (напр. Claude пробва няколко свои модела, Groq — няколко свои).

   Бивша обединена точка "AI Model Finder" (Groq+Mistral+GitHub Models+
   Cloudflare слети в едно) е нарочно РАЗДЕЛЕНА тук на 4 отделни агента —
   точно за да можеш да избереш конкретно кой да ти отговори, вместо да
   гадаеш кой реално се е обадил зад общото име.

   ВАЖНО за бъдещи агенти: добавянето на СЪВСЕМ НОВ доставчик винаги ще
   изисква малко реален код за самото API извикване (различни доставчици
   говорят различни протоколи) — регистърът прави превключването/UI-то
   автоматично, но не измисля API-то на доставчика вместо теб.

   Зависи от: Keys (storage.js), callClaude (providers/claude.js),
   callGeminiChat (providers/gemini.js), callOpenRouter
   (providers/openrouter.js), callModelFinderSource (providers/model-finder.js),
   cloudflareImageAsync (providers/cloudflare-image.js),
   getLastAgentAnswer (providers/fallback-loop.js) — всички викани само
   ВЪТРЕ във функции, затова редът на <script> таговете не е критичен.
   ========================================================= */

const AGENT_REGISTRY = [
  {
    id: "claude",
    name: "Claude",
    icon: "🟣",
    keyField: "claude",
    capabilities: { text: true, images: true, pdf: true, imageGen: false },
    about: "Разговор, анализ, код, по-дълъг текст. Разбира прикачени снимки и PDF файлове (не генерира нови снимки).",
    async send(prompt, attachments) {
      const text = await callClaude(prompt, 1600, attachments);
      return { text, model: getLastAgentAnswer()?.model };
    }
  },
  {
    id: "gemini",
    name: "Gemini",
    icon: "🔵",
    keyField: "gemini",
    capabilities: { text: true, images: true, pdf: true, imageGen: false },
    about: "Разговор, анализ + достъп до Google Search за актуални резултати. Разбира прикачени снимки и PDF файлове (не генерира нови снимки — за това виж Cloudflare (изображения) по-долу в менюто).",
    async send(prompt, attachments) {
      const text = await callGeminiChat(prompt, attachments, false);
      return { text, model: getLastAgentAnswer()?.model };
    }
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🟠",
    keyField: "openrouterKey",
    capabilities: { text: true, images: true, pdf: false, imageGen: false },
    about: "Безплатни модели от различни доставчици. Избери конкретен модел от менюто вдясно, или остави \"Автоматично\" да пробва сам кой отговаря.",
    // ~50 реални безплатни модела на OpenRouter — потребителят вижда и
    // избира ТОЧНО кой да отговори, вместо да гадае след факта (виж
    // AIChat._renderModelSelect в js/ai-chat.js).
    listModels: async () => getOpenRouterFreeModels(),
    async send(prompt, attachments, model) {
      const text = await callOpenRouter(prompt, 1200, attachments, model || null);
      return { text, model: getLastAgentAnswer()?.model };
    }
  },
  {
    id: "groq",
    name: "Groq",
    icon: "⚡",
    keyField: "groqKey",
    capabilities: { text: true, images: false, pdf: false, imageGen: false },
    about: "Много бърз безплатен текстов агент (Llama/GPT-OSS модели, хоствани от Groq). Не приема прикачени файлове.",
    listModels: async () => ModelFinder.modelsForSource("groq", Keys.load(), 20),
    async send(prompt, attachments, model) {
      const text = await callModelFinderSource("groq", prompt, 1200, model || null);
      return { text, model: getLastAgentAnswer()?.model };
    }
  },
  {
    id: "mistral",
    name: "Mistral AI",
    icon: "🌬️",
    keyField: "mistralKey",
    capabilities: { text: true, images: false, pdf: false, imageGen: false },
    about: "Безплатен текстов агент от Mistral AI. Не приема прикачени файлове.",
    listModels: async () => ModelFinder.modelsForSource("mistral", Keys.load(), 20),
    async send(prompt, attachments, model) {
      const text = await callModelFinderSource("mistral", prompt, 1200, model || null);
      return { text, model: getLastAgentAnswer()?.model };
    }
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    icon: "🧡",
    keyField: "cfApiToken",
    extraKeyField: "cfAccountId",
    capabilities: { text: true, images: false, pdf: false, imageGen: false },
    about: "Безплатен текстов агент през Cloudflare Workers AI. Не приема прикачени файлове.",
    listModels: async () => ModelFinder.modelsForSource("cloudflare", Keys.load(), 20),
    async send(prompt, attachments, model) {
      const text = await callModelFinderSource("cloudflare", prompt, 1200, model || null);
      return { text, model: getLastAgentAnswer()?.model };
    }
  },
  {
    id: "cloudflare-image",
    name: "Cloudflare (изображения)",
    icon: "🎨",
    keyField: "cfApiToken",
    extraKeyField: "cfAccountId",
    capabilities: { text: false, images: false, pdf: false, imageGen: true },
    about: "Единственият агент тук, който РЕАЛНО генерира изображение по описание — безплатно (FLUX, 10 000 neuroni/ден на Cloudflare). Не е чат агент за разговор, пиши какво искаш да видиш.",
    async send(prompt) {
      const k = Keys.load();
      const imageUrl = await cloudflareImageAsync(prompt, {}, k.cfApiToken, k.cfAccountId);
      return { imageUrl, model: "cloudflare-flux" };
    }
  }
];

const AgentRegistry = {
  all() { return AGENT_REGISTRY; },
  get(id) { return AGENT_REGISTRY.find(a => a.id === id) || null; },
  // Само агентите, които РЕАЛНО могат да бъдат ползвани точно сега
  // (имат нужния ключ — и допълнителния, ако изисква такъв — или изобщо
  // не изискват ключ).
  available() {
    const k = Keys.load();
    return AGENT_REGISTRY.filter(a => this.hasKey(a, k));
  },
  hasKey(agent, k) {
    k = k || Keys.load();
    if (agent.keyField && !k[agent.keyField]) return false;
    if (agent.extraKeyField && !k[agent.extraKeyField]) return false;
    return true;
  }
};
