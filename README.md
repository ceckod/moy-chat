# AI Music Suite — CD-B Records Dashboard

**Версия:** 1.27.1
**Последна промяна:** 2026-08-12 (Europe/Sofia) — Fix: премахнат hardcoded "album cover" wrapper от AI image промптите (конкурираше с реалната заявка на потребителя, напр. лого); нов трети вариант — 100% code-генерирано 3D текстово лого (Canvas, БЕЗ AI, гарантиран точен текст) — виж Changelog

Браузърно табло (чист HTML/CSS/JS, без backend сървър за самото приложение)
за пазарен анализ, писане на текстове, визуализатор и публикуване на музика.
Един допълнителен слой (GitHub Actions) следи YouTube статистика на 24ч.

## Бърз старт

1. Качи всички файлове от това repo в GitHub.
2. Активирай **GitHub Pages** (Settings → Pages → Deploy from branch → `main` → `/`).
3. Отвори сайта → **⚙️ (горе вдясно) → API Ключове** → сложи Claude/Gemini/YouTube ключове.
4. (По избор) Настрой Proxy — виж стъпка "CORS Proxy" по-долу.
5. (По избор) Настрой YouTube Тракер — виж стъпка "Дневна статистика" по-долу.

Всички API ключове се пазят **само локално** в браузъра (localStorage) — никога не се качват в GitHub.

---

## Функции

### Стъпка 1 — Пазарен анализ
- **🔍 Предложение за песен** — остави полето празно и чете дневния trend
  snapshot (виж "Дневен Trend Tracker" по-долу) — Google Trends + YouTube
  конкурентни данни, обновявани веднъж на ден, **без Gemini квота**. Ако
  въведеш свои жанрове в полето, Claude ги сравнява точно тях вместо
  авто-сканиране.
- **📊 YouTube Outlier анализ** — автоматично след избора на ниша: намира
  малки канали с непропорционално много гледания (VidIQ-стил сигнал за
  търсене без силна конкуренция). Изисква YouTube Data API Key.
- **🔎 Свързани търсения** — реални autocomplete предложения (какво реално
  търси аудиторията). Изисква Proxy URL (виж по-долу).
- **✨ Концепция** — заглавие, Style Prompt (за Suno AI) и 3 хаштага.
- **📀 Album Sprint** — 10-30 различни заглавия+hook+mood наведнъж.
- **🚀 Viral Lab (AI Music Producer)** — след генериране на текста, едно
  Claude извикване връща цялостен доклад: претеглен **Viral Score** (0-100:
  Trend Momentum 30% / Search Volume 20% / Music Competition 15% / Audience
  Match 15% / Emotional Impact 10% / TikTok Potential 10%), прогнози за успех
  (% шанс за внимание / Shorts / TikTok звук / YouTube CTR), 7 метрики на
  текста (Hook, Memorability, Repeatability, Emotion, Singability, Rhyme,
  Simplicity), анализ на припева, проверка на структурата и BPM/теми за
  жанра (заземени в реални YouTube заглавия, ако има YouTube ключ — не само
  памет на модела), конкретни препоръки срещу конкуренцията, AI Producer
  Review (★ + плюсове/минуси) и списък със слаби секции — всяка с бутон
  **✨ Подобри**, който пренаписва само нея (не цялата песен).
- **🧬 Hook Evolution Arena** — 8 различни hook-а се генерират, минават
  "3-секунден scroll тест" (симулация на реално TikTok/Shorts поведение —
  не цялата песен, само 3-секундно прозорче), топ 3 се кръстосват
  (хибриди + мутации, с видима "родословна линия") в следващо поколение.
  3 поколения по-късно остава 1 победител, който автоматично се вгражда
  като chorus hook при следващото генериране на текст.
- **👻 Ghost Audience** — 12 синтетични, но правдоподобни слушателя "чуват"
  текста и реагират с техния глас/сленг (не абстрактно число). Включва
  **Attention Heatmap** (секунда по секунда по структурата — къде реално
  губиш вниманието) и **Meme Risk Radar** (редове, за които 2+ персони
  независимо биха се закачили подигравателно).
- **✍️ Текст на песента** — с Chorus най-отпред, мета-тагове за Suno.
  Пази история от версии (🕐), с връщане назад при нужда.
- **🎯 Track Record** ("Анализи & Графики") — всеки Viral Lab анализ се
  запазва автоматично; когато песента е публикувана и се появи в YouTube
  Тракера, свързваш я с прогнозата и виждаш честно колко точен е бил AI-я
  във времето — не просто число без последствия.
- **📚 Архив на песните** ("Проект & Данни") — "Нов проект" вече архивира
  автоматично старата песен (нищо не се губи), плюс ръчен бутон за запис
  по всяко време — за сравняване на Viral Score между песни.
- **🎯 Niche Toolkit → 💰 Revenue Simulator** — груба клиентска прогноза
  за месечен приход по стрийм/view числа (не финансов съвет).
- **🗓️ Release Asset Roadmap** — динамичен чек-лист за релийз стъпките,
  подреден според датата на пускане, с прогрес в localStorage.

### Стъпка 2 — Визуализатор
Вграден аудио-реактивен визуализатор (`visualizer.html`) с интро видео →
"smoke" loop видео преход. Прехода вече е поправен — буферите се "загряват"
предварително (pre-priming), 1.2 сек преди смяната, докато интрото все още
тече, за да няма черен/замръзнал кадър при прехода.

### Стъпка 3 — Публикуване
- **🖼️ Обложка** — Gemini image модел (Nano Banana / `gemini-2.5-flash-image`).
- **🎧 DistroKid** — auto-fill асистент (генерира текстовете, не автоматизира
  самия DistroKid сайт — браузърът не може да управлява друг сайт).
- **🎵 Spotify / Apple** — готови bio текстове за Spotify for Artists / Apple
  Music for Artists.
- **📺 YouTube A/B** — 3 варианта заглавие+thumbnail текст, с кратък Gemini
  "глас" кой е по-clickable.
- **🛡️ Проверка за прилика** — бърза YouTube search проверка дали заглавието
  вече не е твърде близо до съществуваща песен.
- **🎬 Кратки видео сценарии** — 3 промо сценария за TikTok/Reels/Shorts
  (visual hook, beats, caption, хаштагове) — различни от текста на песента.
- Директно качване в YouTube (unlisted) през Google OAuth.

### Gemini Validator
Автоматичен кратък анализ ("втори поглед") след всяка стъпка (trend scan,
концепция, текст, FX, обложка, album sprint, A/B заглавия). Логът се трупа
и е видим в "Втори поглед (Лог)" в sidebar-а.

---

## 🧠 AI Model Finder (ново, обединено на 2026-08-08)

Отделен проект (`SCRAPER.zip`), сега обединен в това repo като самостоятелна
папка `ai-model-finder/` — **и вграден директно в AI логиката на таблото**
като четвърти, реален provider (виж v1.22.0 в Changelog). Не заменя
Claude/Gemini/OpenRouter — стои като допълнителен, автоматичен резервен
път навсякъде, където таблото "иска AI" (Стъпка 1-3, System Test, Gemini
Validator и т.н.), през общата функция `callAI()`.

- Достъпен е от sidebar-а: **Инструменти → 🧠 AI Model Finder** — там са и
  ключовете (Groq/Mistral/GitHub Models/Cloudflare), и линк към отделния
  инструмент за откриване на нови модели.
- **Реално извикваеми източници** (5): Groq, Mistral AI, GitHub Models,
  Cloudflare Workers AI (всички изискват безплатен ключ) и **Pollinations
  (БЕЗ никакъв ключ)** — благодарение на Pollinations, таблото винаги има
  поне един работещ AI път, дори с нулева конфигурация никъде другаде.
  Извикването минава през същия споделен `runModelFallbackLoop()`
  (`js/providers/fallback-loop.js`), който вече ползват Claude/Gemini/
  OpenRouter — вижте т.7 от одита в `AUDIT_PROGRESS.md`.
- Hugging Face участва само в информационния списък (не в автоматичното
  извикване) — твърде много произволни community модели с непредвидим
  chat формат, за да е безопасно за автоматичен fallback.
- Отделна страница (`ai-model-finder/index.html`, публикувана през GitHub
  Pages) с бутон „Намери ми AI модели" — скрейпва и осемте източника
  директно в браузъра, за информационния списък по-горе.
- Node вариант (`ai-model-finder/scraper.mjs`) + GitHub Action
  (`.github/workflows/scrape-ai-models.yml`), който всяка нощ в 03:00 UTC
  сам обновява `ai-model-finder/ai-models.json` и проверява ключовете
  (`ai-model-finder/check-keys.mjs`) — при счупен ключ отваря GitHub issue.
- Настройки → Предпочитания → "AI за генериране на съдържание" вече има и
  опция **"🧠 AI Model Finder"** за ръчен избор, редом до Claude/Gemini/
  OpenRouter.
- Пълна таблица със secret имена и линкове за регистрация за нощното
  автоматично обновяване: `ai-model-finder/README.md`.
- `ai-model-finder/keys.json` е само за локален `node scraper.mjs` тест на
  твоята машина и **никога** не се качва в git (виж root `.gitignore`); в
  GitHub Actions се създава на момента от Secrets.

## CORS Proxy (по избор)

Някои заявки (autocomplete suggestions, понякога Imagen) нямат CORS хедъри
и браузърът ги блокира директно. Решение — малък Cloudflare Worker посредник:

1. **dash.cloudflare.com** → регистрация (само имейл, безплатно).
2. **Workers & Pages → Create → Create Worker** → "Hello World" темплейт.
3. Дай му име → **Deploy**.
4. **Edit code** → изтрий всичко → постави съдържанието на `cdb-proxy-worker.js`
   (виж отделния файл, ако е предоставен, или прегледай app.js `proxied()`
   функцията за очаквания формат — `?target=ORIGINAL_URL`) → **Deploy**.
