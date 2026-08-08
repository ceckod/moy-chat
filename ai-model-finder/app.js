'use strict';

/* ================= Конфигурация ================= */

// Прокси за произволни сайтове (Cloudflare Worker). Остави празно, ако не го ползваш.
const CUSTOM_PROXY = ''; // напр. 'https://ai-model-finder.име-ти.workers.dev'

// Категории (pipeline tags) в Hugging Face Hub — обхващат "всичко"
const HF_TAGS = [
  'text-generation','text2text-generation','text-classification','token-classification',
  'fill-mask','question-answering','summarization','translation','zero-shot-classification',
  'conversational','feature-extraction','sentence-similarity','reranking',
  'text-to-image','image-to-image','image-to-text','image-classification',
  'image-segmentation','object-detection','mask-generation','depth-estimation',
  'zero-shot-image-classification','zero-shot-object-detection','visual-question-answering',
  'document-question-answering','text-to-video','video-classification',
  'automatic-speech-recognition','text-to-speech','text-to-audio','audio-to-audio',
  'audio-classification','voice-activity-detection','zero-shot-audio-classification',
  'table-question-answering','tabular-classification','tabular-regression',
  'reinforcement-learning','graph-machine-learning','image-feature-extraction'
];

const CATEGORY_LABELS = {
  'text-generation':'LLM / чат','text2text-generation':'Преобразуване на текст',
  'text-classification':'Класификация на текст','token-classification':'NER / токени',
  'fill-mask':'Fill-mask','question-answering':'Въпроси и отговори',
  'summarization':'Резюмиране','translation':'Превод',
  'zero-shot-classification':'Zero-shot класификация','conversational':'Разговорни',
  'feature-extraction':'Embeddings','sentence-similarity':'Семантично сходство',
  'reranking':'Reranking','text-to-image':'Генериране на изображения',
  'image-to-image':'Редактиране на изображения','image-to-text':'Разбиране на изображения',
  'image-classification':'Класификация на изображения','image-segmentation':'Сегментация',
  'object-detection':'Откриване на обекти','mask-generation':'Генериране на маски',
  'depth-estimation':'Оценка на дълбочина','visual-question-answering':'Визуални въпроси',
  'document-question-answering':'Въпроси към документи','text-to-video':'Генериране на видео',
  'video-classification':'Класификация на видео',
  'automatic-speech-recognition':'Разпознаване на реч','text-to-speech':'Текст към реч',
  'text-to-audio':'Генериране на аудио','audio-to-audio':'Аудио към аудио',
  'audio-classification':'Класификация на аудио','voice-activity-detection':'Откриване на глас',
  'table-question-answering':'Въпроси към таблици','tabular-classification':'Таблична класификация',
  'tabular-regression':'Таблична регресия','reinforcement-learning':'RL агенти',
  'graph-machine-learning':'Graph ML','image-feature-extraction':'Image embeddings',
  'image-generation':'Генериране на изображения','custom':'Custom скрейпнати'
};

const HF_LIMIT = 25;        // модела на категория
const HF_CONCURRENCY = 8;   // паралелни заявки към HF

const HF_CHAT_BASE = 'https://router.huggingface.co/v1';
const HF_NATIVE = 'https://api-inference.huggingface.co/models/';

/* ================= Помощни ================= */

const $ = id => document.getElementById(id);
const fmt = n => new Intl.NumberFormat('bg-BG').format(n || 0);
const catLabel = c => CATEGORY_LABELS[c] || c || 'друго';

