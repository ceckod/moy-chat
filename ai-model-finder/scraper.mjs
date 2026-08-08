#!/usr/bin/env node
'use strict';

/*
 * AI Model Finder — самостоятелен скрапер за БЕЗПЛАТНИ ОНЛАЙН AI модели
 * Ползване:  node scraper.mjs
 * Изход:     ai-models.json  (без реални ключове, само key_env имена)
 * Ключове:   сложи ги в keys.json (НЕ го качвай в git!)
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'ai-models.json');

/* ---------------- Ключове (локално, gitignored) ---------------- */
function loadKeys() {
  const f = join(__dirname, 'keys.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

/* ================= Hugging Face (динамично) ================= */

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

const HF_LIMIT = 25;
const HF_CONCURRENCY = 8;

async function scrapeHuggingFace() {
  const out = [];
  const queue = [...HF_TAGS];
  const workers = Array.from({ length: HF_CONCURRENCY }, async () => {
    while (queue.length) {
      const tag = queue.shift();
      try {
        const url = `https://huggingface.co/api/models?pipeline_tag=${encodeURIComponent(tag)}&sort=downloads&direction=-1&limit=${HF_LIMIT}&gated=false`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        for (const m of data) {
          const lic = (m.tags || []).find(t => t.startsWith('license:'))?.slice(8) || null;
          const type = ['feature-extraction','image-feature-extraction'].includes(tag) ? 'embedding'
                     : ['text-to-image','image-to-image'].includes(tag) ? 'image'
                     : ['automatic-speech-recognition','text-to-speech','text-to-audio','audio-to-audio','audio-classification'].includes(tag) ? 'audio'
                     : 'chat';
          out.push({
            source: 'huggingface', id: m.id, name: m.id, provider: m.author || 'Hugging Face',
            category: tag, type: type, license: lic,
            link: 'https://huggingface.co/' + m.id, downloads: m.downloads || 0,
            endpoint: type === 'embedding' ? 'https://router.huggingface.co/v1'
                                          : 'https://api-inference.huggingface.co/models/' + m.id,
            auth: { type: 'bearer', key_env: 'HF_API_KEY', key_url: 'https://huggingface.co/settings/tokens', note: 'Безплатен месечен quota' },
            how_to_connect: type === 'chat'
              ? 'OpenAI-съвместим: base_url=https://router.huggingface.co/v1, модел: ' + m.id
              : 'POST https://api-inference.huggingface.co/models/' + m.id + ' с Bearer токен'
          });
        }
      } catch (e) { /* продължавай със следващата категория */ }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ================= OpenRouter (динамично — всички :free модели) ================= */

async function scrapeOpenRouter() {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'HTTP-Referer': 'https://local', 'X-Title': 'AI Model Finder' }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  return (data.data || [])
    .filter(m => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
    .map(m => {
      const outMod = (m.modality && m.modality.output) || [];
      const isImg = outMod.includes('image');
      return {
        source: 'openrouter', id: m.id, name: m.name || m.id, provider: 'OpenRouter',
        category: isImg ? 'image-generation' : 'text-generation', type: isImg ? 'image' : 'chat',
        license: null, link: 'https://openrouter.ai/' + m.id, downloads: 0,
        endpoint: 'https://openrouter.ai/api/v1' + (isImg ? '/images/generations' : '/chat/completions'),
        auth: { type: 'bearer', key_env: 'OPENROUTER_API_KEY', key_url: 'https://openrouter.ai/keys', note: 'Безплатен tier с rate limits' },
        how_to_connect: 'OpenAI-съвместим: base_url=https://openrouter.ai/api/v1, модел: ' + m.id
      };
    });
}

/* ================= Курирани списъци (static) ================= */

function staticModels() {
  const out = [];
  const add = m => out.push(m);

  // --- Gemini (Google AI Studio) ---
  const baseGemini = {
    source: 'gemini', provider: 'Google AI Studio', license: null,
    link: 'https://ai.google.dev/gemini-api/docs/models',
    auth: { type: 'bearer', key_env: 'GEMINI_API_KEY', key_url: 'https://aistudio.google.com/apikey', note: 'Безплатен ключ от AI Studio' }
  };
  const gemini = [
    ['gemini-2.5-flash',        'text-generation', 'chat',     'Бърз, мултимодален (текст + зрение)'],
    ['gemini-2.5-flash-lite',   'text-generation', 'chat',     'Най-лекият Flash'],
    ['gemini-2.5-pro',          'text-generation', 'chat',     'Най-умен, ограничен quota'],
    ['gemini-2.5-flash-image',  'image-generation', 'image',   'Генериране/редакция на изображения'],
    ['text-embedding-004',      'feature-extraction', 'embedding', 'Embeddings 768-d']
  ];
  for (const [id, cat, type, note] of gemini) {
    add({
      ...baseGemini, id, name: id, category: cat, type: type,
      endpoint: type === 'image'
        ? 'https://generativelanguage.googleapis.com/v1beta/models/' + id + ':generateContent'
        : 'https://generativelanguage.googleapis.com/v1beta/openai/',
      how_to_connect: type === 'image'
        ? 'REST: POST .../v1beta/models/' + id + ':generateContent?key=<КЛЮЧ>'
        : 'OpenAI-съвместим: base_url=https://generativelanguage.googleapis.com/v1beta/openai/, модел: ' + id,
      auth: { ...baseGemini.auth, note: 'Безплатен tier. ' + note }
    });
  }

  // --- Groq ---
  const baseGroq = {
    source: 'groq', provider: 'Groq', license: null,
    link: 'https://console.groq.com/docs/models',
    auth: { type: 'bearer', key_env: 'GROQ_API_KEY', key_url: 'https://console.groq.com/keys', note: 'Безплатен ключ' }
  };
  const groq = [
    ['llama-3.3-70b-versatile',       'text-generation', 'chat',   'Llama 3.3 70B'],
    ['llama-3.1-8b-instant',          'text-generation', 'chat',   'Llama 3.1 8B'],
    ['llama-3.2-11b-vision-preview',  'text-generation', 'chat',   'Llama 3.2 11B Vision (зрение)'],
    ['deepseek-r1-distill-llama-70b', 'text-generation', 'chat',   'DeepSeek R1 — разсъждения'],
    ['whisper-large-v3-turbo',        'automatic-speech-recognition', 'audio', 'Whisper — транскрипция']
  ];
  for (const [id, cat, type, note] of groq) {
    add({
      ...baseGroq, id, name: id, category: cat, type: type,
      endpoint: type === 'audio' ? 'https://api.groq.com/openai/v1/audio/transcriptions'
                                 : 'https://api.groq.com/openai/v1/chat/completions',
      how_to_connect: 'OpenAI-съвместим: base_url=https://api.groq.com/openai/v1, модел: ' + id,
      auth: { ...baseGroq.auth, note: 'Безплатен ключ. ' + note }
    });
  }

  // --- Mistral ---
  const baseMistral = {
    source: 'mistral', provider: 'Mistral AI', license: null,
    link: 'https://console.mistral.ai/',
    auth: { type: 'bearer', key_env: 'MISTRAL_API_KEY', key_url: 'https://console.mistral.ai/api-keys', note: 'Безплатен план с rate limits' }
  };
  const mistral = [
    ['open-mistral-nemo',  'text-generation', 'chat', 'Mistral Nemo 12B'],
    ['open-mixtral-8x22b', 'text-generation', 'chat', 'Mixtral 8x22B (MoE)'],
    ['ministral-8b-2410',  'text-generation', 'chat', 'Ministral 8B'],
    ['codestral-latest',   'text-generation', 'chat', 'Codestral — код'],
    ['pixtral-12b-2409',   'text-generation', 'chat', 'Pixtral — зрение']
  ];
  for (const [id, cat, type, note] of mistral) {
    add({
      ...baseMistral, id, name: id, category: cat, type: type,
      endpoint: 'https://api.mistral.ai/v1/chat/completions',
      how_to_connect: 'OpenAI-съвместим: base_url=https://api.mistral.ai/v1, модел: ' + id,
      auth: { ...baseMistral.auth, note: 'Безплатен план. ' + note }
    });
  }

  // --- Cloudflare Workers AI ---
  const baseCf = {
    source: 'cloudflare', provider: 'Cloudflare Workers AI', license: null,
    link: 'https://developers.cloudflare.com/workers-ai/models/',
    auth: { type: 'bearer', key_env: 'CF_API_TOKEN', key_url: 'https://dash.cloudflare.com/profile/api-tokens', note: 'Нужен е и CF_ACCOUNT_ID от dashboard-а. 10 000 neuroni/ден на free план' }
  };
  const cf = [
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'text-generation', 'chat',      'Llama 3.3 70B'],
    ['@cf/meta/llama-3.1-8b-instruct-fp8',       'text-generation', 'chat',      'Llama 3.1 8B'],
    ['@cf/qwen/qwen2.5-coder-32b-instruct',      'text-generation', 'chat',      'Qwen 2.5 Coder 32B'],
    ['@cf/black-forest-labs/flux-1-schnell',     'image-generation', 'image',    'FLUX — изображения'],
    ['@cf/stabilityai/stable-diffusion-xl-base-1.0', 'image-generation', 'image','SDXL'],
    ['@cf/microsoft/whisper-small',              'automatic-speech-recognition', 'audio', 'Whisper — ASR'],
    ['@cf/meta/m2m100-1.2b',                     'translation', 'chat',          'Превод 100+ езика'],
    ['@cf/facebook/bart-large-cnn',              'summarization', 'chat',        'Резюмиране'],
    ['@cf/baai/bge-small-en-v1.5',               'feature-extraction', 'embedding', 'Embeddings']
  ];
  for (const [id, cat, type, note] of cf) {
    add({
      ...baseCf, id, name: id, category: cat, type: type,
      endpoint: 'https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/ai/run/' + id,
      how_to_connect: 'POST .../accounts/<CF_ACCOUNT_ID>/ai/run/' + id + ' с Authorization: Bearer <токен>',
      auth: { ...baseCf.auth, note: '10k neuroni/ден. ' + note }
    });
  }

  // --- GitHub Models ---
  const baseGh = {
    source: 'github', provider: 'GitHub Models', license: null,
    link: 'https://github.com/marketplace/models',
    auth: { type: 'bearer', key_env: 'GITHUB_PAT', key_url: 'https://github.com/settings/tokens', note: 'GitHub PAT, безплатно с акаунт' }
  };
  const gh = [
    ['gpt-4o-mini',                 'text-generation', 'chat', 'GPT-4o mini'],
    ['gpt-4.1-mini',                'text-generation', 'chat', 'GPT-4.1 mini'],
    ['gpt-4.1-nano',                'text-generation', 'chat', 'GPT-4.1 nano'],
    ['o3-mini',                     'text-generation', 'chat', 'o3-mini (разсъждения)'],
    ['meta-llama-3.3-70b-instruct', 'text-generation', 'chat', 'Llama 3.3 70B'],
    ['deepseek-r1',                 'text-generation', 'chat', 'DeepSeek R1'],
    ['deepseek-v3-0324',            'text-generation', 'chat', 'DeepSeek V3'],
    ['phi-4',                       'text-generation', 'chat', 'Phi-4 — код/математика'],
    ['gemma-3-27b-it',              'text-generation', 'chat', 'Gemma 3 27B'],
    ['qwen3-32b',                   'text-generation', 'chat', 'Qwen3 32B']
  ];
  for (const [id, cat, type, note] of gh) {
    add({
      ...baseGh, id, name: id, category: cat, type: type,
      endpoint: 'https://models.github.ai/inference',
      how_to_connect: 'OpenAI-съвместим: base_url=https://models.github.ai/inference, модел: ' + id,
      auth: { ...baseGh.auth, note: 'Безплатно с GitHub акаунт. ' + note }
    });
  }

  // --- Pollinations (без ключ изобщо!) ---
  const poll = [
    ['openai',       'text-generation', 'chat',   'GPT-4o-mini клас'],
    ['openai-large', 'text-generation', 'chat',   'По-голям модел'],
    ['mistral',      'text-generation', 'chat',   'Mistral клас'],
    ['llama',        'text-generation', 'chat',   'Llama клас'],
    ['deepseek',     'text-generation', 'chat',   'DeepSeek клас'],
    ['qwen-coder',   'text-generation', 'chat',   'Qwen Coder — код'],
    ['flux',         'image-generation', 'image', 'FLUX — изображения'],
    ['turbo',        'image-generation', 'image', 'Stable Diffusion Turbo']
  ];
  for (const [id, cat, type, note] of poll) {
    add({
      source: 'pollinations', provider: 'Pollinations', id, name: id, category: cat, type: type,
      license: null, link: 'https://pollinations.ai/', downloads: 0,
      endpoint: type === 'image' ? 'https://image.pollinations.ai/prompt/{prompt}' : 'https://text.pollinations.ai/openai',
      auth: { type: 'none', key_env: null, key_url: null, note: 'Без ключ и без плащане. ' + note },
      how_to_connect: type === 'image'
        ? 'GET https://image.pollinations.ai/prompt/<описание>?model=' + id + '&width=1024&height=1024 → PNG'
        : 'OpenAI-съвместим: POST https://text.pollinations.ai/openai, модел: ' + id + ' (без ключ)'
    });
  }

  // --- Jina Embeddings ---
  add({
    source: 'jina', provider: 'Jina AI', id: 'jina-embeddings-v3', name: 'jina-embeddings-v3',
    category: 'feature-extraction', type: 'embedding', license: null,
    link: 'https://jina.ai/embeddings/', downloads: 0,
    endpoint: 'https://api.jina.ai/v1/embeddings',
    auth: { type: 'bearer', key_env: 'JINA_API_KEY', key_url: 'https://jina.ai/', note: 'Безплатни начални кредити' },
    how_to_connect: 'OpenAI-съвместим embeddings: POST https://api.jina.ai/v1/embeddings, модел: jina-embeddings-v3'
  });

  return out;
}

/* ================= Обединяване ================= */

function dedupe(models) {
  const seen = new Map();
  for (const m of models) if (!seen.has(m.source + '|' + m.id)) seen.set(m.source + '|' + m.id, m);
  return [...seen.values()].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
}

async function main() {
  console.log('Търсене на безплатни онлайн AI модели...\n');
  const keys = loadKeys();
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
      console.log('OK   ' + name.padEnd(12) + items.length + ' модела');
    } catch (e) {
      status[name] = { ok: false, error: String(e.message || e) };
      console.log('FAIL ' + name.padEnd(12) + (e.message || e));
    }
  }

  const models = dedupe(results);

  const needed = [...new Set(models.map(m => m.auth?.key_env).filter(Boolean))];
  const missing = needed.filter(k => !keys[k]);

  const output = {
    generated_at: new Date().toISOString(),
    total: models.length,
    note: 'Безплатните tier-ове се променят — проверявай key_url за всеки източник.',
    sources: status,
    keys_needed: needed,
    models: models
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log('\nГотово: ' + models.length + ' модела → ' + OUT);
  if (missing.length) {
    console.log('Липсващи ключове в keys.json: ' + missing.join(', '));
    console.log('Сложи ги и пусни: node check-keys.mjs');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