5. Копирай URL-а (`https://твоя-worker.workers.dev`) → сложи го в таблото:
   **Настройки → Proxy & Мрежа → Proxy URL** → Запази.

Празно поле = директни заявки (стандартно, работи за повечето неща).

---

## Дневен Trend Tracker (GitHub Actions — жанрове/ниши)

Тегли YouTube данни (растеж на публикуване + конкуренция) за списък
жанрове от `config.json` → `trend_niches`, веднъж на ден, **без никаква
Gemini квота** (grounding изобщо не се ползва).
Dashboard-ът само чете готовия резултат.

### Еднократен setup

1. Ако вече си настроил "Дневна статистика" по-долу — GitHub Secret
   `YOUTUBE_API_KEY` вече е наличен и се преизползва тук, нищо повече не
   трябва да добавяш.
2. (По избор) Отвори `config.json` → редактирай `trend_niches` списъка с
   жанровете, които искаш да следиш (по подразбиране има 15 популярни/
   набиращи популярност звучения).
3. За да тестваш веднага, без да чакаш до утре: **Actions таб → "Daily
   Music Trend Tracker" → Run workflow** (ръчно пускане).
4. Готово. Workflow-ът в `.github/workflows/daily-trends.yml` ще се пуска
   автоматично всеки ден в ~08:00 UTC.
5. В таблото трябва да имаш вече попълнени **Настройки → YouTube Тракер**
   полета (GitHub потребител/организация + repo) — dashboard-ът
   преизползва точно тях, за да прочете `data/trends-history.json`.

### Как работи

`scripts/track_trends.py`: за всяка ниша сравнява брой публикувани видеа
последните 14 дни спрямо предходните 14 (растящо темпо на публикуване =
растящ интерес), плюс общ брой/средни views на топ YouTube видеа от
последните 30 дни (конкуренция). Комбинира двете в `score` 0-100 и пише
нов snapshot в `data/trends-history.json` — версионирана история, същата
схема като `stats-history.json`.

**История:** по-рано growth сигналът идваше от Google Trends (библиотека
`pytrends`). Google блокира IP адресите на GitHub Actions runner-ите
(429 на всяка заявка) — известно ограничение на неофициални Trends
scraper-и в CI/cloud среди. Затова growth сега идва изцяло от YouTube,
което вече е потвърдено стабилно оттук.

---

## Дневна статистика (GitHub Actions YouTube Tracker)

Проследява целия YouTube канал автоматично, всеки ден, дори когато таблото
не е отворено — истински сървърен cron, безплатен през GitHub Actions.

### Еднократен setup

1. **Намери своя YouTube Channel ID**
   (YouTube Studio → Настройки → Канал → Основни данни, или чрез линка на
   канала `youtube.com/channel/UCxxxxxxxx` — частта след `/channel/`).
2. Отвори `config.json` в repo-то → замени `"REPLACE_WITH_YOUR_CHANNEL_ID"`
   с твоя Channel ID → commit.
3. **Добави GitHub Secret:**
   Repo → **Settings → Secrets and variables → Actions → New repository secret**
   → Name: `YOUTUBE_API_KEY` → Value: твоя YouTube Data API ключ → Add secret.
4. Готово. Workflow-ът в `.github/workflows/daily-stats.yml` ще се пусне
   автоматично всеки ден в ~09:00 UTC (може да закъснее с до 30 мин — без
   значение за дневна статистика).
5. За да тестваш веднага, без да чакаш: **Actions таб → Daily YouTube Stats
   Tracker → Run workflow** (ръчно пускане).
6. В таблото: **Настройки → YouTube Тракер** → въведи твоя GitHub
   потребител/организация + име на repo → Запази. Dashboard-ът и Анализи &
   Графики секциите ще започнат да четат `data/stats-history.json` директно
   от GitHub (публичен suraw файл, не изисква ключ за четене).

### Как работи

`scripts/track_stats.py` тегли статистика на канала (абонати, общо views,
брой видеа) и на всяко видео (views/likes/comments) през YouTube Data API,
и добавя нов "snapshot" с дата в `data/stats-history.json` — версиониран
JSON (`schema_version`), който се трупа във времето (1 запис на ден, не се
трие нищо старо). Ако скриптът се пусне повторно в същия ден, замества само
днешния запис — историята остава чиста.

### Схема на данните

```json
{
  "schema_version": 1,
  "channel_id": "UCxxxxxxxx",
  "snapshots": [
    {
      "date": "2026-07-22",
      "timestamp": "2026-07-22T09:03:11Z",
      "channel": { "subscribers": 12540, "total_views": 1245890, "video_count": 128 },
      "videos": [
        { "video_id": "abc123", "title": "Midnight Dreams", "published_at": "2026-07-10T...",
          "views": 24520, "likes": 2400, "comments": 320 }
      ]
    }
  ]
}
```

---

## Модулна структура (за лесно разширяване без пренаписване)

