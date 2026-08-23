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
