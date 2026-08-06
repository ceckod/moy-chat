# AI Music Suite — CD-B Records Dashboard

**Версия:** 1.6.0
**Последна промяна:** 2026-08-06, 23:22 (Europe/Sofia)

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
- Директно качване в YouTube (unlisted) през Google OAuth.

### Gemini Validator
Автоматичен кратък анализ ("втори поглед") след всяка стъпка (trend scan,
концепция, текст, FX, обложка, album sprint, A/B заглавия). Логът се трупа
и е видим в "Втори поглед (Лог)" в sidebar-а.

---

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
- `js/providers/claude.js`, `js/providers/gemini.js` — целият AI provider код.
- `js/youtube.js` — YouTube Data API + autocomplete suggest.
- `js/niche-toolkit.js` — Spotify-базиран niche score, AI промптове за
  Suno/Udio, Release Playbook — самостоятелен раздел, не пипа останалото.
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

- **Стъпка 3 (DistroKid):** auto-fill асистент, не автоматизира самия
  DistroKid сайт (browser security).
- **musicalSEO-подобни данни:** ползваме Google/YouTube autocomplete
  (неофициален endpoint) вместо платен инструмент — изисква Proxy URL.
- **GitHub Actions cron:** не е прецизен до минута (може да закъснее до
  ~30 мин) — без значение за дневна статистика.
- **Spotify/Apple Music реални стриймове:** все още не се следят
  автоматично (изисква отделен developer акаунт) — текстовете за профилите
  им се генерират, но не и live статистика оттам.

## Идеи за следващо

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
