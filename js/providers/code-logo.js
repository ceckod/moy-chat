/* =========================================================
   PROVIDER: CODE LOGO — 3D текстово лого, рендирано изцяло с Canvas
   2D API (extrusion + градиент + bevel highlight + сянка), БЕЗ AI.

   Защо съществува това ДОПЪЛНИТЕЛНО на AI генерирането (Gemini/
   Cloudflare FLUX): дифузионните text-to-image модели (дори платените)
   нямат 100% гаранция да изпишат точен текст четливо и консистентно —
   известно, реално ограничение на технологията, не бъг за оправяне.
   Тук текстът е буквално нарисуван чрез canvas.fillText() — резултатът
   е ГАРАНТИРАНО точно това, което е въведено, всеки път еднакво
   (детерминистично, без случаен seed/randomness).

   Компромисът е обратен: това НЕ е "AI генериран визуален концепт" —
   не може да измисли илюстрация/сцена, само стилизиран текст/wordmark.
   Затова в UI е трета, отделна опция до другите два бутона — потребителят
   избира кое пасва за случая (AI концепт vs. гарантиран точен текст).

   Публичен интерфейс:
     - renderCodeLogo(text, opts) → синхронно връща data:image/png URL
   ========================================================= */

function renderCodeLogo(text, opts = {}) {
  const {
    width = 1024,
    height = 1024,
    subtitle = "",
    baseColor = "#e8b84b",   // основен цвят на предната плоскост на буквите
    depthColor = "#5c3d0a",  // цвят на "дълбочината"/екструзията отзад
    background = "#0b0b0f",  // основен фонов цвят (градиент до черно надолу)
    fontFamily = "Arial Black, Arial, sans-serif"
  } = opts;
  if (!text || !text.trim()) throw new Error("Няма текст за логото");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas не се поддържа в този браузър");

  // --- Фон: вертикален градиент, за да не изглежда плоско-еднообразно ---
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, background);
  bgGrad.addColorStop(1, "#000000");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // --- Автоматично намаляване на шрифта, докато текстът се събере в 85% от ширината ---
  let fontSize = Math.floor(width * 0.16);
  const maxTextWidth = width * 0.85;
  ctx.font = `900 ${fontSize}px ${fontFamily}`;
  while (ctx.measureText(text).width > maxTextWidth && fontSize > 24) {
    fontSize -= 4;
    ctx.font = `900 ${fontSize}px ${fontFamily}`;
  }

  const cx = width / 2;
  const cy = height / 2 - (subtitle ? fontSize * 0.28 : 0);

  // --- 3D екструзия: наслагване на копия назад-напред, всяко леко изместено ---
  // (класическа "extruded text" техника — колкото повече слоеве, толкова
  // по-плътна/дълбока изглежда буквата)
  const depthSteps = Math.max(6, Math.round(fontSize * 0.07));
  ctx.fillStyle = depthColor;
  for (let i = depthSteps; i > 0; i--) {
    ctx.fillText(text, cx + i * 0.7, cy + i * 0.7);
  }

  // --- Предна плоскост: вертикален градиент (светло горе → тъмно долу = обемен вид) + сянка ---
  const textGrad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
  textGrad.addColorStop(0, "#fff6d8");
  textGrad.addColorStop(0.45, baseColor);
  textGrad.addColorStop(1, depthColor);
  ctx.fillStyle = textGrad;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = fontSize * 0.08;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 6;
  ctx.fillText(text, cx, cy);

  // --- Bevel highlight: тънък светъл контур по ръба на буквите (усещане за обла повърхност) ---
  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(1, fontSize * 0.012);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.strokeText(text, cx, cy);

  // --- По избор: подзаглавие (напр. "RECORDS") под основния текст ---
  if (subtitle && subtitle.trim()) {
    const subSize = Math.max(14, Math.floor(fontSize * 0.22));
    ctx.font = `600 ${subSize}px ${fontFamily}`;
    ctx.letterSpacing = `${Math.floor(subSize * 0.25)}px`; // не се поддържа навсякъде, но не гърми ако липсва
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = subSize * 0.15;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.fillText(subtitle.toUpperCase(), cx, cy + fontSize * 0.62);
  }

  return canvas.toDataURL("image/png");
}
