# AI Model Finder

> **Забележка:** тази папка е обединена в основния "AI Music Suite — CD-B
> Records Dashboard" repo на 2026-08-08 (виж root `README.md` →
> "🧠 AI Model Finder (ново)" и Changelog v1.21.0). Всички пътища по-долу
> (`index.html`, `app.js`, `scraper.mjs`, workflow-a и т.н.) сега живеят
> вътре в `ai-model-finder/`, не в root на repo-то — GitHub Pages
> страницата излиза на `https://<потребител>.github.io/<репо>/ai-model-finder/`,
> а workflow файлът е `.github/workflows/scrape-ai-models.yml` (в root
> `.github/workflows/`, пътищата вътре вече сочат към `ai-model-finder/…`).
> Основното табло вижда резултата read-only през **Инструменти → 🧠 AI
> Model Finder**.

Скрапер за безплатни ОНЛАЙН AI модели. Събира модели от Hugging Face, OpenRouter, Gemini,
Groq, Mistral, Cloudflare Workers AI, GitHub Models, Pollinations и Jina и генерира
`ai-models.json` — готов конфигурационен файл с endpoints, auth и инструкции за връзка.

## Файлове

| Файл | Какво прави |
|---|---|
| `index.html` | Страницата с бутона „Намери ми AI модели" (браузърен скрапер, работи на GitHub Pages) |
| `app.js` | Браузърният скрапер — HF + OpenRouter на живо + курирани списъци; генерира и изтегля JSON |
| `worker.js` | (опция) Cloudflare Worker — CORS прокси за скрейпване на произволни сайтове |
| `scraper.mjs` | Node скраперът — същите източници, работи на сървър/CI: `node scraper.mjs` |
| `check-keys.mjs` | Проверява всичките ти API ключове срещу реалните API-та: `node check-keys.mjs` |
| `keys.json` | Тук слагаш ключовете си. **НЕ се качва в git!** (в .gitignore) |
| `.github/workflows/scrape.yml` | Всяка нощ в 03:00 UTC скрейпва, проверява ключовете и обновява `ai-models.json` |
| `.nojekyll` | Спира Jekyll обработката на GitHub Pages |

## Стъпка по стъпка

### 1. Качване
1. Копирай всички файлове в репото си (включително `.github/workflows/` и `.nojekyll`).
2. `git add . && git commit -m "init" && git push`.

### 2. Регистрации + ключове (ВЕДНЪЖ, ръчно — ~15-20 мин)
Автоматична регистрация е невъзможна (CAPTCHA, имейл верификация, ToS). Но веднъж
направени, ключовете се проверяват и обновяват автоматично.

| Secret име | Откъде се взима |
|---|---|
| `HF_API_KEY` | https://huggingface.co/settings/tokens |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `GROQ_API_KEY` | https://console.groq.com/keys |
| `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| `CF_API_TOKEN` | https://dash.cloudflare.com/profile/api-tokens |
| `CF_ACCOUNT_ID` | Cloudflare dashboard (на страницата на акаунта) |
| `GH_MODELS_PAT` | https://github.com/settings/tokens (PAT) |
| `JINA_API_KEY` | https://jina.ai |

Pollinations не иска ключ — работи веднага.

### 3. Secrets
Repository → Settings → Secrets and variables → Actions → New repository secret.
Добави всеки ред от таблицата по-горе като отделен secret.

### 4. GitHub Pages
Settings → Pages → Source: Deploy from a branch → клон `main`, папка `/ (root)` → Save.
Сайтът ти излиза на `https://<потребител>.github.io/<репо>/`.

### 5. Първо пускане
Actions → „Обновяване на AI модели" → Run workflow. След това всяка нощ се обновява сам.

## Локален тест (по желание)

```bash
node scraper.mjs      # генерира ai-models.json
node check-keys.mjs   # проверява ключовете
```

## Как приложението ти ползва ai-models.json

- Файлът е безопасен за публикуване — съдържа само `key_env` ИМЕНА, не реални ключове.
- Всеки запис има `endpoint`, `auth` (тип + къде се взима ключът) и `how_to_connect`.
- Повечето източници са OpenAI-съвместими (`base_url` + Bearer ключ).

## Важно

- `keys.json` никога не се качва в git.
- Безплатните tier-ове се променят — проверявай `key_url` на всеки запис.
- „Безплатно" не винаги значи „безплатно за комерсиално" — гледай лицензите.

## Опционален custom скрейпър

За скрейпване на произволни сайтове (не само изброените API-та по-горе):
1. Деплойни `worker.js` безплатно на Cloudflare Workers (`npx wrangler deploy`).
2. Сложи URL-то му в `CUSTOM_PROXY` в `app.js`.
3. В интерфейса добавяй редове `URL | CSS-селектор` — скриптът вади текст + линкове от
   елементите, отговарящи на селектора.

## Накратко — кое как става

| Въпрос | Отговор |
|---|---|
| Бутонът „Намери ми AI модели" | `index.html` + `app.js` — скрейпва на място в браузъра и дава JSON за изтегляне |
| Автоматично обновяване | `scrape.yml` — всяка нощ в 03:00 UTC, без да правиш нищо |
| Ключовете | Ръчни регистрации веднъж (~15 мин) → слагаш в GitHub Secrets → `check-keys.mjs` ги проверява автоматично всяка нощ и отваря issue при счупен ключ |
| Файлът за приложението ти | `ai-models.json` — генерира се автоматично в репото, GitHub Pages го сервира, приложението чете от него `endpoint` + `auth` + `how_to_connect` |
| Кой е без ключ | Pollinations (чат + изображения) — работи от нулата |
