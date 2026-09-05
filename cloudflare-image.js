/* =========================================================
   PROVIDER: CLOUDFLARE WORKERS AI — IMAGE — безплатна генерация на
   изображения (FLUX-1-schnell), 10 000 neuroni/ден безплатно на
   Cloudflare акаунт. Замества предишния Pollinations провайдър
   (махнат — нестабилно/споделено качество без ключ).

   Нужни ключове (вече в Settings → AI Model Finder → Ключове):
     - cfApiToken   (Bearer токен, dash.cloudflare.com/profile/api-tokens)
     - cfAccountId  (Account ID от Cloudflare dashboard)

   Публичен интерфейс:
     - cloudflareImageAsync(prompt, opts, cfApiToken, cfAccountId)
       → await-ва data:image/...;base64,... URL (готов за <img src="...">)
   ========================================================= */

const CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

async function cloudflareImageAsync(prompt, opts = {}, cfApiToken, cfAccountId) {
  if (!cfApiToken || !cfAccountId) {
    throw new Error("Нужни са Cloudflare API Token + Account ID (Настройки → AI Model Finder → Ключове, безплатни).");
  }
  const { width = 1024, height = 1024, steps = 4 } = opts;
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;

  const res = await fetchTimeout(proxied(url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfApiToken}` },
    body: JSON.stringify({ prompt: prompt.slice(0, 2000), width, height, num_steps: steps })
  }, 60000);

  const contentType = res.headers.get("content-type") || "";

  // FLUX-1-schnell през Workers AI връща или директно image/* байтове,
  // или JSON { result: { image: "<base64 без data: префикс>" } } —
  // зависи от версията на API-то, затова проверяваме и двата пътя.
  if (contentType.startsWith("image/")) {
    if (!res.ok) throw new Error(`Cloudflare image HTTP ${res.status}`);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Неуспешно четене на изображението"));
      reader.readAsDataURL(blob);
    });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success === false) {
    const errMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  const b64 = data.result?.image;
  if (!b64) throw new Error("Cloudflare не върна изображение в отговора.");
  return `data:image/png;base64,${b64}`;
}

/* ---------- ГЕНЕРИРАНЕ НА ЛОКАЛЕН PLACEHOLDER (последна резерва) ----------
   Чист SVG, генериран моментално в браузъра — БЕЗ мрежа, никога не може
   да гръмне. Ползва се само ако И Cloudflare, И Pollinations паднат
   (напр. изчерпана дневна Cloudflare квота + Pollinations претоварен) —
   така потребителят вижда ясно означен placeholder вместо счупена
   <img>/зависнал spinner, и може да продължи работа (напр. да опита пак
   по-късно), вместо целият flow (напр. Song Lab → Step 3) да блокира. */
function _localImagePlaceholder(prompt, opts = {}) {
  const { width = 1024, height = 1024 } = opts;
  const label = (prompt || "").slice(0, 60).replace(/[<>&]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#1a1a2e"/>
    <text x="50%" y="46%" fill="#8888aa" font-family="sans-serif" font-size="28" text-anchor="middle">🖼️ Обложката не се генерира</text>
    <text x="50%" y="54%" fill="#666688" font-family="sans-serif" font-size="16" text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/* ---------- КОМБИНИРАН FALLBACK CHAIN: Cloudflare → Pollinations → placeholder ----------
   Препоръчаният вход за нови извиквания (виж js/agent-registry.js,
   js/step3.js) — пробва по ред и НИКОГА не хвърля грешка нагоре, винаги
   връща валиден data: URL (реално изображение, или в най-лошия случай
   локален placeholder), за да не спира UI flow-а. Стария cloudflareImageAsync()
   остава непроменен и достъпен директно за код, който изрично иска само
   Cloudflare (напр. тестове на конкретния ключ).
   onFallback (по избор) — callback(stage, error), за да можеш да покажеш
   toast/лог "⚠️ Cloudflare гръмна, пробвам Pollinations..." в UI-я си. */
async function generateCoverImage(prompt, opts = {}, cfApiToken, cfAccountId, onFallback) {
  if (cfApiToken && cfAccountId) {
    try {
      return await cloudflareImageAsync(prompt, opts, cfApiToken, cfAccountId);
    } catch (e) {
      if (onFallback) onFallback("cloudflare-failed", e);
    }
  }
  try {
    return await pollinationsImageUrlAsync(prompt, opts);
  } catch (e) {
    if (onFallback) onFallback("pollinations-failed", e);
  }
  if (onFallback) onFallback("placeholder", null);
  return _localImagePlaceholder(prompt, opts);
}
