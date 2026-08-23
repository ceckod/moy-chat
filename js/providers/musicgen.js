/* =========================================================
   PROVIDER: MUSICGEN (Meta) през Hugging Face Inference API —
   ЕДИНСТВЕНИЯТ РЕАЛНО БЕЗПЛАТЕН text-to-music път, който намерихме
   (Google Lyria 3 генерира по-добро качество, НО няма безплатен tier —
   $0.04-0.08 на песен, затова НЕ е включен тук).

   Ограничения (реални, не ги крий от потребителя в UI):
     - Само инструментал (без вокали/текст)
     - Кратки клипове (~8-30 сек)
     - Безплатният HF Inference API има rate limits и "студен старт"
       (моделът може да отнеме 20-60 сек да "събуди" при първа заявка —
       връща 503 с estimated_time, тогава просто пробваме пак)

   ЗАБЕЛЕЖКА (2026-08-23): старият api-inference.huggingface.co домейн е
   ОКОНЧАТЕЛНО спрян от Hugging Face — заменен от router.huggingface.co
   (виж huggingface.co/docs/inference-providers). Извикване към стария
   домейн вече не връща обичайна HTTP грешка, а странна HTTP 530 (Cloudflare
   ниво — старият домейн вече не сочи никъде), затова е лесно объркващо.
   Пътят по-долу е обновен на новия router — форматът на заявката/отговора
   е същият (POST {inputs: prompt} → аудио байтове директно).

   Нужен ключ: hfApiKey — безплатен акаунт+токен от
   https://huggingface.co/settings/tokens (роля "Read" стига)

   Публичен интерфейс:
     - musicGenAsync(prompt, hfApiKey, opts) → await-ва
       data:audio/...;base64,... URL (готов за <audio src="...">)
   ========================================================= */

const MUSICGEN_MODEL = "facebook/musicgen-small";
const MUSICGEN_URL = `https://router.huggingface.co/hf-inference/models/${MUSICGEN_MODEL}`;

async function musicGenAsync(prompt, hfApiKey, opts = {}) {
  if (!hfApiKey) {
    throw new Error("Нужен е безплатен Hugging Face API токен (Настройки → AI Model Finder → Ключове) — huggingface.co/settings/tokens.");
  }
  const { maxRetries = 4 } = opts;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetchTimeout(proxied(MUSICGEN_URL), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${hfApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: prompt.slice(0, 500) })
    }, 90000); // генерацията на аудио отнема по-дълго от текст/снимка

    const contentType = res.headers.get("content-type") || "";

    if (res.ok && contentType.startsWith("audio/")) {
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Неуспешно четене на аудиото"));
        reader.readAsDataURL(blob);
      });
    }

    // Моделът "спи" (безплатната инфраструктура го стартира при първо
    // повикване) — HF връща 503 + estimated_time (сек), изчакваме точно
    // толкова (капнато на 20с) и пробваме пак, вместо да гърмим веднага.
    if (res.status === 503) {
      const data = await res.json().catch(() => null);
      const wait = Math.min(Math.ceil((data?.estimated_time || 15) * 1000), 20000);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }

    const errText = await res.text().catch(() => "");
    // 530/404 от router-а обикновено значи, че facebook/musicgen-small
    // няма активен Inference Provider точно в момента (HF мигрираха от
    // "винаги наличен безплатен сървър" към провайдър-базиран модел през
    // 2025-2026) — казваме го ясно, вместо просто "HTTP 530".
    if (res.status === 530 || res.status === 404) {
      throw new Error(`MusicGen HTTP ${res.status}: моделът в момента няма активен безплатен Inference Provider на Hugging Face — пробвай пак по-късно, или провери huggingface.co/facebook/musicgen-small дали моделът все още поддържа "Inference Providers" безплатно.`);
    }
    throw new Error(`MusicGen HTTP ${res.status}${errText ? ": " + errText.slice(0, 200) : ""}`);
  }

  throw new Error("MusicGen: моделът не отговори след няколко опита (безплатната опашка може да е претоварена — пробвай пак след малко).");
}
