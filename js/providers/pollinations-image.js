/* =========================================================
   PROVIDER: POLLINATIONS IMAGE — безплатна генерация на изображения,
   БЕЗ никакъв API ключ (image.pollinations.ai). Ползва се навсякъде в
   таблото, където е нужна снимка/обложка, като gratis fallback (или
   директен избор) пред платени модели (Gemini/Imagen).

   Endpoint-ът връща директно PNG/JPEG байтове на GET заявка към
   /prompt/<encoded prompt> — няма нужда от POST/JSON тяло, затова
   резултатът тук е директно готов URL, който може да се сложи в
   <img src="...">, без fetch/base64 стъпка (по-бързо, по-малко CORS
   риск). "seed" се рандомизира на всяко извикване, за да не получава
   потребителят винаги едно и също изображение за еднакъв промпт.

   Публичен интерфейс:
     - pollinationsImageUrl(prompt, opts) → връща (веднага) готов image URL
     - pollinationsImageUrlAsync(prompt, opts) → await-ва реалното
       изтегляне (полезно, ако искаш да хванеш грешка/timeout ПРЕДИ да
       покажеш <img>, вместо да разчиташ на браузърния onerror)
   ========================================================= */

const POLLINATIONS_IMAGE_BASE = "https://image.pollinations.ai/prompt/";

// Синхронен вариант — просто конструира URL-а. Достатъчно е за директно
// <img src="...">, защото самият Pollinations endpoint генерира при заявка
// (не изисква предварителен POST). width/height по подразбиране 1024x1024
// (квадратна обложка); nologo=true маха водния знак.
function pollinationsImageUrl(prompt, opts = {}) {
  const { width = 1024, height = 1024, seed = Math.floor(Math.random() * 1e9), model = "flux" } = opts;
  const encoded = encodeURIComponent(prompt.slice(0, 2000)); // endpoint-ът има практичен лимит на дължина
  return `${POLLINATIONS_IMAGE_BASE}${encoded}?width=${width}&height=${height}&seed=${seed}&model=${model}&nologo=true`;
}

// Асинхронен вариант — реално изтегля изображението и го връща като
// data: URL, за да можем да хванем HTTP/мрежова грешка ПРЕДИ да опитаме
// да покажем <img> (и за да можем да го запазим в AppState като base64,
// същия формат, който вече очаква Step3 от Gemini/Imagen пътя).
//
// 429 (Too Many Requests) — Pollinations е напълно безплатен, БЕЗ ключ,
// затова споделя rate limit между ВСИЧКИ анонимни потребители в момента
// (не само теб) — при пиков трафик лесно се стига до 429 дори при първи
// опит. Затова тук автоматично се пробва до 3 пъти с нарастващо изчакване
// (2s → 5s → 10s), преди да върнем грешка на потребителя.
async function pollinationsImageUrlAsync(prompt, opts = {}) {
  const delays = [0, 2000, 5000]; // 1-ви опит веднага, после 2s, после 5s изчакване
  let lastErr = null;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));

    // нов seed на всеки опит — на много Pollinations инстанции повторен
    // идентичен URL/seed по-лесно уцелва кеш/rate-limit блокировка на
    // ниво CDN, различен seed заобикаля това
    const url = pollinationsImageUrl(prompt, { ...opts, seed: Math.floor(Math.random() * 1e9) });
    try {
      const res = await fetchTimeout(proxied(url), {}, 60000); // генерацията отнема по-дълго
      if (res.status === 429) {
        lastErr = new Error("Pollinations е претоварен точно сега (HTTP 429 — твърде много заявки от всички потребители).");
        continue; // пробвай пак след изчакването
      }
      if (!res.ok) throw new Error(`Pollinations image HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob || !blob.type.startsWith("image/")) throw new Error("Pollinations не върна изображение (може да е претоварен — опитай пак)");
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result); // вече е "data:image/...;base64,..."
        reader.onerror = () => reject(new Error("Неуспешно четене на изображението"));
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error((lastErr?.message || "Pollinations грешка") + " — пробвах 3 пъти. Изчакай ~30 сек и натисни бутона отново.");
}
