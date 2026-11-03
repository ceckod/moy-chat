/* =========================================================
   PROVIDER: SUBTITLES (Groq Whisper) — автоматична транскрипция на
   аудио → синхронизирани субтитри (.srt), безплатен tier, ползва
   СЪЩИЯ Groq ключ (groqKey), който вече се ползва за текст в AI Model
   Finder (Настройки → API Ключове → Groq). Няма нужда от отделен ключ.

   Groq хоства Whisper (large-v3-turbo) — точен, бърз, с реални
   timestamp-и на сегмент ниво (verbose_json), точно каквото трябва
   за .srt файл. Понеже видеото в "Бърз ъплоуд" се прави ДИРЕКТНО от
   същия аудио файл (визуализаторът просто рендва звука визуално),
   timestamp-ите от транскрипцията са 1:1 синхронизирани с видеото —
   не е нужна отделна синхронизация.

   Публичен интерфейс:
     - callGroqTranscribe(audioFile, opts) → { segments, language, text }
     - segmentsToSrt(segments) → готов .srt текст
   ========================================================= */

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
// turbo = по-бърз/по-евтин (безплатен tier), large-v3 = по-точен резерв,
// ако turbo моделът временно не е наличен на акаунта.
const GROQ_WHISPER_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

// languageCode — по избор ISO 639-1 (напр. "bg", "en") ако вече знаем
// езика на песента (от Gemini анализа в QuickUpload) — подсказва на
// Whisper и подобрява точността/скоростта; ако е null, Whisper сам
// разпознава езика.
async function callGroqTranscribe(audioFile, opts = {}) {
  const k = Keys.load();
  if (!k.groqKey) throw new Error("Нужен е безплатен Groq ключ в Настройки → API Ключове (console.groq.com/keys) за автоматични субтитри.");

  let lastErr = null;
  for (const model of GROQ_WHISPER_MODELS) {
    try {
      return await _transcribeOnce(audioFile, model, k.groqKey, opts.languageCode);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Групе Whisper не отговори");
}

async function _transcribeOnce(audioFile, model, apiKey, languageCode) {
  const form = new FormData();
  form.append("file", audioFile, audioFile.name || "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (languageCode) form.append("language", languageCode);

  const res = await fetchTimeout(proxied(GROQ_TRANSCRIBE_URL), {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` }, // без Content-Type — браузърът сам слага multipart boundary
    body: form
  }, 120000); // транскрипция на цяла песен може да отнеме време

  if (!res.ok) throw new Error(`Groq Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const segments = (data.segments || []).map(s => ({
    start: s.start,
    end: s.end,
    text: (s.text || "").trim()
  })).filter(s => s.text);
  if (!segments.length) throw new Error("Whisper не върна разпознаваем текст (тих/инструментален файл?)");
  return { segments, language: data.language || languageCode || null, text: data.text || "" };
}

/* ---------- .srt форматиране ---------- */

function _srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

// Разбива дълги сегменти (>~90 знака) на 2 реда по най-близкия интервал/
// препинателен знак около средата — по-лесно за четене, докато тече видеото.
function _wrapSegmentText(text) {
  if (text.length <= 90) return text;
  const mid = Math.floor(text.length / 2);
  let splitAt = text.lastIndexOf(" ", mid);
  if (splitAt === -1) splitAt = mid;
  return text.slice(0, splitAt).trim() + "\n" + text.slice(splitAt).trim();
}

function segmentsToSrt(segments) {
  return segments.map((s, i) =>
    `${i + 1}\n${_srtTimestamp(s.start)} --> ${_srtTimestamp(s.end)}\n${_wrapSegmentText(s.text)}\n`
  ).join("\n");
}
