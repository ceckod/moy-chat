#!/usr/bin/env node
'use strict';

/* Проверява всички ключове от keys.json срещу реалните API-та.
   Ползване:  node check-keys.mjs   (след node scraper.mjs) */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const keysFile = join(__dirname, 'keys.json');
const configFile = join(__dirname, 'ai-models.json');

if (!existsSync(keysFile)) { console.log('Липсва keys.json — създай го от шаблона.'); process.exit(1); }
if (!existsSync(configFile)) { console.log('Липсва ai-models.json — първо пусни: node scraper.mjs'); process.exit(1); }

const keys = JSON.parse(readFileSync(keysFile, 'utf8'));

// Пропусни проверката, ако нито един ключ не е зададен
const configured = Object.values(keys).filter(v => v && String(v).trim()).length;
if (configured === 0) { console.log('Няма зададени ключове — пропускам проверката.'); process.exit(0); }

const config = JSON.parse(readFileSync(configFile, 'utf8'));

const TESTS = {
  huggingface: { method: 'GET', url: () => 'https://huggingface.co/api/whoami-v2',
                 headers: k => ({ Authorization: 'Bearer ' + k }) },
  openrouter:  { method: 'GET', url: () => 'https://openrouter.ai/api/v1/auth/key',
                 headers: k => ({ Authorization: 'Bearer ' + k }) },
  gemini:      { method: 'GET', url: k => 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(k),
                 headers: () => ({}) },
  groq:        { method: 'GET', url: () => 'https://api.groq.com/openai/v1/models',
                 headers: k => ({ Authorization: 'Bearer ' + k }) },
  mistral:     { method: 'GET', url: () => 'https://api.mistral.ai/v1/models',
                 headers: k => ({ Authorization: 'Bearer ' + k }) },
  cloudflare:  { method: 'GET', url: () => 'https://api.cloudflare.com/client/v4/user/tokens/verify',
                 headers: k => ({ Authorization: 'Bearer ' + k }) },
  github:      { method: 'GET', url: () => 'https://api.github.com/user',
                 headers: k => ({ Authorization: 'Bearer ' + k, 'User-Agent': 'key-check' }) },
  jina:        { method: 'POST', url: () => 'https://api.jina.ai/v1/embeddings',
                 headers: k => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }),
                 body: () => JSON.stringify({ model: 'jina-embeddings-v3', input: ['test'] }) }
};

async function check(source, key) {
  const t = TESTS[source];
  if (!t) return 'няма тест';
  try {
    const r = await fetch(t.url(key), { method: t.method, headers: t.headers(key), body: t.body ? t.body() : undefined });
    if (source === 'cloudflare') {
      const d = await r.json();
      return (d.success && d.result?.status === 'active') ? 'OK' : 'FAIL (' + r.status + ')';
    }
    return r.ok ? 'OK' : 'FAIL (' + r.status + ')';
  } catch (e) {
    return 'ГРЕШКА (' + e.message + ')';
  }
}

const sources = [...new Set(config.models.map(m => m.source))];
let problems = 0;

console.log('Проверка на ключовете:\n');
for (const s of sources) {
  const auth = config.models.find(m => m.source === s)?.auth;
  if (!auth || auth.type === 'none') {
    console.log('  ' + s.padEnd(12) + '— без ключ (напр. Pollinations)');
    continue;
  }
  const env = auth.key_env;
  const key = keys[env];
  if (!key) {
    // Не е задължително всеки да ползва всички източници — липсващ ключ
    // не е "счупен" ключ, затова не се брои за проблем (не отваря issue).
    console.log('  ' + s.padEnd(12) + '— не е конфигуриран (' + env + ')');
    continue;
  }
  const res = await check(s, key);
  if (res !== 'OK') problems++;
  console.log('  ' + s.padEnd(12) + env.padEnd(24) + res);
}

console.log(problems ? '\nИма ' + problems + ' проблема.' : '\nВсичко е наред.');
process.exit(problems ? 1 : 0);
