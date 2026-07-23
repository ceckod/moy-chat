# AI Music Suite — CD-B Records Dashboard

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
- **🔍 Предложение за песен** — остави полето празно и Gemini (с Google Search
  grounding — реален достъп до търсачката, не само памет на модела) сканира
  какви жанрове набират инерция в момента и връща топ 5 с 🟢/🟡/⚪ индикатор.
  Ако въведеш свои жанрове в полето, сравнява точно тях вместо авто-скан.
- **📊 YouTube Outlier анализ** — автоматично след избора на ниша: намира
  малки канали с непропорционално много гледания (VidIQ-стил сигнал за
  търсене без силна конкуренция). Изисква YouTube Data API Key.
- **🔎 Свързани търсения** — реални autocomplete предложения (какво реално
  търси аудиторията). Изисква Proxy URL (виж по-долу).
- **✨ Концепция** — заглавие, Style Prompt (за Suno AI) и 3 хаштага.
- **📀 Album Sprint** — 10-30 различни заглавия+hook+mood наведнъж.
- **✍️ Текст на песента** — с Chorus най-отпред, мета-тагове за Suno.

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
- `visualizer.html` — самостоятелен визуализатор, вграден през `<iframe>`.
- `scripts/track_stats.py` — самостоятелен tracker (само YouTube засега;
  utre добавяш Spotify → нов файл `scripts/track_spotify.py`, без да пипаш
  този).
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

- Многопроектна история (списък с предишни песни).
- Offline кеширане (service worker).
- Директна YouTube `search.list` заявка за по-твърди SEO числа, комбинирана
  с Gemini оценката.
- Проверка на свободен домейн за бранд името на изпълнителя.
- Voice prompting през вградения браузърен Web Speech API.