- `index.html` / `app.js` — таблото. Четат данни, не ги генерират.
- `js/ui/toast.js`, `js/ui/guard-click.js` — чист DOM, без зависимости.
- `js/network.js` — `fetchTimeout`, `proxied` (общи мрежови helper-и).
- `js/agent-roster.js` — дневен "ростър" от РЕАЛНО проверени работещи AI
  модели (виж Changelog v1.20.0) — отделен от providers/*.js нарочно, за
  да могат providers/*.js да си останат "как се вика конкретен модел",
  а не и "кои модели изобщо да пробваме".
- `js/providers/claude.js`, `js/providers/gemini.js`, `js/providers/openrouter.js` — целият AI provider код (Claude/Gemini + трети "безплатен tier" agent).
- `js/providers/model-finder.js` (`ModelFinder`) — само чете
  `ai-model-finder/ai-models.json` и го показва в новия view "AI Model
  Finder" (виж Changelog v1.21.0). НЕ участва във fallback-а на
  Claude/Gemini/OpenRouter — самостоятелен, информационен bridge.
- `ai-model-finder/` — отделен, самостоятелен инструмент (обединен в това
  repo на 2026-08-08, виж Changelog v1.21.0): браузърен + Node скрапер за
  безплатни AI модели (HF, OpenRouter, Gemini, Groq, Mistral, Cloudflare
  Workers AI, GitHub Models, Pollinations, Jina). Собствен `README.md`
  вътре с пълни инструкции за ключове/secrets.
- `js/youtube.js` — YouTube Data API + autocomplete suggest.
- `js/niche-toolkit.js` — Spotify-базиран niche score, AI промптове за
  Suno/Udio, Release Playbook — самостоятелен раздел, не пипа останалото.
- `js/system-test.js` — диагностика на цялото приложение + AI одит за
  нови функции (виж Changelog v1.8.0); архивът от идеи (по заглавие, виж
  v1.14.0) вече е собствен view (`view-ai-ideas`), не карта в теста.
- `js/auth-gate.js` — по избор екран за поверителност пред целия dashboard
  (виж Changelog v1.10.0 и "Известни ограничения").
- `visualizer.html` — самостоятелен визуализатор, вграден през `<iframe>`.
- `scripts/track_stats.py` — самостоятелен tracker за твоя канал (YouTube).
- `scripts/track_trends.py` — самостоятелен tracker за жанрове/ниши (Google
  Trends + YouTube конкуренция); нови платформи/сигнали → нов файл, без да
  пипаш този.
- `.github/workflows/` — всеки нов автоматизиран job = нов `.yml` файл тук,
  не се редактира съществуващият.
- `config.json` — публична конфигурация (канал ID, следени платформи).
  Нови платформи/канали = нови полета, старият код продължава да работи.
- `data/stats-history.json` — версионирана история (`schema_version`),
  нови полета в бъдеще не чупят старите записи.

## Известни ограничения

- **Биометрия (WebAuthn) е по устройство/браузър, не глобален профил:**
  ако регистрираш пръстов отпечатък на телефона си в Chrome, тя няма да
  работи в друг браузър на същия телефон, нито на друго устройство —
  там винаги остава наличен резервният вариант потребител+парола. Изисква
  HTTPS (или `localhost`); в по-стари/нестандартни браузъри бутонът просто
  ще върне грешка, обяснена в самия lock screen.

- **Стъпка 3 (DistroKid):** auto-fill асистент, не автоматизира самия
  DistroKid сайт (browser security).
- **musicalSEO-подобни данни:** ползваме Google/YouTube autocomplete
  (неофициален endpoint) вместо платен инструмент — изисква Proxy URL.
- **GitHub Actions cron:** не е прецизен до минута (може да закъснее до
  ~30 мин) — без значение за дневна статистика.
- **Spotify/Apple Music реални стриймове:** все още не се следят
  автоматично (изисква отделен developer акаунт) — текстовете за профилите
  им се генерират, но не и live статистика оттам.
- **"🔒 Достъп до dashboard-а" (Auth Gate) е екран за поверителност, НЕ
  истинска защита:** чисто клиентска проверка (localStorage + PBKDF2 hash
  на "потребител::парола"), без сървър, който да я налага. Спира случаен
  поглед, не спира някой с достъп до DevTools (може директно да изтрие
  ключалката). Ако забравиш логина си:
    - **От компютър:** DevTools конзолата (F12) → изпълни
      `localStorage.removeItem('cdb_auth_gate_hash_v1')` → презареди.
    - **От телефон** (няма лесен достъп до DevTools): добави `?resetGate=1`
      в края на адреса на сайта в адресната лента (напр.
      `https://твоя-сайт.github.io/?resetGate=1`) и потвърди диалога, който
      се появява. Трие САМО ключалката (потребител+хеш на паролата) —
      останалите ти данни (проекти, API ключове, история) не се пипат.
      Не е бутон в интерфейса нарочно (виж по-долу) — трябва изрично да
      знаеш и напишеш параметъра сам.
  И в двата случая данните ти НЕ се трият — трие се само самата ключалка.
  Няма бутон за това в интерфейса нарочно — иначе би бил байпас за всеки
  друг, не само теб.

## Изградени идеи от AI екипа

Тук се записва — с ТОЧНОТО заглавие, което AI екипът ("🤖 Питай AI екипа
за нови функции", виж Системен тест) е дал на идеята — всяка идея, която
реално е изградена. Служи като траен, четим от хора запис (git история),
успореден на автоматичния архив в самото табло
(**🗂️ Архив на идеи от AI екипа** в sidebar-а, localStorage).

**Работен процес:**
1. AI екипът предлага идея (напр. "**Hook Strength Score**") →
   автоматично се записва в архива в таблото.
2. Копираш заглавие + описание, подаваш ги на Claude/Claude Code, за да я
   изградите заедно.
3. Щом е готова: (а) добавя се запис тук по-долу със същото заглавие, и
   (б) маркираш я "✅ Маркирай като изградено" в архива в таблото (или
   ползваш "➕ Добави / маркирай идея ръчно" там, ако не е минала през
   стъпка 1 в тази инсталация).

**Защо и двете, а не само README:** приложението е чисто браузърно (без
сървър) — при всяко "Питай AI екипа" JS-ът праща на модела списъка с
вече изградени неща directно от localStorage архива в таблото, не чете
README на живо (offline PWA кеш + различни среди биха направили това
ненадеждно). README-то тук е за хора/git история; архивът в таблото е
това, което РЕАЛНО спира AI екипа да предложи нещо повторно.

- **Short-Form "Viral Scripting" Engine** — Стъпка 3 → "15 · Кратки видео
  сценарии (TikTok/Reels/Shorts)" (`Step3.generateShortFormScripts()`,
  `app.js`). 3 промо видео сценария (POV / behind-the-scenes / visual
  hook), не текста на песента.
- **Revenue & Stream Projection Simulator** — Niche Toolkit → "💰 Приходна
  прогноза" (`NicheToolkit.Revenue`, `js/niche-toolkit.js`). Чисто
  клиентска сметка (без AI квота) за груба месечна приходна прогноза.
- **Dynamic Release Asset Roadmap** — нов раздел "🗓️ Release Roadmap"
  (`js/release-roadmap.js`). Чек-лист, генериран според датата на
  пускане, с прогрес запазен локално.
- **API Health & Connectivity Dashboard** — Настройки → API Ключове,
  под "🧪 Тествай ключовете" (`Settings.renderKeyHealth()`, `app.js`).
  Визуални чипове с категоризирана диагноза (невалиден ключ / изчерпана
  квота / грешни права) вместо суров HTTP статус.
- **Live Feature Inventory (анти-дублиране на AI предложения)** —
  `SystemTest.scanFeatureInventory()` (`js/system-test.js`). Сканира
  реалния DOM вместо ръчно поддържан текст, за да не изостава списъкът
  "съществуващи функции", подаван на AI екипа/външни консултанти.

## Идеи за следващо

- **Discovery слой за Profit Niche Scanner** (следващ приоритет) — 4
  независими, безключови източника (YouTube Trending Chart, Wikipedia
  растящи статии от категория "Music genres", MusicBrainz скорошна
  тагова активност, Reddit нови/растящи subreddit-и), за да намира
  сам актуални ниши вместо статичния `trend_niches` списък. Термин,
  засечен от ≥2 източника, автоматично влиза в следващия скен — нула
  ръчна намеса, потвърдено изрично от потребителя. Виж пълния дизайн в
  `AUDIT_PROGRESS.md`, запис 2026-08-11.
- Discogs, ListenBrainz, YouTube RSS — допълнителни Demand/Community
  сигнали за `track_niche_scores.py`, съзнателно оставени за после.
- `config.json` → ново поле `niche_scan_niches` с per-ниша feasibility/
  monetization (скриптът засега пада обратно към `trend_niches` с
  неутрални стойности).
- Директна YouTube `search.list` заявка за по-твърди SEO числа, комбинирана
  с Gemini оценката.
- Проверка на свободен домейн за бранд името на изпълнителя.
- Voice prompting през вградения browser Web Speech API.
- Истинско AI четене/писане в GitHub repo-то (GitHub Contents API) — в
  момента полето за GitHub Token само се пази/тества, реално записване на
  файлове през AI-то още не е построено.
- Централизиран `State` (`ui`/`settings`/`currentProject`/...) вместо
  плосък `AppState.data.project` — последната, най-рискова стъпка от
  модулното разделяне (виж Changelog v1.5.0). `network/`, `providers/`,
  `youtube/` и `ui/` вече са извадени от `app.js`.

## Changelog

### v1.27.1 — 2026-08-12 (Fix: prompt wrapper конфликт + code-генерирано 3D лого)
- 🐛 **Fix `js/step3.js`** — премахнат hardcoded семантичен wrapper
  ("Square album cover art, professional streaming cover, 1:1
  composition: ...") пред промпта на потребителя, и в
  `_generateCoverImagePollinations()`, и в `_generateCoverImageGemini()`.
  Причина: когато потребителят иска нещо различно от "обложка на
  албум" (напр. лого), добавеният контекст директно конкурираше с
  реалната заявка → несвързани резултати. Сега промптът се подава
  практически буквално, само с технически quality-суфикс.
- 🆕 **`js/providers/code-logo.js`** — 100% code-генерирано 3D
  текстово лого (Canvas 2D: extrusion слоеве + градиент + bevel
  highlight + сянка), **БЕЗ AI** — трета опция до другите два бутона
  за обложка, за случаи в които се иска ГАРАНТИРАНО точен текст
  (дифузионните AI модели нямат такава гаранция — известно
  ограничение на технологията). Нов бутон "🔤 Генерирай код-лого" с
  полета за основен текст (по подразбиране "CD-B Records") и по избор
  подзаглавие.
- 🧪 `node --check` чисто на `js/providers/code-logo.js` и `js/step3.js`;
  `<div>` баланс в `index.html` проверен (345/345).

### v1.27.0 — 2026-08-11 (Пълноценна AI-агент интеграция — обложки/текст/субтитри, по заявка на потребител)
- 🆕 **`js/providers/pollinations-image.js`** — безплатна генерация на
  изображения (image.pollinations.ai), БЕЗ никакъв API ключ. `Step3.
  generateCoverImage()` вече пробва Gemini/Imagen първи (ако има ключ),
  но при грешка ИЛИ липсващ ключ автоматично пада на Pollinations —
  функцията вече работи и с нулева конфигурация. Нов отделен бутон
  **"🆓 Безплатна обложка"** прескача Gemini директно.
- ✏️ **`js/step1.js` → `generateLyrics()`** — промптът вече изрично
  забранява AI клишета ("electric nights", "chasing dreams", "unbreakable
  bond" и подобни), иска конкретни/специфични образи, естествен неидеален
  ритъм на фразите, без повтаряне на идеи между куплетите. **`callAI()`**
  (`js/ai-helpers.js`) вече приема трети, по избор параметър `forceFirst`
  — за текста на песента винаги пробва **Claude първи** (най-естествен
  резултат), с пълен fallback синджир към Gemini/OpenRouter/Model Finder
  непроменен.
- 🆕 **`js/providers/subtitles.js`** — автоматична транскрипция на аудио
  → синхронизирани `.srt` субтитри, през Groq Whisper
  (`whisper-large-v3-turbo`, безплатен tier, **същия** Groq ключ, който
  вече се ползва за резервен AI текст в AI Model Finder — не е нужен
  нов ключ/регистрация). Нов бутон **"🎬 Генерирай субтитри"** в
  "⚡ Бърз ъплоуд" — timestamp-ите са 1:1 синхронизирани с видеото
  (направено директно от същия аудио файл).
- ✏️ **`js/step4.js`** — OAuth scope разширен с
  `youtube.force-ssl` (нужен за `captions.insert`); нов метод
  `Step4.uploadCaptions(videoId, srt, languageCode)`. **⚠️ Потребителите,
  вписани в Google ОТПРЕДИ тази версия, трябва да се впишат отново**
  (бутон "🔑 Вход с Google"), за да получат новия scope — иначе
  автоматичното прикачване на субтитри ще гръмне 403.
- ✏️ **`js/quick-upload.js`** — нов метод `generateSubtitles()`
  (транскрибира `this.audioFile`, показва бутон "⬇️ Свали .srt");
  `autoUpload()`/`manualUpload()` вече автоматично извикват
  `Step4.uploadCaptions()` след успешен video upload, ако субтитрите
  вече са генерирани — с ясен ⚠️ лог (не прекъсва качването), ако
  прикачването гръмне.
- 📝 `index.html` — нови `<script>` тагове за двата нови provider-а,
  нов бутон за безплатна обложка (Стъпка 3), нов бутон + изходен `<div>`
  за субтитри ("⚡ Бърз ъплоуд"), бележка до Groq ключовото поле.
- 🧪 `node --check` чисто на всичките 7 засегнати/нови JS файла;
  `npm test` непроменено (73/73 — нищо от съществуващите тествани
  модули не е пипнато). **Живите заявки към Pollinations/Groq Whisper и
  реалното `captions.insert` качване НЕ са тествани на живо** (средата
  за писане няма достъп до тези endpoint-и/valid ключове) — очаква се
  първо ръчно пускане от потребителя за потвърждение.
- ⚠️ **Известен технически дълг, непроменен от тази версия:** root-ниво
  дубликати на много `js/*.js` файлове (напр. `step1.js`, `storage.js`,
  `viral-lab.js` и др. извън `js/`) не се зареждат от `index.html` —
  вероятно остатък от стар layout преди модулизацията. Не са пипани тук,
  чака отделно почистване по желание на потребителя.

### v1.26.0 — 2026-08-11 (Profit Niche Scanner — автоматичен седмичен скенер, БЕЗ Spotify)
- 🆕 **`scripts/track_niche_scores.py`** — сам анализира ВСИЧКИ ниши от
  `config.json` наведнъж, всеки понеделник (за разлика от `analyzeNiche()`/
  `analyzeNicheExtended()` в таблото — ръчен клик, по 1 ниша, и двата
  остават непипнати). Demand = медиана от 3 независими източника (Deezer +
  iTunes Search API + MusicBrainz), за надеждност — kworb.net само като
  последна резерва. Momentum = Wikipedia Pageviews. Community = Reddit
  subscribers (нов под-индекс, извън оригиналните 5). **Изрично БЕЗ
  Spotify** — дори анонимният embed достъп е потвърдено ненадежден (403,
  Spotify затегна достъпа за малки приложения от май 2025).
- 🆕 **`.github/workflows/niche-scores.yml`** — понеделник 08:00 UTC +
  ръчно пускане, commit на резултата обратно в repo-то.
- 🆕 **`NicheToolkit.loadAutoNicheRanking()`** — нова карта "🏆 Автоматична
  седмична класация на ниши" в Niche Toolkit view, чете
  `data/niche-scores-history.json`, нула заявки от браузъра.
- ⚠️ **Известен проблем:** списъкът с ниши идва от `trend_niches` в
  `config.json` — статичен, ръчно въведен, не се самообновява. Договорен
  (не построен още) discovery слой от 4 независими източника (YouTube
  Trending, Wikipedia растящи статии, MusicBrainz нови тагове, Reddit
  нови subreddit-и) — виж `AUDIT_PROGRESS.md` за пълния план.
- 🧪 `npm test` → 73/73 непроменено. Живите мрежови заявки към новите
  източници НЕ са тествани — очаква се първо пускане на workflow-а.

### v1.25.0 — 2026-08-10 (Niche & Signal — нов 5-под-индекс модел + безключови сигнали, ADDITIVE)
- 🆕 **`js/niche-scoring.js`** — чист, детерминистичен scoring модул (виж
  пълния дизайн, договорен по-рано същия ден в `AUDIT_PROGRESS.md`):
  Demand / Momentum (rising→collapsing, с acceleration от няколко
  snapshot-а, не само последния) / Opportunity (HHI-базирана
  концентрация — НЕ линейно "100-конкуренция") / Monetization /
  Feasibility (ръчна, субективна). Централни тегла (`DEFAULT_WEIGHTS`),
  insufficient-data → тежестта се преразпределя пропорционално, никога
  измислена стойност. `compareNiches()` — сравнение с "защо A > B" по
  най-голямата разлика в под-индекс, не просто по-голямо число.
- 🆕 **`js/niche-data-sources.js`** — безключови допълнителни сигнали:
  Deezer (`api.deezer.com`, artist fans), iTunes Search API
  (`itunes.apple.com/search`), MusicBrainz (`musicbrainz.org/ws/2`,
  метаданни/тагове), YouTube RSS (`/feeds/videos.xml`, channel
  activity без API quota). Всяка функция връща `{available:false,
  error}` при провал вместо да хвърля грешка — един счупен източник
  никога не спира анализа.
  - CORS бележка: Deezer и YouTube RSS минават през `proxied()`
    (нямат CORS хедъри); iTunes Search API и MusicBrainz — директен
    fetch (документирано CORS-enabled).
- 🆕 **`NicheToolkit.analyzeNicheExtended()`** в `js/niche-toolkit.js` —
  нов, ДОПЪЛНИТЕЛЕН панел "📊 Разширени сигнали" в UI (не заменя
  стария `analyzeNiche()`/"🎯 Анализирай нишата" — и двата остават,
  ползвателят вижда и двата резултата). Momentum тук чете **няколко**
  snapshot-а от `data/trends-history.json` (ако нишата съвпада с
  проследяваните 15 в `config.json`), не само последния ден.
  Feasibility — нов ръчен слайдър (1-5) в UI.
- ✅ **27 нови unit теста** в `test/niche-scoring.test.mjs` — точно
  сценариите от оригиналното задание: high demand+low/high
  competition, ключовият "малка бързорастяща ниша бие голяма
  пренаситена" сценарий, low demand+high growth, declining,
  напълно/частично липсващи данни, преразпределение на тежести,
  екстремни стойности, детерминизъм (еднакъв вход→еднакъв изход),
  сравнение на ниши. `npm test` → **73/73** (46 стари + 27 нови).
- 📝 `ARCHITECTURE.md` — добавени редове за двата нови модула.

### v1.24.0 — 2026-08-10 (Niche & Signal / Profit Niche Score — Spotify вече е опционален)
- 🔓 **Spotify Client ID/Secret вече не е твърдо изискване** в
  `js/niche-toolkit.js` (`ntGenre` → "🎯 Анализирай нишата" гърмеше
  `❌ Липсват Spotify Client ID / Client Secret`, без значение какво
  друго е конфигурирано). Ако официалните ключове липсват, автоматично
  се пробва анонимен `open.spotify.com` web-player token (неофициален,
  без регистрация) — минава през същия `proxied()` механизъм, изисква
  Proxy URL в Настройки.
- 🛡️ **Spotify грешка вече не блокира целия анализ.** Преди: всяка
  Spotify грешка (липсващ ключ, счупен token, rate limit) хвърляше
  изключение, което спираше и YouTube частта. Сега:
  `_searchSpotifyTracksByGenre()` хваща грешката вътрешно и връща
  `{ tracks: [], error }` — YouTube анализът продължава независимо.
- ⚖️ **Динамично преразпределяне на тежести**, ако Spotify данни
  липсват — вместо `avgPopularity=0 * 0.35` тихо да наказва score-а с
  до 35 точки, тежестта се преразпределя пропорционално към YouTube
  views (0.4→0.62) и свободна ниша (0.25→0.38) сигналите.
- 🏷️ Нов **Confidence badge** (HIGH/MEDIUM/LOW) на резултата — честна
  оценка колко сигнала реално са налични, вместо винаги да изглежда
  еднакво сигурен.
- 📝 UI текстът в `index.html` е коригиран — вече казва "Spotify е
  опционален" вместо "Изисква Spotify + YouTube ключове".
- ✅ `npm test` → 46/46 преди и след.

### v1.23.0 — 2026-08-10 (AI Model Finder bugfix — 404 надпис + подвеждащ филтър "модели за сваляне")
- ⚙️ **Node.js 20 deprecation warning оправен** в `scrape-ai-models.yml`
  **и** `run-tests.yml` (същия проблем и в двата) — `node-version: "20"`
  сменено на `"lts/*"`, за да не се налага ръчна поправка при всяко
  следващо GitHub deprecation на конкретна Node версия.
- 🌙 **`.github/workflows/scrape-ai-models.yml` реално добавен** (не само
  спомен в стар changelog запис — v1.22.0 го отбелязваше като "върнат",
  но файлът така и не съществуваше в `.github/workflows/`, затова
  панелът "🧠 AI Model Finder" винаги гърмеше `HTTP 404` при опит да
  прочете `ai-model-finder/ai-models.json`, без значение какво
  потребителят пробваше в самия инструмент). Пуска се нощно в 03:00 UTC
  + ръчно от Actions таба, работи с нула ключове (публични каталози +
  куратирани списъци), комитва резултата обратно в repo-то.
- 🏷️ **Ново поле `verified`** на всеки модел в `ai-model-finder/scraper.mjs`
  и `ai-model-finder/app.js` — `true` само за endpoints с потвърдена,
  универсална работеща форма (chat/embedding през `router.huggingface.co`,
  OpenRouter, и всички куратирани Gemini/Groq/Mistral/Cloudflare/GitHub
  Models/Pollinations/Jina записи); `false` за HuggingFace image/audio
  модели, чийто endpoint е provider-специфичен и невинаги реално работи
  на генеричния path — вместо тихо да го представяме като сигурен.
- 🔀 **Сортиране сменено от `downloads` на `trending`** (HuggingFace заявка)
  + `verified` модели винаги първи в крайния списък — старото сортиране
  по сваляния извеждаше най-често сваляните-за-локално модели най-отгоре,
  визуално четящо се като "инструмент за сваляне на модели", макар
  инструментът да е за онлайн inference.
- ✅ **Нов чекбокс "Само проверени"** в `ai-model-finder/index.html`
  (включен по подразбиране) + badge ✅ онлайн / ⚠️ провери endpoint на
  всеки резултат — заменя стария подвеждащ текст "— N сваляния".
  Информационният панел в основното табло (`js/providers/model-finder.js`)
  показва същия badge.
- ✅ `npm test` минава **46/46** преди и след промените; `node --check`
  чисто на всички пипнати JS файлове. Реалните мрежови извиквания
  (HuggingFace/OpenRouter) не бяха тествани в средата, в която е
  направена промяната — очаква се потвърждение след първото ръчно
  пускане на Action-а.

### v1.22.0 — 2026-08-08 (AI Model Finder става РЕАЛЕН, извикваем provider — не само списък)
- 🔌 **`js/providers/model-finder.js` пренаписан** — вече не е само
  информационен панел, а истински 4-ти AI provider с 5 извикваеми
  източника: **Groq, Mistral AI, GitHub Models, Cloudflare Workers AI**
  (изискват безплатен ключ) и **Pollinations (БЕЗ никакъв ключ)**.
  Hugging Face остава само в информационния списък (твърде непредвидим
  chat формат за автоматичен fallback). Единичното извикване минава през
  споделения `runModelFallbackLoop()` (`js/providers/fallback-loop.js`,
  т.7 от одита) — по същия принцип като Claude/Gemini/OpenRouter, вместо
  собствен цикъл.
- 🔁 **`callAI()` в `app.js`** (единствената функция, през която ВСЯКО
  място в таблото иска AI — Стъпка 1-3, System Test, Gemini Validator...)
  вече включва `modelfinder` в края на fallback реда:
  Claude → Gemini → OpenRouter → **AI Model Finder**. Резултат: таблото
  винаги има поне един работещ AI път, дори с нулева конфигурация никъде
  другаде, благодарение на Pollinations.
- 🧪 **`Settings.testKeys()`** вече тества и петте нови източника (реална
  тестова заявка към всеки с ключ) и вкарва `modelfinder` в
  `AIProviderOrder`, ако РЕАЛНО е отговорил — по същия принцип като
  Claude/Gemini/OpenRouter по-горе.
- 🔑 **5 нови полета за ключове** в sidebar view "🧠 AI Model Finder":
  Groq API Key, Mistral API Key, GitHub Models PAT, Cloudflare API Token +
  Account ID. Съхраняват се в същия `Keys` обект (localStorage/Vault) като
  останалите. `Settings.fillFields()`/`Settings.save()` разширени
  съответно.
- 🎛️ **Ново меню** "🧠 AI Model Finder" в двата dropdown-а "AI за
  генериране на съдържание" (горен бар + Настройки → Предпочитания) — за
  ръчно закачане отпред, ако искаш точно тези модели да пишат навсякъде.
- 📋 `AICallLog`/`QuotaTracker`/`renderKeyHealth` разширени да разпознават
  provider `"modelfinder"` (лейбъл, цветен chip диагноза, leaderboard).
- 🌙 Върнат липсващият `.github/workflows/scrape-ai-models.yml` (нощно
  автоматично обновяване на `ai-model-finder/ai-models.json`, 03:00 UTC).
- 📦 `sw.js`: `CACHE_VERSION` вдигнат на `cdb-shell-v23`, добавен
  `js/providers/fallback-loop.js` в `SHELL_FILES` (липсваше от кеш
  списъка, макар вече да се зареждаше в `index.html`).
- ✅ **Съвместимост с одитната инфраструктура от `AUDIT_PROGRESS.md`**:
  цялата интеграция е приложена ВЪРХУ вече одитираната кодова база
  (fallback-loop.js рефакторинга, тестовете, `.gitignore`) — `npm test`
  минава **40/40 преди И след** промените, `node --check` чисто на
  всички JS файлове, броят view/nav елементи в `index.html` съвпада
  (19/19).

### v1.21.0 — 2026-08-08 (обединяване с отделния проект "AI Model Finder")
- 🧩 **Нова папка `ai-model-finder/`** — цял отделен проект (браузърен +
  Node скрапер за безплатни AI модели: HF, OpenRouter, Gemini, Groq,
  Mistral, Cloudflare Workers AI, GitHub Models, Pollinations, Jina),
  копиран в repo-то като самостоятелен подпът (собствени
  `index.html`/`app.js`/`worker.js`/`scraper.mjs`/`check-keys.mjs`/
  `README.md`/`keys.json`/`.gitignore`). Няма конфликт с root файловете
  на таблото (`index.html`/`app.js` на таблото са напълно отделни от
  `ai-model-finder/index.html`/`ai-model-finder/app.js`).
- ⏰ **Нов workflow `.github/workflows/scrape-ai-models.yml`** (взет от
  оригиналния `scrape.yml`, преименуван и пътищата пренасочени към
  `ai-model-finder/…`, за да не се сблъска с вече съществуващите
  `daily-stats.yml`/`daily-trends.yml`) — крон всяка нощ в 03:00 UTC:
  генерира `ai-model-finder/ai-models.json`, проверява ключовете, отваря
  issue `⚠️ Счупен API ключ (AI Model Finder)` при провал.
- 🔗 **Нов bridge модул `js/providers/model-finder.js` (`ModelFinder`)** —
  чете (read-only) `ai-model-finder/ai-models.json` и го показва в новия
  sidebar view **Инструменти → 🧠 AI Model Finder** (бутон „Обнови
  списъка тук" + линк към пълния инструмент в нов таб). Кешира резултата
  6ч в `localStorage`, по същия принцип като останалите provider кешове.
  **Не се качва във fallback реда на Claude/Gemini/OpenRouter** — чисто
  информационен слой, нулев риск за съществуващата AI логика на таблото.
- 🗂️ Нов view `view-model-finder` в `index.html` + hook в `Nav.showView`
  (`app.js`) + нов `<script src="js/providers/model-finder.js">` (зареден
  веднага след `openrouter.js`).
- 📦 Service Worker (`sw.js`): `CACHE_VERSION` вдигнат на `cdb-shell-v22`,
  добавен `js/providers/model-finder.js` в `SHELL_FILES` (за offline
  черупка); `ai-model-finder/ai-models.json` НЕ е в shell списъка нарочно
  — минава директно през мрежата (същия принцип като AI/YouTube/GitHub
  API отговорите), за да не показва остарял списък модели.
- 🙈 Нов root `.gitignore` (repo-то преди нямаше такъв) — само за
  `ai-model-finder/keys.json`, за да не влязат ключове в git по невнимание
  при локален тест на скрапъра.
- ✅ Всички съществуващи файлове/логика (Claude/Gemini/OpenRouter provider
  код, Viral Lab, Track Record, YouTube Тракер и т.н.) — **непроменени**.
  Проверено: всички JS файлове минават `node --check` без грешки, двата
  YAML workflow-а са валиден YAML, броят view/nav-btn елементи в
  `index.html` съвпада (19/19).

### v1.20.1 — 2026-08-08 (bugfix — фалшиво "не работи" при OpenRouter Google AI Studio модели)
- 🐛 Тестовите пинг-заявки (AgentRoster роустър проверка + "🧪 Тествай
  ключовете" в Настройки) пращаха `max_tokens: 5` към OpenRouter. Някои
  безплатни модели, рутирани през Google AI Studio (Gemini free
  варианти), връщат `400 INVALID_ARGUMENT` при такъв малък бюджет
  (недостатъчен за вътрешния им "thinking" стъп) — моделът РЕАЛНО работи,
  но тестът грешно го маркираше като неуспешен. Вдигнат на `max_tokens:
  16` в `js/agent-roster.js` и `app.js`.
- 🐛 "🧪 Тествай ключовете" за OpenRouter вече пробва до 8 модела по ред
  (подредени по надеждност), не само `models[0]` — същия принцип като
  Claude/Gemini проверките до него.
- 🐛 `callOpenRouter()` (`js/providers/openrouter.js`) вече третира `400`
  от даден модел като "прескочи и пробвай следващия" (маха го от
  днешния ростър, продължава с останалите), вместо да прекъсне цялото
  извикване — `400` от ЕДИН модел не значи проблем с ключа/квотата.

### v1.20.0 — 2026-08-08 (по заявка на потребител — AI Агент Ростър, за да не се чака при всяка задача)
- 🗂️ **Нов модул `js/agent-roster.js` (AgentRoster)** — проблем, установен
  същия ден: при заявка към AI екипа (напр. "🤖 Питай AI екипа" в
  Системен тест) `callClaude`/`callGeminiWithFallback`/`callOpenRouter`
  тръгваха от ЦЕЛИЯ суров списък модели на всеки provider (при OpenRouter
  — потенциално десетки безплатни модели) и пробваха един по един при
  грешка — на практика дълго чакане, докато не се удари работещ модел.
  Решение: отделен, компактен "ростър" — временен файл в `localStorage`
  (`cdb_agent_roster_v1`), който се строи МАКСИМУМ веднъж на 24ч чрез
  реална евтина проверка ("hi" prompt) на до 8 модела на всеки provider
  с ключ (подредени по историческа надеждност — виж `AICallLog.
  sortByReliability`). Пази се само списъкът модели, които РЕАЛНО
  отговориха успешно.
- 🚀 **`callClaude`/`callGeminiWithFallback`/`callOpenRouter` вече ползват
  ростъра като ПЪРВИ избор** (providers/claude.js, providers/gemini.js,
  providers/openrouter.js) — малкия, вече проверен списък, вместо целия
  суров списък при всяка задача. Пълният списък остава резерва накрая,
  само ако всичко от ростъра гръмне (нищо не се чупи, ако ростърът
  липсва/е празен — старото поведение си работи като fallback).
- ⚡ **Незабавно премахване при квота/невъзстановима грешка** — ако модел
  удари квота (429/529 при Claude, изчерпана дневна квота при Gemini,
  429/503 при OpenRouter) или изчезне (404 — Google понякога
  преименува/маха модели), маха се от днешния ростър ВЕДНАГА (`AgentRoster.
  removeModel()`), не чака следващото 24ч опресняване — следващата задача
  същия ден автоматично го прескача, без нов мрежов опит.
- 🔒 **Задължителен екран при влизане** — нов overlay `#rosterGateOverlay`
  в `index.html`: ако вече има зададен поне 1 AI ключ И ростърът
  липсва/е по-стар от 24ч, dashboard-ът е блокиран зад екран "🤖 Обнови
  AI агентите" с бутон, докато проверката не приключи. Появява се при
  зареждане, и след отключване на Auth Gate / Vault-а (местата, където
  API ключовете стават достъпни) — виж `AgentRoster.maybeShowGate()`,
  извикан от `app.js` (DOMContentLoaded, `Settings.vaultUnlock()`) и
  `js/auth-gate.js` (`unlock()`, `bioUnlock()`).
- ⚙️ **Нов панел в Настройки → API Ключове** — "🗂️ AI Агент Ростър
  (работещи модели днес)": показва текущия списък по provider + кога е
  обновен, с бутон "🔄 Обнови сега" за ръчна проверка по избор (не само
  задължителната при влизане). `sw.js` обновен (offline shell v21, добавен
  `js/agent-roster.js` към кеширания списък).

### v1.17.0 — 2026-08-08 (по заявка на потребител — анти-дублиране на AI предложения)
- 🔍 **Live Feature Inventory** — `SystemTest.scanFeatureInventory()`
  (`js/system-test.js`). Проблем, установен същия ден: списъкът със
  "съществуващи функции", подаван на "🤖 Питай AI екипа" (и на всеки
  външен AI консултант), беше ръчно поддържан текст, който изоставаше
  зад реалните карти в интерфейса — доведе до предложения за вече
  изградени неща (напр. Vault). Решение: вместо ръчен текст, функцията
  сканира РЕАЛНИЯ DOM в момента на извикване (всяка nav група + всяко
  card заглавие във всеки view) и генерира точния списък на живо — не
  може да изостане, защото се чете директно от заредения интерфейс.
  `askAgentPanelForIdeas()` вече ползва това вместо стария твърдо
  кодиран масив.
- 🔍 **Нова карта "Точен списък от функции"** в Системен тест — бутон,
  който показва (и позволява копиране на) същия списък, който се
  подава на AI екипа. Полезно и извън таблото: копирай го и го дай на
  всеки друг AI консултант (напр. нов разговор с Claude), когато искаш
  външни предложения, за да не предлага дублиращо се. `sw.js` обновен
  (offline shell v18).

### v1.16.0 — 2026-08-08 (по заявка на потребител — 4 нови идеи от AI консултант)
- 🎬 **Short-Form "Viral Scripting" Engine** — Стъпка 3, нова карта "15 ·
  Кратки видео сценарии (TikTok/Reels/Shorts)"
  (`Step3.generateShortFormScripts()`). AI генерира 3 РАЗЛИЧНИ 15-30 сек
  промо сценария (POV / behind-the-scenes / чист visual hook) — визуалния
  hook на ВИДЕОТО, не текста на самата песен. Всеки включва какво се
  случва в първите 2 секунди, 3-4 визуални "beats", готов caption и
  хаштагове с бутони за копиране. Ползва emotional контекста от Viral Lab
  доклада, ако вече има такъв.
- 💰 **Revenue & Stream Projection Simulator** — нова карта в Niche
  Toolkit (`NicheToolkit.Revenue`, `js/niche-toolkit.js`). Изцяло
  клиентска аритметика (без AI/API извиквания — не пести квота) с
  прозрачни, публично известни ориентировъчни RPM диапазони за Spotify/
  YouTube/TikTok, дава груб месечен приходен диапазон (консервативно —
  оптимистично). "🔄 Взимай от последния анализ" автоматично попълва
  YouTube views/Spotify стрийм оценка от последния "🎯 Анализирай
  нишата" резултат в същата сесия. Ясно маркирано като ориентировъчна
  оценка, не финансов съвет.
- 🗓️ **Dynamic Release Asset Roadmap** — нов раздел в sidebar-а "🗓️
  Release Roadmap" (`js/release-roadmap.js`, нов view). Динамичен
  чек-лист от 13 конкретни задачи (мастеринг → обложка → DistroKid →
  teaser-и → YouTube A/B → пускане → социални → Track Record),
  преизчислен спрямо въведената дата на пускане, с progress bar и
  чекбоксове, запазени локално по песен+дата. `sw.js` обновен (offline
  shell v17).
- 🩺 **API Health & Connectivity Dashboard** — Настройки → API Ключове,
  нов блок с визуални чипове под "🧪 Тествай ключовете"
  (`Settings.renderKeyHealth()`). Категоризира суровия резултат от теста
  в ясна диагноза по provider (✅ Работи / ⚪ Няма ключ / 🔴 Невалиден
  ключ / 🔴 Забранен достъп или грешен scope / 🟡 Изчерпана квота-кредит
  / 🟡 Грешка от доставчика), вместо потребителят сам да чете суров HTTP
  статус — суровият текстов лог остава непроменен отдолу за пълни
  детайли.

### v1.15.0 — 2026-08-08 (по заявка на потребител)
- 📖 **Нова README секция "Изградени идеи от AI екипа"** — траен,
  четим от хора запис (git история) на всяка реално изградена идея, по
  ТОЧНОТО ѝ заглавие, успореден на автоматичния архив в таблото. Описан
  е и работният процес (предложение → изграждане → запис тук + маркиране
  в таблото) и защо и двете места са нужни (README е за хора, архивът в
  localStorage е това, което реално подава "вече готово" на AI екипа при
  всяко "Питай AI екипа", защото това е чисто браузърно приложение).
- ➕ **"Добави / маркирай идея ръчно"** — нова карта в
  **🗂️ Архив на идеи от AI екипа** (`js/system-test.js`:
  `SystemTest.addManualIdea()`). Позволява да впишеш заглавие (+ по
  избор описание) и веднага да го маркираш изградено — за идеи, дошли
  извън тази инсталация (друг разговор с Claude, или вече записани само
  в README) — без да чакаш идеята първо да е предложена от "🤖 Питай AI
  екипа" в самото табло. Ако вече има запис със същото заглавие, само
  го маркира изграден вместо да дублира (общ `_normTitle()` helper,
  споделен с дедупликацията в `_recordIdeas`).

### v1.14.0 — 2026-08-08 (по заявка на потребител)
- 🗂️ **"Архив на идеи от AI екипа" вече е отделен раздел в sidebar-а**
  (под "🧪 Системен тест", вместо карта в самия изглед на теста).
  Нов view `view-ai-ideas`, нов nav бутон, добавен и в
  `_checkCriticalDom` (Системен тест). Има и поле за търсене по
  заглавие (`#aiIdeaSearch`). Резултатът от "🤖 Питай AI екипа" в
  Системен тест вече линква директно към новия раздел, вместо "виж
  архива по-долу".
- 🏷️ **Всяка идея от AI екипа вече се записва ПООТДЕЛНО, със СВОЕ
  заглавие** (`js/system-test.js`, нов `SystemTest._splitIdeas()`) —
  преди целият отговор на един агент (по няколко идеи наведнъж) се
  пазеше като едно голямо "предложение" в архива. Сега промптът към
  AI екипа изрично изисква формат "N. **Заглавие** – описание" за
  всяка идея, парсърът ги разбива на отделни записи, и всяка се
  дедуплицира по (agent + заглавие) — не по целия текст, за да се
  разпознава една и съща идея дори леко преформулирана следващия път.
  Архивът вече показва заглавието като видим хедър на всяка карта.
  Списъкът "вече изградени" функции, който се подава обратно на AI
  екипа, вече също е по заглавие (+ кратко резюме), не орязан суров
  текст — по-чисто разпознаваем от модела. Стари записи от преди тази
  версия (без `title`) продължават да се показват коректно (fallback
  към първите думи от текста).
- 🔄 **"АI за генериране на съдържание" вече наистина взима предвид
  резултата от "🧪 Тествай ключовете", и включва и OpenRouter**
  (преди `callAI()` познаваше само Claude/Gemini — OpenRouter изобщо
  не участваше в генерирането на съдържание, само в "Питай AI екипа").
  Нов модул `AIProviderOrder` (`app.js`) — `Settings.testKeys()` вече
  пази реда, в който Claude/Gemini/OpenRouter РЕАЛНО отговориха при
  теста (успелите отпред, в тествания ред; провалените — накрая, само
  ако имат ключ). `callAI()` минава по този ред при ВСЯко извикване
  навсякъде в таблото (Стъпка 1-3, Niche Toolkit, Track Record, и
  т.н.) — ако текущият provider гръмне грешка, автоматично пада на
  следващия в реда, докато някой не отговори (или всички откажат).
  Настройки → Предпочитания → "AI за генериране на съдържание" вече
  има опция "🔄 Автоматично (по теста)" като нов default (вместо
  твърдо закачено "Claude"); ръчен избор на провайдър (вкл. вече и
  OpenRouter) просто го бута най-отпред в реда, останалите пак стоят
  като резерв. Текущият активен ред се вижда в Настройки → API
  Ключове → "Модел по подразбиране".

### v1.13.0 — 2026-08-08 (нова функция)
- 🗂️ **Архив на идеи от AI екипа** (по заявка на потребител — "искам
  да се записва някъде, за да мога по-късно да го изградя; и ако вече
  е изграден, АI екипът да не го предлага пак"). `js/system-test.js`:
  - Всяко РЕАЛНО предложение (не грешка) от "🤖 Питай AI екипа за нови
    функции" вече автоматично се записва трайно в localStorage
    (`cdb_ai_ideas_v1`, до 200 записа), дедуплицирано по (агент + точен
    текст) — не се трупа едно и също предложение при всяко повторно
    пускане без промяна.
  - Нова карта "🗂️ Архив на идеи от AI екипа" в изгледа "Системен
    тест" (`view-system-test`) — показва всички записани предложения с
    дата, кой AI агент ги е дал, и бутон "✅ Маркирай като изградено" /
    "🗑️" за изтриване.
  - Промптът към AI екипа вече включва секция "ФУНКЦИИ, КОИТО
    ПОТРЕБИТЕЛЯТ ВЕЧЕ Е ИЗГРАДИЛ" (само маркираните като изградени,
    орязани до ~240 символа всяко) — така екипът вижда какво вече
    съществува на сайта (статичния `featureInventory` + динамично
    изградените от архива) и какво реално липсва, вместо да предлага
    повторно нещо готово.
  `sw.js` кеш версия вдигната (v16).

### v1.12.2 — 2026-08-08 (bugfix)
- 🐛 **AI отговорите/грешките в "🤖 Питай AI екипа за нови функции" (и
  историята на тестовете) се вкарваха директно в `innerHTML` без
  escape.** `js/system-test.js`: ако AI отговор или сурово API
  съобщение за грешка съдържа `<`, `>` или `&` (напр. AI-то предложи
  `<audio>` таг, или proxy-то върне HTML error page), браузърът го
  тълкуваше като HTML вместо да го покаже като текст — картата се
  чупеше визуално/частично изчезваше. Добавен `SystemTest._esc()`
  helper и приложен към `a.text`/`a.error` (панела с идеи) и
  `r.name`/`r.detail` (резултатите от теста, и в двата view-а —
  текущ и история).

### v1.12.1 — 2026-08-08 (bugfix)
- 🐛 **Gemini "модел не съществува" (404) чупеше цялото извикване.**
  `js/providers/gemini.js`: `GEMINI_FALLBACK_MODELS` съдържаше вече
  оттеглен от Google модел (`gemini-2.5-flash-lite`) — премахнат.
  По-важно: `callGeminiWithFallback()` преди превключваше на следващия
  модел от списъка САМО при `429` (изчерпана квота) — вече го прави и
  при `404` (модел вече не съществува/преименуван), плюс изчиства
  кеширания списък с модели, за да не се опитва пак със същото име
  следващия път.
- 🐛 **OpenRouter извикванията гърмяха с `String contains non ISO-8859-1
  code point`.** `js/providers/openrouter.js`: хедърът `X-Title`
  съдържаше тире "—" (em dash), а браузърният `fetch()` изисква HTTP
  хедър стойностите да са ASCII/Latin-1 — сменено на обикновено "-".
- 🐛 **"Системен тест" можеше да увисне завинаги на "⏳ Стимулирам
  системата...".** `js/system-test.js`: `SystemTest.runAll()` нямаше
  top-level `try/catch` — при неочаквана грешка екранът никога не се
  обновяваше с резултат. Вече хваща грешката и показва ясно съобщение.
  Добавен е и `view-system-test` в списъка проверявани view контейнери
  (`_checkCriticalDom`) — преди беше пропуснат.
- ℹ️ Claude API грешка "credit balance too low" **не е бъг в кода** —
  изисква добавяне на кредит в Anthropic Console → Plans & Billing.
- Засегнати файлове: `js/providers/gemini.js`, `js/providers/openrouter.js`,
  `js/system-test.js`. `sw.js` кеш версия вдигната (v15), за да не остане
  стар кеширан код при потребители, посетили сайта преди фикса.

### v1.12.0 — 2026-08-08
- 📱 **Биометрично отключване (WebAuthn — пръстов отпечатък / Face ID)**
  (по заявка на потребител). `js/auth-gate.js`: нов `AUTH_GATE_BIO_KEY`
  + `AuthGate.bioRegister()/bioForget()/bioUnlock()/bioUnlockClick()` —
  ползва `navigator.credentials` (`PublicKeyCredential`, "platform
  authenticator") на самото устройство. Нов бутон "👆 Отключи с
  биометрия" на lock screen-а (`#authGateOverlay`), плюс "Регистрирай /
  Премахни биометрията от това устройство" в Настройки → "🔒 Достъп до
  dashboard-а" (виден само след като вече си минал през парола поне
  веднъж). **Честно за ограниченията** (документирано и в самия код и в
  "Известни ограничения" по-долу):
  - Регистрацията е **само за конкретния браузър/устройство** — не се
    пренася на друг телефон/лаптоп, нито между различни браузъри на
    едно и също устройство. Там винаги остава наличен потребител+парола.
  - Изисква HTTPS (или `localhost`) — WebAuthn не работи по `http://`.
  - Изключването на защитата (`AuthGate.disable()`) вече автоматично
    премахва и регистрираната биометрия на устройството (нямаше смисъл
    да остане "жива" без активна ключалка).
  `sw.js` кеш версия вдигната (v14).

### v1.11.1 — 2026-08-08
- 🔓 **Ресет на заключената Auth Gate ключалка от телефон, без DevTools**
  (по заявка на потребител — "Изчисти всички данни" трие прекалено много,
  DevTools конзола не е удобна за достигане на телефон). Добавен `?resetGate=1`
  URL параметър, обработен в inline `<head>` скрипта на `index.html`: трие
  **само** записа на ключалката (`cdb_auth_gate_hash_v1`), след явно
  потвърждение през `window.confirm()` — останалите данни (проекти, API
  ключове, история от тестове) не се пипат. Не е видим бутон в интерфейса
  (нарочно, виж по-долу) — работи само ако изрично напишеш параметъра сам
  в адресната лента, същия праг на "случайност" като DevTools варианта.
  `sw.js` кеш версия вдигната (v13), тъй като `index.html` е сред кешираните
  shell файлове.

### v1.11.0 — 2026-08-08
- 🔒 **Auth Gate вече иска Потребител + Парола, не само парола**
  (по заявка на потребител). `js/auth-gate.js`: hash-ът вече е върху
  `"потребител::парола"` заедно (PBKDF2, 150 000 итерации, същия принцип
  като преди), а не само върху паролата — грешно потребителско име дава
  същата обща грешка "❌ Грешен потребител или парола" (не разкрива дали
  само едното от двете е грешно). Потребителското име се пази в чист
  текст в localStorage (само етикет за показване в Настройки, не тайна —
  реалната защита е в hash-а). Lock screen-ът (`#authGateOverlay`) вече
  има две полета вместо едно. Настройки → "🔒 Достъп до dashboard-а" също
  обновени — формата за задаване и за изключване на защитата вече искат
  и двете полета. **Данните на съществуващи потребители с ключалка,
  зададена преди тази версия, НЕ се губят** — старият localStorage запис
  просто няма да съвпадне с новия формат при следващото отключване, така
  че трябва да занулиш ключалката веднъж през DevTools (виж инструкциите
  по-горе в самия `auth-gate.js` или в "Известни ограничения" по-долу) и
  да зададеш нов потребител+парола наново.

### v1.10.1 — 2026-08-08
- 🐛 **FIX: sidebar менюто беше напълно недостъпно на мобилен телефон**
  (потвърдено от потребител — не се виждаше нито в браузър, нито като
  инсталирано PWA). Причина: `@media (max-width:760px){.sidebar{display:none}}`
  скриваше цялата навигация (вкл. "🧪 Системен тест", "⚙️ Настройки" и
  т.н.), без никакъв заместващ бутон за отваряне — истински dead-end,
  не козметичен detail. Оправено с ☰ hamburger бутон в topbar (виден само
  под 760px) + `.sidebar` вече е `position:fixed` overlay с
  `transform:translateX` анимация вместо `display:none`, плюс тъмен
  backdrop зад него (клик отвън затваря менюто). `Nav.showView()` вече
  автоматично затваря overlay-я след избор на view, за да не остане
  отгоре на съдържанието. На десктоп поведението не се променя изобщо
  (media query-то важи само <=760px). Нов JS: `Nav.toggleMobileSidebar()`
  / `Nav.closeMobileSidebar()` в `app.js`.

### v1.10.0 — 2026-08-08
- 🔒 **Auth Gate — екран за поверителност пред целия dashboard** (по избор,
  изключен по подразбиране) — `js/auth-gate.js`. Парола (PBKDF2 hash,
  никога чист текст) пред целия интерфейс — виж Настройки → API Ключове →
  "🔒 Достъп до dashboard-а". Ранен inline script в `<head>` предотвратява
  "проблясване" на съдържанието преди проверката. **Честно казано: това е
  чисто клиентска проверка, не сървърна защита** — виж "Известни
  ограничения" по-долу за пълния честен разбор какво спира и какво не.
  Нарочно НЯМА "забравена парола" бутон в самия lock screen (би бил
  тривиален байпас за всеки друг) — вместо това документирани стъпки за
  ръчно нулиране през DevTools. `sw.js` обновен (offline shell v11).

### v1.19.0 — 2026-08-08
- 📋 **"📋 Копирай" бутон навсякъде, където AI екипът връща/пази идеи** —
  вместо ръчно маркиране на дълъг текст, за да го копираш:
  - Живия резултат от "🤖 Питай AI екипа за нови функции" (Системен тест) —
    отделен бутон за копиране до всеки agent отговор.
  - Историята на системните тестове (последните 10, разгъваеми) — същия
    бутон до всеки съхранен agent отговор в архивирания запис.
  - 🗂️ Архива на идеи ("АРХИВ ОТ ИДЕИ") — бутон за копиране на всяка
    отделна записана идея (заглавие + описание), до бутоните за "✅
    Маркирай като изградено"/"🗑️".
  Общ `SystemTest._copyText()` helper (clipboard API + toast потвърждение)
  зад трите — едно място за поддръжка вместо инлайн код на 3 места.
  `sw.js` обновен (offline shell v20).

### v1.18.0 — 2026-08-08
- 🩺 **"Проверка при зареждане" вече не хаби реална AI заявка при всяко
  отваряне на сайта** — `Settings.silentHealthCheck()` първо гледа
  `AICallLog` (реалната история от последна употреба, всеки provider): ако
  най-скорошният запис е успешен и е под 24ч стар, зелената точка светва
  веднага, без нова мрежова заявка. Жива проверка (само с 1 provider, не с
  всички) се прави единствено ако няма скорошна успешна следа — нов ключ,
  последният опит е гръмнал, или е минало над 24ч. С други думи: вече
  "проверените агенти" (тези, които реално са отговорили наскоро) се
  ползват директно, а нова проверка се прави само когато агентът реално не
  отговаря — не при всяко зареждане "за всеки случай".
- 🐛 **Оправен bug: OpenRouter връщаше отрязани, недовършени отговори**
  (напр. в "🤖 Питай AI екипа") — за разлика от Claude, `callOpenRouter()`
  никога не проверяваше `finish_reason` на отговора, само дали има
  съдържание изобщо. Безплатните ("`:free`") модели режат по средата на
  изречение много по-често, защото реалният им output бюджет често е
  по-малък от заявения `max_tokens`. Сега `_callOpenRouterSingle()`
  (огледало на Claude-овата логика) разпознава `finish_reason === "length"`
  и прави 1 повторен опит с двоен бюджет; ако пак реже — хвърля ясна грешка
  и `callOpenRouter()` пада на СЛЕДВАЩИЯ безплатен модел, вместо да върне
  недовършен текст като че ли е готов резултат.
- ⏱️ **По-кратко чакане при Gemini 429** — retry при изчерпана квота
  намален от 2 опита с растящо изчакване (2с, 4с) на 1 опит с фиксирани
  1.5с, преди да превключи на следващия модел. По-бързо усеща се като
  "превключва", не като "виси".
- ℹ️ Логиката за избор МЕЖДУ провайдъри (`callAI()`) си остава непроменена
  по същество — тя вече правилно предпочита последно потвърдения provider
  (`AIProviderOrder`, от последен реален тест/употреба) и пробва
  алтернативите само при РЕАЛЕН отказ на текущия, не превантивно. Основната
  "постоянна проверка" беше именно в `silentHealthCheck()` по-горе.
  `sw.js` обновен (offline shell v19).

### v1.9.2 — 2026-08-08
- 🔍 **По-добра диагностика при "Claude: нито един модел не отговори"** —
  тестът вече показва и тялото на ПЪРВАТА грешка (не само HTTP статус
  кода), за да се вижда реалната причина (напр. "invalid x-api-key",
  "credit balance too low" и т.н.), вместо гол списък от "❌ 400".

### v1.9.1 — 2026-08-07
- 🔧 Два пропуска от v1.9.0 (OpenRouter), намерени при самопроверка:
  - `AICallLog.render()` (суровият лог в Настройки) грешно надписваше
    OpenRouter записите като "Gemini" — твърдо кодиран ternary вместо
    generic mapping. Оправено.
  - `AICallLog.renderLeaderboard()` ("🏆 Класация по надеждност") изобщо
    не показваше OpenRouter, въпреки че записите вече се логват — цикълът
    беше твърдо `["claude","gemini"]`. Добавен `"openrouter"`.

### v1.9.0 — 2026-08-07
- 🤖 **OpenRouter — трети AI provider (реален безплатен tier)**
  (`js/providers/openrouter.js`) — динамичен списък от само 0-цена
  (":free") модели, fallback между тях при претоварване. Нов ключ в
  Настройки: OpenRouter API Key (безплатен, от openrouter.ai/keys). Не
  изисква Proxy URL (за разлика от Spotify) — OpenRouter е изрично
  проектиран за директни browser извиквания.
- 👥 **"Питай AI екипа" (System Test)** — старото "Питай Gemini" стана
  панел от НЯКОЛКО агента едновременно (Claude/Gemini/OpenRouter — всеки,
  за когото има зададен ключ), викани паралелно със същия prompt, всеки
  отговор в собствена карта. Историята на тестовете вече пази отговорите
  на целия екип, не само на един agent. `sw.js` обновен (offline shell v10).

### v1.8.1 — 2026-08-07
- 🕐 **История на системните тестове** — последните 10 пуснати теста се
  пазят в localStorage (`Storage`, ключ `cdb_system_test_log_v1`) с дата/час,
  брой ✅/🟡/❌, пълни детайли по всяка проверка, и — ако е питан — какво е
  отговорил Gemini за нови функции. Разгъваем списък под самия тест
  (запазва се и между презареждания, не само за текущата сесия).

### v1.8.0 — 2026-08-07
- 🧪 **Системен тест (нов раздел, "Диагностика")** — `js/system-test.js`.
  Прихваща JS грешки от цялата сесия (`window.onerror`/`unhandledrejection`,
  регистрирани максимално рано), проверява localStorage четене/писане и
  обем, цялост на `AppState`, Vault статус, Service Worker/offline,
  структурата на всички view контейнери, историческа AI надеждност
  (преизползва `AICallLog.getLeaderboard()`), и реални мрежови проверки на
  всички API ключове (преизползва `Settings.testKeys()`, не дублира
  логиката). В края — бутон "🤖 Питай Gemini за нови функции": компилира
  кратко описание на съществуващите функции + резултата от теста и вика
  Gemini (с Google Search grounding) за 3-5 конкретни предложения,
  приоритизирани по полезност. `sw.js` обновен (offline shell v8).

### v1.7.0 — 2026-08-07
- 🧭 **Навигационно преструктуриране** — sidebar-ът мина от 8 разпилени
  групи на ясен pipeline: Табло → Създаване на песен (1-2-3) → Алтернативен
  път (Бърз ъплоуд) → Инструменти (Niche Toolkit + Gemini Validator) →
  Настройки/Статистика/Инфраструктура.
- 🔢 **Номерирани стъпки в Стъпка 1** — картите вътре вече показват ясно кое
  е задължително (①②③ баджове) и кое е по избор (Album Sprint, Hook Arena,
  Viral Lab, Ghost Audience, Niche Toolkit — с "по избор" таг), с разделители
  между групите вместо гола купчина еднакви карти.
- ➡️ **"Следваща стъпка" бутони** — в края на Стъпка 1/2/3, за да не се
  налага връщане в sidebar-а всеки път.
- 🔗 **Комбиниран поглед: Стъпка 1 ↔ Niche Toolkit** — когато и двата score-а
  съществуват за същата/подобна ниша, се показват един до друг с кратък
  извод дали двата сигнала (YouTube+AI срещу Spotify+YouTube) се съгласуват.
  Работи в двете посоки — Niche Toolkit го показва веднага, а Стъпка 1 го
  показва инлайн до съответната ниша, ако вече е пускан анализ за нея.
  `sw.js` обновен (offline shell v7).

### v1.6.0 — 2026-08-06
- 🎯 **Niche Toolkit (нов раздел)** — портнат от отделен Node/Express
  "music-niche-toolkit" проект в чист браузърен JS (`js/niche-toolkit.js`),
  за да пасне на статичната архитектура на сайта (без сървър). Съдържа:
  - **Niche & Signal анализ** — Spotify популярност + YouTube трафик +
    груб конкурентен сигнал → "Profit Niche Score" (0-100), допълнителен
    сигнал спрямо съществуващия YouTube+AI niche score от Стъпка 1
    (с връзка натам).
  - **AI Промпт за Suno/Udio** и **AI Структура на текст** — през
    съществуващия Claude/Gemini pipeline на сайта (не отделен OpenAI
    wrapper, за консистентност).
  - **Release Playbook + CSV export** — изцяло клиентски (Blob download),
    без нужда от сървър.
  - Нови ключове в Настройки: Spotify Client ID/Secret (Client Credentials
    flow — изисква и Proxy URL, Spotify token endpoint-ът няма CORS за
    браузър заявки; същия модел на доверие като останалите ключове —
    личен инстанс, само в localStorage на твоя браузър). Добавен тест в
    "🧪 Тествай ключовете".
  - `sw.js` обновен (offline shell v6).

### v1.5.0 — 2026-08-06
- 🧩 **Архитектура (стъпка 5/6): `ui/`** — `toast()` → `js/ui/toast.js`,
  `guardClick()` → `js/ui/guard-click.js`. И двата са чист DOM, без
  зависимости — заредени най-рано в `index.html` (преди `network.js`).
  `sw.js` обновен (offline shell v5). Следва последната, най-рискова
  стъпка: централизиран `State` (`ui`/`settings`/`currentProject`/...
  вместо плосък `AppState.data.project`).

### v1.4.0 — 2026-08-06
- 🧩 **Архитектура (стъпка 4/6): `youtube/`** — `fetchRecentTrendingVideos()`,
  `youtubeTopTitles()`, `youtubeOutlierScan()` и `keywordSuggest()` са
  извадени от `app.js` в `js/youtube.js`. `app.js` олекна до ~3150 реда
  (от първоначалните ~3600). `sw.js` обновен (offline shell v4).
  Следва: `ui/` (toast и бъдещи modal/loader), после централизиран `State`.

### v1.3.0 — 2026-08-06
- 🧩 **Архитектура (стъпка 3/6): `providers/`** — целият Claude-специфичен
  код (`js/providers/claude.js`: динамичен списък модели, единично
  извикване, fallback между модели) и Gemini-специфичен код
  (`js/providers/gemini.js`: списък модели, fallback+retry/backoff, текст
  и multimodal) са извадени от `app.js` в собствени файлове. `app.js`
  вече пази само `callAI()` — оркестрацията, която избира между двата
  провайдъра. `app.js` олекна от ~3600 на ~3280 реда. `sw.js` обновен да
  кешира и новите файлове (offline shell v3). Следва: `youtube/`, `ui/`,
  централизиран `State`.

### v1.2.0 — 2026-08-06
- 🧩 **Архитектура (стъпка 2/6 от модулното разделяне): `network/` слой** —
  `fetchTimeout` и `proxied` са извадени от `app.js` в отделен файл
  `js/network.js` (обикновен classic `<script>`, зареден преди `app.js` —
  без `import`/`export`, за да не се чупят стотиците inline `onclick=""`
  из `index.html`). `sw.js` обновен да кешира и новия файл (offline shell).
  Следва: `providers/` (Claude/Gemini), `youtube/`, `ui/`, централизиран `State`.

### v1.1.0 — 2026-08-06
- 🎯 **Model Pref** — тестът на ключовете вече пробва всички модели наред
  (не само първия) и хваща първия успешен като модел по подразбиране;
  добавен и ръчен избор от падащо меню в Настройки.
- 🏆 **AI Call Log → Leaderboard по надеждност** — тестът пробва моделите по
  историческа успеваемост на устройството, не само по статичен fallback ред.
- 🔁 **Track Record → калибрация на Viral Lab** — последните известни реални
  резултати влизат в промпта, за да се самокоригира прогнозата във времето.
- 📊 **Quota Tracker** — визуален bar chart вместо суров текст.
- 📴 **PWA offline** — нов `sw.js` (кешира само черупката; AI/GitHub/YouTube
  заявките винаги минават през мрежата).
- 🔐 **Vault** — опционално AES-GCM криптиране на API ключовете в
  localStorage с парола (Web Crypto), с глобален индикатор при заключен
  трезор.
- 🧬 **Hook Evolution Arena** — нов бутон "Сравни с реални hits", тества
  победителя срещу реални набиращи инерция заглавия от нишата.
- 🔧 Оправен bug: GitHub Personal Access Token полето не се пазеше/зареждаше;
  вече се пази и тества (`GET /user`).
- 🧹 Нов `Storage` wrapper (`Storage.get/set/remove/has`) — премахнати всички
  35 разпръснати директни `localStorage.*` извиквания в полза на едно място.