function log(msg) {
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function setBtn(busy) {
  $('btnFind').disabled = busy;
  $('btnFind').textContent = busy ? 'Търся...' : 'Намери ми AI модели';
}

/* ================= Динамични скрапери ================= */

// --- Hugging Face Hub (онлайн Inference API) ---
async function scrapeHuggingFace() {
  const out = [];
  const queue = [...HF_TAGS];
  const workers = Array.from({ length: HF_CONCURRENCY }, async () => {
    while (queue.length) {
      const tag = queue.shift();
      try {
        // inference_provider=all → само модели, РЕАЛНО обслужвани от поне един
        // inference provider (HF Inference, Groq, Together, Fireworks и т.н.) —
        // без него /api/models връща и огромни модели, качени само за локално
        // сваляне/инсталация, без работещ онлайн endpoint (виж
        // https://huggingface.co/docs/inference-providers/hub-api#list-models).
        const url = `https://huggingface.co/api/models?pipeline_tag=${encodeURIComponent(tag)}&inference_provider=all&sort=downloads&direction=-1&limit=${HF_LIMIT}&gated=false`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        for (const m of data) {
          const lic = (m.tags || []).find(t => t.startsWith('license:'))?.slice(8) || null;
          const type = tag === 'feature-extraction' || tag === 'image-feature-extraction' ? 'embedding'
                     : ['text-to-image','image-to-image'].includes(tag) ? 'image'
                     : ['automatic-speech-recognition','text-to-speech','text-to-audio','audio-to-audio','audio-classification'].includes(tag) ? 'audio'
                     : 'chat';
          out.push({
            source: 'huggingface',
            id: m.id,
            name: m.id,
            provider: m.author || 'Hugging Face',
            category: tag,
            type: type,
            license: lic,
            link: 'https://huggingface.co/' + m.id,
            downloads: m.downloads || 0,
            likes: m.likes || 0,
            endpoint: (type === 'embedding' || type === 'chat') ? HF_CHAT_BASE : HF_NATIVE + m.id,
            auth: { type: 'bearer', key_url: 'https://huggingface.co/settings/tokens', note: 'HF токен — безплатен месечен quota на Inference API' },
            how_to_connect: type === 'chat'
              ? 'Chat: base_url=' + HF_CHAT_BASE + ' (OpenAI-съвместим), модел: ' + m.id
              : 'Inference API: POST ' + HF_NATIVE + m.id + ' с Authorization: Bearer <токен>. Детайли: huggingface.co/' + m.id
          });
        }
      } catch (e) { /* продължавай с другите категории */ }
    }
  });
  await Promise.all(workers);
  return out;
}

// --- OpenRouter (всички модели с :free тарифа, всяка модалност) ---
async function scrapeOpenRouter() {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'HTTP-Referer': location.origin, 'X-Title': 'AI Model Finder' }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  return (data.data || [])
    .filter(m => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
    .map(m => {
      const outMod = (m.modality && m.modality.output) || [];
      const isImg = outMod.includes('image');
      const isAud = outMod.includes('audio');
      const type = isImg ? 'image' : isAud ? 'audio' : 'chat';
      return {
        source: 'openrouter',
        id: m.id,
        name: m.name || m.id,
        provider: 'OpenRouter',
        category: isImg ? 'image-generation' : (isAud ? 'automatic-speech-recognition' : 'text-generation'),
        type: type,
        license: null,
        link: 'https://openrouter.ai/' + m.id,
        downloads: 0,
        context: m.context_length || null,
        endpoint: 'https://openrouter.ai/api/v1' + (isImg ? '/images/generations' : '/chat/completions'),
        auth: { type: 'bearer', key_url: 'https://openrouter.ai/keys', note: 'API ключ — безплатен tier с rate limits' },
        how_to_connect: 'OpenAI-съвместим: base_url=https://openrouter.ai/api/v1, модел: ' + m.id
      };
    });
}

/* ================= Статични списъци (проверявай редовно — free tier-ите се сменят) ================= */

function staticModels() {
  const out = [];
  const push = m => out.push(m);
  const bearer = (key_url, note) => ({ type: 'bearer', key_url: key_url, note: note });

  // --- Gemini (Google AI Studio) ---
  const gemini = [
    ['gemini-2.5-flash',        'text-generation', 'chat',     'Бърз, мултимодален (текст + зрение)'],
    ['gemini-2.5-flash-lite',   'text-generation', 'chat',     'Най-лекият Flash, безплатен tier'],
    ['gemini-2.5-pro',          'text-generation', 'chat',     'Най-умен, ограничен безплатен quota'],
    ['gemini-2.5-flash-image',  'image-generation', 'image',   'Генериране/редакция на изображения'],
    ['text-embedding-004',      'feature-extraction', 'embedding', 'Embeddings 768-d']
  ];
  for (const [model, cat, type, note] of gemini) {
    push({
      source: 'gemini', id: model, name: model, provider: 'Google AI Studio',
      category: cat, type: type, license: null,
      link: 'https://ai.google.dev/gemini-api/docs/models',
      endpoint: type === 'image'
        ? 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent'
        : 'https://generativelanguage.googleapis.com/v1beta/openai/',
      auth: bearer('https://aistudio.google.com/apikey', 'Безплатен ключ от AI Studio; free tier с rate limits. ' + note),
      how_to_connect: type === 'image'
        ? 'REST: POST ' + 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=<КЛЮЧ>'
        : 'OpenAI-съвместим: base_url=https://generativelanguage.googleapis.com/v1beta/openai/, модел: ' + model
    });
  }

  // --- Groq (много бърз inference) ---
  const groq = [
    ['llama-3.3-70b-versatile',       'text-generation', 'chat',     'Llama 3.3 70B'],
    ['llama-3.1-8b-instant',          'text-generation', 'chat',     'Llama 3.1 8B'],
    ['llama-3.2-3b-preview',          'text-generation', 'chat',     'Llama 3.2 3B'],
    ['llama-3.2-11b-vision-preview',  'text-generation', 'chat',     'Llama 3.2 11B Vision (зрение)'],
    ['deepseek-r1-distill-llama-70b', 'text-generation', 'chat',     'DeepSeek R1 — разсъждения'],
    ['whisper-large-v3-turbo',        'automatic-speech-recognition', 'audio', 'Whisper — транскрипция']
  ];
  for (const [model, cat, type, note] of groq) {
    push({
      source: 'groq', id: model, name: model, provider: 'Groq',
      category: cat, type: type, license: null,
      link: 'https://console.groq.com/docs/models',
      endpoint: type === 'audio'
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.groq.com/openai/v1/chat/completions',
      auth: bearer('https://console.groq.com/keys', 'Безплатен ключ. ' + note),
      how_to_connect: 'OpenAI-съвместим: base_url=https://api.groq.com/openai/v1, модел: ' + model
    });
  }

  // --- Mistral (La Plateforme) ---
  const mistral = [
    ['open-mistral-nemo',     'text-generation', 'chat', 'Mistral Nemo 12B'],
    ['open-mixtral-8x22b',    'text-generation', 'chat', 'Mixtral 8x22B (MoE)'],
    ['ministral-3b-2410',     'text-generation', 'chat', 'Ministral 3B'],
    ['ministral-8b-2410',     'text-generation', 'chat', 'Ministral 8B'],
    ['codestral-latest',      'text-generation', 'chat', 'Codestral — код (trial/free tier)'],
    ['pixtral-12b-2409',      'text-generation', 'chat', 'Pixtral — зрение']
  ];
  for (const [model, cat, type, note] of mistral) {
    push({
      source: 'mistral', id: model, name: model, provider: 'Mistral AI',
      category: cat, type: type, license: null,
      link: 'https://console.mistral.ai/',
      endpoint: 'https://api.mistral.ai/v1/chat/completions',
      auth: bearer('https://console.mistral.ai/api-keys', 'Безплатен план с rate limits. ' + note),
      how_to_connect: 'OpenAI-съвместим: base_url=https://api.mistral.ai/v1, модел: ' + model
    });
  }

  // --- Cloudflare Workers AI (безплатна дневна квота на free план) ---
  const cf = [
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'text-generation', 'chat',      'Llama 3.3 70B'],
    ['@cf/meta/llama-3.1-8b-instruct-fp8',       'text-generation', 'chat',      'Llama 3.1 8B'],
    ['@cf/meta/llama-3.2-3b-instruct',           'text-generation', 'chat',      'Llama 3.2 3B'],
    ['@cf/qwen/qwen2.5-coder-32b-instruct',      'text-generation', 'chat',      'Qwen 2.5 Coder 32B'],
    ['@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'text-generation', 'chat',  'DeepSeek R1'],
    ['@cf/black-forest-labs/flux-1-schnell',     'image-generation', 'image',    'FLUX — изображения'],
    ['@cf/stabilityai/stable-diffusion-xl-base-1.0', 'image-generation', 'image','SDXL — изображения'],
    ['@cf/microsoft/whisper-small',              'automatic-speech-recognition', 'audio', 'Whisper — ASR'],
    ['@cf/meta/m2m100-1.2b',                     'translation', 'chat',          'Превод 100+ езика'],
    ['@cf/facebook/bart-large-cnn',              'summarization', 'chat',        'Резюмиране'],
    ['@cf/huggingface/distilbert-sst-2-int8',    'text-classification', 'chat',  'Сантимент'],
    ['@cf/baai/bge-small-en-v1.5',               'feature-extraction', 'embedding', 'Embeddings']
  ];
  for (const [model, cat, type, note] of cf) {
    push({
      source: 'cloudflare', id: model, name: model, provider: 'Cloudflare Workers AI',
      category: cat, type: type, license: null,
      link: 'https://developers.cloudflare.com/workers-ai/models/',
      endpoint: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run/' + model,
      auth: bearer('https://dash.cloudflare.com/profile/api-tokens', 'API токен + Account ID от dashboard-а. ' + note),
      how_to_connect: 'POST ' + 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run/' + model + ' с Authorization: Bearer <токен>'
    });
  }

  // --- GitHub Models (безплатен tier с GitHub акаунт) ---
  const gh = [
    ['gpt-4o-mini',                 'text-generation', 'chat', 'OpenAI GPT-4o mini'],
    ['gpt-4.1-mini',                'text-generation', 'chat', 'OpenAI GPT-4.1 mini'],
    ['gpt-4.1-nano',                'text-generation', 'chat', 'OpenAI GPT-4.1 nano'],
    ['o4-mini',                     'text-generation', 'chat', 'OpenAI o4-mini (разсъждения)'],
    ['o3-mini',                     'text-generation', 'chat', 'OpenAI o3-mini (разсъждения)'],
    ['meta-llama-3.3-70b-instruct', 'text-generation', 'chat', 'Llama 3.3 70B'],
    ['meta-llama-3.1-8b-instruct',  'text-generation', 'chat', 'Llama 3.1 8B'],
    ['deepseek-r1',                 'text-generation', 'chat', 'DeepSeek R1'],
    ['deepseek-v3-0324',            'text-generation', 'chat', 'DeepSeek V3'],
    ['phi-4',                       'text-generation', 'chat', 'Phi-4 — код/математика'],
    ['gemma-3-27b-it',              'text-generation', 'chat', 'Gemma 3 27B'],
    ['mistral-small-2503',          'text-generation', 'chat', 'Mistral Small 3.1'],
    ['qwen3-32b',                   'text-generation', 'chat', 'Qwen3 32B']
  ];
  for (const [model, cat, type, note] of gh) {
    push({
      source: 'github', id: model, name: model, provider: 'GitHub Models',
      category: cat, type: type, license: null,
      link: 'https://github.com/marketplace/models',
      endpoint: 'https://models.github.ai/inference',
      auth: bearer('https://github.com/settings/tokens', 'GitHub токен (PAT); безплатно с акаунт, rate limits според модела. ' + note),
      how_to_connect: 'OpenAI-съвместим: base_url=https://models.github.ai/inference, модел: ' + model
    });
  }

  // --- Pollinations (напълно безплатно, без ключ) ---
  const poll = [
    ['openai',      'text-generation', 'chat',   'GPT-4o-mini клас'],
    ['openai-large','text-generation', 'chat',   'По-голям модел'],
    ['mistral',     'text-generation', 'chat',   'Mistral клас'],
    ['llama',       'text-generation', 'chat',   'Llama клас'],
    ['deepseek',    'text-generation', 'chat',   'DeepSeek клас'],
    ['qwen-coder',  'text-generation', 'chat',   'Qwen Coder — код'],
    ['flux',        'image-generation', 'image', 'FLUX — изображения'],
    ['turbo',       'image-generation', 'image', 'Stable Diffusion Turbo']
  ];
  for (const [model, cat, type, note] of poll) {
    const isImg = type === 'image';
    push({
      source: 'pollinations', id: 'pollinations:' + model, name: model, provider: 'Pollinations',
      category: cat, type: type, license: null,
      link: 'https://pollinations.ai/',
      endpoint: isImg ? 'https://image.pollinations.ai/prompt/{prompt}' : 'https://text.pollinations.ai/openai',
      auth: { type: 'none', key_url: null, note: 'Няма ключ и няма плащане. ' + note },
      how_to_connect: isImg
        ? 'GET https://image.pollinations.ai/prompt/<описание>?model=' + model + '&width=1024&height=1024 → връща PNG'
        : 'OpenAI-съвместим: POST https://text.pollinations.ai/openai, модел: ' + model + ' (без ключ)'
    });
  }

  // --- Jina Embeddings (безплатни кредити) ---
  push({
    source: 'jina', id: 'jina-embeddings-v3', name: 'jina-embeddings-v3', provider: 'Jina AI',
    category: 'feature-extraction', type: 'embedding', license: null,
    link: 'https://jina.ai/embeddings/',
    endpoint: 'https://api.jina.ai/v1/embeddings',
    auth: bearer('https://jina.ai/', 'Безплатни кредити за стартиране'),
    how_to_connect: 'OpenAI-съвместим embeddings: POST https://api.jina.ai/v1/embeddings, модел: jina-embeddings-v3'
  });

  return out;
}

/* ================= Обединяване и изход ================= */

function dedupe(models) {
  const seen = new Map();
  for (const m of models) if (!seen.has(m.source + '|' + m.id)) seen.set(m.source + '|' + m.id, m);
  return [...seen.values()].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
}

function buildOutput(models, status) {
  return {
    generated_at: new Date().toISOString(),
    total: models.length,
    note: 'Безплатните tier-ове се променят — проверявай key_url за всеки източник.',
    sources: status,
    how_to_use: {
      huggingface: 'Chat/embeddings: base_url=https://router.huggingface.co/v1 (OpenAI-съвместим). Други задачи: POST https://api-inference.huggingface.co/models/<id> с Bearer HF токен.',
      openrouter:  'OpenAI-съвместим: base_url=https://openrouter.ai/api/v1, Authorization: Bearer <ключ>. За изображения: /images/generations.',
      gemini:      'OpenAI-съвместим: base_url=https://generativelanguage.googleapis.com/v1beta/openai/. Изображения: REST :generateContent с ?key=',
      groq:        'OpenAI-съвместим: base_url=https://api.groq.com/openai/v1. Whisper: /audio/transcriptions.',
      mistral:     'OpenAI-съвместим: base_url=https://api.mistral.ai/v1.',
      cloudflare:  'POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run/<модел> с Bearer токен.',
      github:      'OpenAI-съвместим: base_url=https://models.github.ai/inference с GitHub PAT.',
      pollinations:'Без ключ: text → https://text.pollinations.ai/openai; изображения → https://image.pollinations.ai/prompt/<описание>?model=flux',
      jina:        'Embeddings: POST https://api.jina.ai/v1/embeddings с Bearer ключ.'
    },
    models: models
  };
}

async function findAll() {
  setBtn(true);
  $('results').innerHTML = '';
  $('stats').innerHTML = '';
  $('search').style.display = 'none';
  $('catChips').innerHTML = '';
  $('btnDownload').style.display = 'none';
  log('Стартиране на търсенето...');

  const status = {};
  const jobs = [
    ['huggingface', scrapeHuggingFace()],
    ['openrouter',  scrapeOpenRouter()],
    ['static',      Promise.resolve(staticModels())]
  ];
  const results = [];
  for (const [name, promise] of jobs) {
    try {
      const items = await promise;
      results.push(...items);
      status[name] = { ok: true, count: items.length };
      log('OK   ' + name + ': ' + items.length + ' модела');
    } catch (e) {
      status[name] = { ok: false, error: String(e.message || e) };
      log('FAIL ' + name + ': ' + (e.message || e));
    }
  }

  const models = dedupe(results);
  window.__lastOutput = buildOutput(models, status);

  log('Готово: ' + models.length + ' уникални модела.');
  render(models);
  $('btnDownload').style.display = 'inline-block';
  setBtn(false);
}

/* ================= Визия и филтри ================= */

function render(models) {
  const byCat = {};
  for (const m of models) {
    const label = catLabel(m.category);
    (byCat[label] = byCat[label] || []).push(m);
  }
  const labels = Object.keys(byCat);
  window.__renderState = { models, byCat };

  $('stats').innerHTML =
    '<div class="stat"><b>' + fmt(models.length) + '</b>модела общо</div>' +
    '<div class="stat"><b>' + labels.length + '</b>категории</div>';

  $('search').style.display = 'block';
  $('search').value = '';

  const chips = $('catChips');
  chips.innerHTML = '';
  for (const label of labels) {
    const b = document.createElement('button');
    b.textContent = label + ' (' + byCat[label].length + ')';
    b.className = 'chip';
    b.dataset.cat = label;
    b.onclick = () => {
      const active = b.classList.toggle('active');
      applyFilter(models, byCat, active ? label : null);
    };
    chips.appendChild(b);
  }

  applyFilter(models, byCat, null);
}

function getActiveCat() {
  const el = document.querySelector('.chip.active');
  return el ? el.dataset.cat : null;
}

function applyFilter(models, byCat, activeCat) {
  const q = ($('search').value || '').toLowerCase().trim();
  const box = $('results');
  box.innerHTML = '';
  let shown = 0;
  for (const label of Object.keys(byCat)) {
    if (activeCat && label !== activeCat) continue;
    const list = byCat[label].filter(m =>
      !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (!list.length) continue;
    shown += list.length;
    const det = document.createElement('details');
    det.open = list.length <= 40;
    const sum = document.createElement('summary');
    sum.textContent = label + ' — ' + list.length + ' модела';
    det.appendChild(sum);
    const ul = document.createElement('ul');
    for (const m of list) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = m.link; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = m.name;
      li.appendChild(a);
      if (m.downloads) li.appendChild(document.createTextNode(' — ' + fmt(m.downloads) + ' сваляния'));
      if (m.license) {
        const s = document.createElement('span');
        s.className = 'lic';
        s.textContent = ' [' + m.license + ']';
        li.appendChild(s);
      }
      li.title = m.how_to_connect || '';
      ul.appendChild(li);
    }
    det.appendChild(ul);
    box.appendChild(det);
  }
  if (!shown) box.innerHTML = '<p class="hint">Няма резултати за тази филтрация.</p>';
}

function downloadJson() {
  const out = window.__lastOutput;
  if (!out) return;
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ai-models.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ================= Custom скрапер (произволни сайтове през Worker) ================= */

async function scrapeCustom(rules) {
  if (!CUSTOM_PROXY) throw new Error('Задай CUSTOM_PROXY в app.js (Cloudflare Worker).');
  const out = [];
  for (const line of rules.split('\n').map(s => s.trim()).filter(Boolean)) {
    const [url, sel] = line.split('|').map(s => s.trim());
    if (!url || !sel) continue;
    const r = await fetch(CUSTOM_PROXY + '?url=' + encodeURIComponent(url));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' за ' + url);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(sel).forEach(el => {
      const name = (el.textContent || '').trim().slice(0, 120);
      if (!name) return;
      let link = url;
      try { const href = el.getAttribute('href'); if (href) link = new URL(href, url).href; } catch (e) {}
      out.push({
        source: 'custom', id: 'custom:' + url + ':' + name, name: name,
        provider: new URL(url).hostname, category: 'custom', type: 'web',
        license: null, link: link, downloads: 0, endpoint: null,
        auth: { type: 'none' }, how_to_connect: 'Източник: ' + url
      });
    });
  }
  return out;
}

/* ================= Събития ================= */

$('btnFind').addEventListener('click', findAll);
$('btnDownload').addEventListener('click', downloadJson);
$('search').addEventListener('input', () => {
  const st = window.__renderState;
  if (st) applyFilter(st.models, st.byCat, getActiveCat());
});
$('btnCustom').addEventListener('click', async () => {
  const rules = $('customRules').value;
  if (!rules.trim()) return;
  setBtn(true);
  try {
    const items = await scrapeCustom(rules);
    log('OK   custom: ' + items.length + ' елемента');
    const prev = window.__lastOutput;
    const models = dedupe([...(prev ? prev.models : []), ...items]);
    window.__lastOutput = buildOutput(models, { ...(prev ? prev.sources : {}), custom: { ok: true, count: items.length } });
    render(models);
    $('btnDownload').style.display = 'inline-block';
  } catch (e) {
    log('FAIL custom: ' + (e.message || e));
  }
  setBtn(false);
});
