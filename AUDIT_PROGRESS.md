# CD-B Dashboard — Проследяване на постепенните подобрения

Този файл се актуализира при всяка стъпка. Качи го обратно заедно с проекта
следващия път, за да знаем веднага какво е свършено и какво остава.

Пълният първоначален одит е в `Технически-одит-CDB-Dashboard.md` (от чата,
не е част от repo-то) — тук се проследява само изпълнението на плана.

**Правило през целия процес:** една стъпка → анализ на зависимости → минимална
промяна → проверка → следваща стъпка. Нищо не се прескача.

---

## Легенда
- ✅ Направено
- 🔵 В процес / частично
- ⏳ Чака твое решение/вход
- ⬜ Все още не е започнато

---

## Стъпки от плана

| # | Стъпка | Статус | Бележки |
|---|---|---|---|
| 1 | Изясняване статус на `ai.html`/`aichat.html` и `site-ai.html`/`site-ai-agent.html` | ⏳ | **Решено (2026-08-08): отложено съзнателно.** Не се пипат засега, чакаме твое решение по-късно. |
| 2 | Проверка на `ai-model-finder/keys.json` | ✅ | Файлът е безопасен (празен шаблон), но открихме свързан проблем (липсващ `.gitignore`) |
| 2.1 (ново, открито) | Добавяне на `.gitignore` за `keys.json` | ✅ | **Направено** — виж запис по-долу |
| 3 | Baseline за `visualizer.html` преди промени | ⏳ | **Решено (2026-08-08): отложено съзнателно.** Ще се върнем по-късно. |
| 4 | Извеждане на статичните asset-и от `visualizer.html` (18MB → отделни файлове) | ⬜ | На пауза — зависи от т.3, отложена по твое желание |
| 5 | Извеждане на чистите helper функции от `visualizer.html` | ⬜ | Зависи от т.4 |
| 6 | Unit тестове върху вече изолирани чисти функции | ✅ | `js/network.js` (8 теста) + `Storage`/`Keys`/`Vault` от `app.js` (17 теста) — общо 25/25 минали |
| 6.1 (ново, открито) | Поправка на счупени пътища в тестовата инфраструктура | ✅ | При качването на 2026-08-08 файловата структура на `test/`/`helpers/` не съвпадаше с вътрешните пътища в кода — виж запис по-долу |
| 6.2 (ново) | GitHub Actions workflow за автоматично пускане на тестовете | ✅ | `run-tests.yml` — пуска `npm test` при всеки push/PR, по модела на `daily-stats.yml` |
| 7 | Общ retry/fallback helper за providers | ✅ | Нов `js/providers/fallback-loop.js` — виж запис по-долу |
| 8 | По-нататъшно разбиване на `app.js` (по namespace обект, едно на итерация) | ✅ | **Завършена (10/10 итерации).** `SystemLog`, `AICache`, `QuotaTracker`, `AppState`, `Prefs`, `ModelPref`, `AIProviderOrder`, `AICallLog`, `Nav`, `Settings` — всички извадени. `app.js`: 3480 → 2374 реда (~31.8%). Виж записи по-долу. |

---

## [2026-08-10] AI Model Finder — bugfix (отделна задача, извън оригиналния одитен план по-долу)

**Контекст:** потребителят докладва, че панелът "🧠 AI Model Finder" в
основното табло вечно показва `HTTP 404` и не изчезва каквото и да
пробва, и че списъкът с модели показва предимно такива "за сваляне"
вместо реално онлайн/извикваеми.

**Открита първопричина:**
- `.github/workflows/scrape-ai-models.yml` — referenциран от README/UI
  текста ("пусни GitHub Action-а...") — **не съществуваше в repo-то**.
  Стар changelog запис (`README.md` v1.22.0) твърдеше, че вече е
  "върнат", но реално не беше. Резултат: `ai-model-finder/ai-models.json`
  никога не се генерираше в repo-то, затова панелът гърмеше 404 без
  значение какво прави потребителят в самия инструмент.
- Браузърният "Намери ми AI модели" бутон само сваля JSON локално на
  устройството на потребителя — никога не стига обратно в repo-то,
  затова дори ръчно пускане не оправяше 404-ката трайно.
- HuggingFace резултатите се сортираха по `downloads` (сваляния за
  локална инсталация), не по онлайн активност — визуално четеше се
  като "инструмент за сваляне".

**Действия (потвърдени от потребителя преди изпълнение):**
1. Нов файл `.github/workflows/scrape-ai-models.yml` — по модел на
   `daily-trends.yml`, работи с нула ключове, комитва
   `ai-model-finder/ai-models.json` обратно в repo-то.
2. `ai-model-finder/scraper.mjs` + `ai-model-finder/app.js` — ново поле
   `verified` на всеки модел (true само за потвърдено универсални
   работещи endpoints); сортиране сменено `downloads` → `trending`;
   verified резултати винаги първи.
3. `ai-model-finder/index.html` — нов чекбокс "Само проверени" (вкл. по
   подразбиране) + ✅/⚠️ badge вместо стария подвеждащ текст "— N
   сваляния".
4. `js/providers/model-finder.js` — информационният панел в основното
   табло показва същия ✅/⚠️ badge.
5. `README.md` — нов changelog запис v1.23.0 + вдигната версия горе.
6. `ARCHITECTURE.md` — коригиран остарял ред за `js/providers/
   model-finder.js` (вече не е "само списък") + добавена нова таблица
   "GitHub Actions workflows" (липсваше изцяло като секция).

**Проверка:** `node --check` чисто на всички пипнати JS файлове;
`npm test` → **46/46** преди и след. Реалните мрежови извиквания
(HuggingFace/OpenRouter API) не бяха тествани в средата, в която е
направена промяната (домейните са извън разрешения списък там) —
изисква потвърждение от потребителя след първото реално пускане на
`scrape-ai-models.yml` в GitHub Actions.

**Останало отворено:** потребителят спомена желание за "паралелно"
(не само последователно fallback) извикване на няколко AI provider-а
едновременно през `callAI()` — съзнателно отложено, все още не е
решено дали да е race (първи успешен печели) или нещо друго. Не е
пипано в тази сесия.

**Follow-up (същия ден):** при първото реално пускане на
`scrape-ai-models.yml` GitHub предупреди за "Node.js 20 is deprecated".
Проверих и `run-tests.yml` имаше същия хардкоднат `node-version: "20"`.
Сменени и двата на `node-version: "lts/*"`, за да не се налага пак
ръчна поправка при следващото deprecation.

---

## [2026-08-10, по-късно] Niche & Signal / Profit Niche Score — Spotify вече е опционален

**Контекст:** потребителят цъкна "🎯 Анализирай нишата" (Niche Toolkit,
Spotify+YouTube сигнал) и получи твърд crash: `❌ Липсват Spotify Client
ID / Client Secret`. Това е СЪЩАТА функционалност, за която направих
пълен анализ по-рано в деня (виж по-долу "Оригинален одитен план" за
контекста на Niche & Signal дискусията) — но самата имплементация
(`js/niche-scoring.js`) така и не беше писана, спряхме на дизайн ниво.
Вместо това потребителят поиска директно "искам да работи" върху
съществуващия `niche-toolkit.js`, а не изчакване на пълния redesign.

**Промени в `js/niche-toolkit.js`:**
1. `_getSpotifyToken()` — ако няма Client ID/Secret, пробва анонимен
   `open.spotify.com/get_access_token` (без регистрация) вместо да
   хвърля грешка веднага. И двата пътя минават през `proxied()`.
2. `_searchSpotifyTracksByGenre()` — грешка тук вече се хваща вътрешно
   (`console.warn` + връща `{tracks:[], error}`), не пропада нагоре и
   не спира `Promise.all` с YouTube частта.
3. `_computeNicheScore()` — нов параметър `spotifyAvailable`; ако е
   `false`, тежестта на Spotify (0.35) се преразпределя пропорционално
   към views (0.4→~0.62) и competition (0.25→~0.38), вместо
   `avgPopularity=0` тихо да влиза в сметката. Добавен `confidence`
   (HIGH/MEDIUM/LOW).
4. `analyzeNiche()` — UI вече показва честна бележка "⚠️ Spotify:
   insufficient data (причина)" + Confidence badge, вместо мълчаливо
   различен резултат без обяснение.
5. `index.html` (ред ~866) — описанието на панела вече казва "Spotify е
   опционален", не "Изисква Spotify + YouTube ключове".

**Проверка:** `node --check js/niche-toolkit.js` чисто; `npm test` →
46/46. Реалният анонимен Spotify token endpoint **не е тестван на живо**
(извън обхвата на средата, в която е направена промяната) — известен
риск: неофициален, reverse-engineered endpoint, Spotify може да го
промени без предупреждение. Ако спре да работи, анализът пак ще
продължи (YouTube-only fallback вече е на място), само Spotify частта
ще липсва с ясно обяснение защо.

**Останало отворено (непроменено):** пълният `js/niche-scoring.js`
redesign (5 под-индекса, HHI Opportunity, trend momentum, Deezer/iTunes
допълнителни сигнали) — все още само дизайн на хартия, не е писан. Тази
сесия само е поправила бъга "не работи изобщо" в съществуващия
`niche-toolkit.js`, не е заменила логиката му.

---

## [2026-08-10, вечер] Niche & Signal — пълният 5-под-индекс redesign, реализиран

**Контекст:** потребителят каза "давай 1 и 2" в отговор на списък
"какво остава" — т.е. (1) пълния `js/niche-scoring.js` redesign,
дизайнът за който беше договорен в самото начало на деня (виж горе), и
(2) допълнителните безключови сигнали (Deezer/iTunes/MusicBrainz/
YouTube RSS), обсъдени по-рано. За разлика от по-ранния фикс (просто
да работи), тук реално е написан пълният модел.

**Нови файлове:**
1. `js/niche-scoring.js` — чист scoring модул, БЕЗ fetch/DOM (виж
   header коментара в самия файл за пълния дизайн). Ключови функции:
   `computeHHI`/`computeOpportunity` (Herfindahl концентрация вместо
   линейно "100-конкуренция" — точно изискването от началото на деня:
   "много търсене + много конкуренция не бива автоматично да бие
   умерено търсене + ниска конкуренция + растеж"), `classifyMomentum`
   (rising/accelerating/stable/declining/collapsing от multi-snapshot
   история, не 1 число), `computeDemand`/`computeMonetization`/
   `computeFeasibility`, `computePNS` (обединява 5-те под-индекса,
   централни тегла `DEFAULT_WEIGHTS`, insufficient-data →
   пропорционално преразпределение, никога измислена стойност),
   `compareNiches` ("защо A > B" по най-голямата разлика в под-индекс).
2. `js/niche-data-sources.js` — Deezer/iTunes/MusicBrainz/YouTube RSS,
   всяка функция non-throwing (`{available:false,error}` при провал).
3. `test/load-niche-scoring.mjs` + `test/niche-scoring.test.mjs` — 27
   детерминистични теста, точно сценариите от оригиналното задание
   (high demand+low/high competition, ключовият "малка бързорастяща
   бие голяма пренаситена" сценарий, low demand+high growth,
   declining, missing/incomplete data, преразпределение на тежести,
   екстремни стойности, детерминизъм, сравнение на ниши).

**Промени в съществуващи файлове:**
- `js/niche-toolkit.js` — нов метод `analyzeNicheExtended()`,
  ДОПЪЛНИТЕЛЕН към стария `analyzeNiche()` (не го заменя — и двата
  остават достъпни в UI, изрично решение да не се чупи съществуваща
  логика). `_lastAnalysis` разширен да пази суровите `tracks`/`videos`
  резултати (нужни за HHI/diversity изчисленията). YouTube video
  mapping вече включва `channelId` (нужен за YouTube RSS lookup).
- `index.html` — нов card "📊 Разширени сигнали" с Feasibility
  слайдър (1-5) + бутон, зареждане на новите 2 скрипта преди
  `niche-toolkit.js`.
- `ARCHITECTURE.md` — нови редове за двата модула в картата на проекта.

**Дизайн решения, взети по време на имплементацията (не бяха explicit
уточнени по-рано):**
- Momentum чете `data/trends-history.json` (последните до 8 snapshot-а)
  САМО ако въведената ниша съвпада (грубо, по подниз) с някоя от 15-те
  проследявани в `config.json` — иначе `UNKNOWN`, честно, не гадаем.
- YouTube RSS активност е показана като информативна (freshness на топ
  канала), НЕ участва в Momentum сметката директно — RSS дава само
  последните ~15 видеа на 1 канал, недостатъчно представително за
  цялостен пазарен momentum сигнал.
- Deezer fan counts се ползват като `topShares` за HHI, ако Deezer
  върне ≥2 изпълнителя; иначе fallback към YouTube channel diversity
  (уникални канали / общ брой резултати от последния анализ).

**Проверка:** `node --check` чисто на трите пипнати/нови JS файла;
`npm test` → **73/73** (46 стари + 27 нови). Изрично тествах и че
`const`-декларираните модули работят правилно между отделни `<script>`
тагове в общ realm (не само като `window.X` property) — потвърдено с
двойно `vm.runInContext` извикване в общ sandbox, симулиращо реалното
зареждане в `index.html`.

**НЕ е тествано на живо:** реалните мрежови извиквания към Deezer/
iTunes/MusicBrainz/YouTube RSS (същото ограничение като преди — тези
домейни са извън разрешения списък в средата, в която е направена
промяната). Очаква се първо реално пускане от потребителя за
потвърждение, особено CORS предположенията (iTunes/MusicBrainz —
директен fetch без proxy; Deezer/YouTube RSS — през `proxied()`).

---

---

## [2026-08-11] Profit Niche Scanner — автоматичен седмичен скенер (нов, отделен от analyzeNiche()/analyzeNicheExtended())

**Контекст:** потребителят иска "ежедневен ъпдейт с нови функции без да
чупи старите" + отделно: инструмент, който сам анализира ВСИЧКИ ниши
наведнъж по график, вместо ръчен клик за 1 ниша (`analyzeNiche()`/
`analyzeNicheExtended()`, и двата остават непипнати, паралелна логика).

**Ключово, повтарящо се решение по време на дизайна:** потребителят
изрично отхвърли Spotify (дори embed/anonymous вариант без ключ — вече
знаем от по-рано същия ден, че анонимният `open.spotify.com` token
endpoint връща 403, официално затегнат от Spotify от май 2025 —
малките/лични приложения вече не са в обхвата на разширения достъп).
Затова: **PNS Scanner-ът е 100% без Spotify.**

**Нови файлове:**
1. `scripts/track_niche_scores.py` — БЕЗ външни pip зависимости (само
   `urllib`/`json`/stdlib, като `track_trends.py`). Demand = медиана от
   Deezer + iTunes Search API + MusicBrainz (3 независими източника,
   за да не разчитаме на 1; kworb.net само като последна резерва, ако
   и трите паднат). Momentum = Wikipedia Pageviews (търси статията за
   нишата, ръст последни 30 срещу предходни 30 дни). Community = Reddit
   `/r/{ниша}/about.json` subscribers. Opportunity = HHI от Demand
   дела. Monetization/Feasibility = ръчни placeholder-и от config (или
   неутрални, ако липсват). Всяка `fetch_*` функция non-throwing.
   `_deep_find()` — търсене на ключ на произволна дълбочина в JSON,
   устойчиво на бъдещи промени в структурата на отговорите. Архивен
   fallback: ако всички live източници паднат за дадена ниша, взима
   последната позната стойност от `data/niche-scores-history.json`
   (никога празен резултат).
2. `.github/workflows/niche-scores.yml` — `cron: 0 8 * * 1` (понеделник
   08:00 UTC) + `workflow_dispatch`, commit обратно в repo-то, по
   същия модел като `daily-trends.yml`.

**Промени в съществуващи файлове:**
- `index.html` — нова карта "🏆 Автоматична седмична класация на ниши"
  в Niche Toolkit view, под "📊 Разширени сигнали". View/nav броят
  непроменен (19/24), проверено.
- `js/niche-toolkit.js` — нов метод `loadAutoNicheRanking()`, чете
  `data/niche-scores-history.json` (последния snapshot), рендира
  таблица сортирана по PNS. Честно съобщение, ако файлът още не
  съществува (преди първо пускане на workflow-а), не грешка.

**Списъкът с ниши идва от `config.json` → `trend_niches`** (вече
съществуващо поле, фиксиран статичен списък от 15, по-ранна сесия) —
скриптът пада обратно към него, ако новото поле `niche_scan_niches`
липсва (то самото също още НЕ е добавено).

**Проверка:** `python3 -m py_compile` чисто, `node --check` чисто на
`niche-toolkit.js`, `npm test` → 73/73 непроменено. Мрежата е
изключена в средата, в която е писан кода — реалните заявки към
Deezer/iTunes/MusicBrainz/Wikipedia/Reddit НЕ са тествани на живо,
очаква се първо пускане на workflow-а от потребителя за потвърждение.

**Известен проблем, идентифициран веднага след доставката (все още
НЕ е разрешен):** `trend_niches` е статичен, ръчно въведен списък —
не се обновява сам и не отразява какво е актуално точно сега.
Потребителят изрично отказа дори "семенна" начална база от термини,
въведена от него — иска системата сама да намери отправната точка.

**Договорен discovery слой — 4 независими източника, ПОСТРОЕН СЕГА (2026-08-11, продължение същия ден):**

1. `scripts/discover_niches.py` — **Фаза 1 (bootstrap, нула seed):**
   YouTube Trending Chart (`chart=mostPopular&videoCategoryId=10`) за
   3 региона (US/GB/DE), n-gram (2-3 думи) честотен анализ на
   заглавия+тагове на топ видеата → кандидат-термини, засечени ≥2 пъти.
   Ползва съществуващия `YOUTUBE_API_KEY` GitHub Secret (не нов ключ).
   **Фаза 2 (кръстосана проверка, независима за всеки кандидат):**
   Wikipedia (статия + >15% ръст в прегледите последните 30 дни),
   MusicBrainz (тагът се среща ли изобщо), Reddit (subreddit с >100
   абонати). ≥1 потвърждение → LOW confidence, ≥2 → HIGH. Резултат:
   `data/discovered-niches.json` (презаписва се всяка седмица,
   "текущи кандидати", не история).
2. `scripts/track_niche_scores.py` → `load_config()` вече чете
   `discovered-niches.json` и добавя потвърдените кандидати ВЪРХУ
   `trend_niches` (не ги заменя) — нула ръчно одобрение, директно в
   скена, точно както поиска потребителят.
3. `js/niche-toolkit.js` → таблицата в `loadAutoNicheRanking()` показва
   бадж "🔍 нова" за автоматично откритите ниши (title-атрибут с
   confidence нивото).
4. `.github/workflows/niche-scores.yml` → нова стъпка "Discover new/
   trending niches" ПРЕДИ скенирането, `git add` разширен с
   `data/discovered-niches.json`.

**Честно ограничение (документирано и в самия скрипт):** само YouTube
Trending фазата е истински "нула seed" bootstrap — тя генерира
кандидатите от нулата. Wikipedia/MusicBrainz/Reddit в текущата версия
ПОТВЪРЖДАВАТ кандидати от YouTube, не генерират собствени независимо.
Пълна 4-посочна независима генерация (напр. MusicBrainz "скорошно
тагвани жанрове" ендпойнт, Wikipedia "най-растящи статии в категория
Music genres") е по-сложна задача, оставена за бъдещо подобрение.

**Проверка:** `py_compile` чисто и на двата Python файла, `node --check`
чисто, `npm test` → 73/73 непроменено. Живите заявки (YouTube Trending +
трите confirm_* функции) НЕ са тествани на живо — мрежата е изключена в
средата за писане на кода.

---



## Дневник на изпълнените действия

### [Стъпка 2] Проверка на `ai-model-finder/keys.json`
- **Действие:** прочетен е файлът, без промяна.
- **Резултат:** съдържа само празен шаблон (`HF_API_KEY: ""`, `OPENROUTER_API_KEY: ""` и т.н.) — **безопасен е**, няма реални ключове в него в тази качена версия на проекта.
- **Открит съпътстващ проблем:** `ai-model-finder/README.md` изрично казва "`keys.json` никога не се качва в git" и очаква той да е в `.gitignore` — но **в целия проект няма `.gitignore` файл**. Ако някога попълниш `keys.json` с реални ключове локално и направиш `git add .`/`git commit`, те ще влязат в repo-то незащитени.
- **Няма промяна по кода все още** — предложих добавяне на `.gitignore`. Одобрено от теб → изпълнено (виж следващ запис).

### [Стъпка 2.1] Добавяне на `.gitignore`
- **Действие:** създаден е нов файл `.gitignore` в главната директория на проекта.
- **Съдържание:** игнорира `ai-model-finder/keys.json` + няколко стандартни OS/node файла (`.DS_Store`, `Thumbs.db`, `node_modules/`).
- **Риск:** нулев — нов файл, никакъв съществуващ код/поведение не е пипнато.
- **⚠️ Важно за теб:** `.gitignore` пази само **занапред**. Ако в реалния ти repo `keys.json` вече е бил commit-нат с истински ключове в миналото, те остават в git историята и трябва отделно, внимателно почистване (различна, по-рискова операция — само при нужда и с твое изрично одобрение).

---

### [Стъпка 6, начало] Тестова инфраструктура + тестове за `js/network.js`
- **Действие:** добавени са **само нови файлове**, нищо съществуващо не е пипнато:
  - `package.json` (root) — само `"test"` скрипт, ползва вградения `node:test` (Node 18+), **без npm пакети/зависимости, без build стъпка**.
  - `tests/helpers/load-network.mjs` — зарежда `js/network.js` непроменен във vm sandbox (чете файла като текст, изпълнява го изолирано — точно както браузърът би го видял като глобален `<script>`), за да достъпим `fetchTimeout`/`proxied` за тестове.
  - `tests/network.test.mjs` — 8 теста: `proxied()` (с/без proxy, кодиране на специални символи) + `fetchTimeout()` (успешен fetch, timeout грешка на български, нормална мрежова грешка, подразбиращ се 15000ms timeout).
- **Проверка:** `npm test` → **8/8 минали**. `md5sum js/network.js` сравнен преди/след — **идентичен**, файлът не е пипнат по никакъв начин.
- **Проверка за странични ефекти върху сайта:** потвърдено (grep), че `package.json` не се реферира никъде от `index.html`/`app.js`/`sw.js`/`manifest.json` — статичният сайт продължава да работи точно както преди, тестовете са напълно отделен, паралелен слой.
- **Как да пуснеш тестовете ти самия:** `npm test` (или `node --test tests/*.test.mjs`) от главната папка на проекта. Изисква само Node.js 18+, нищо друго за инсталиране.
- **Остава от Стъпка 6:** останалите намесени функции в `app.js` (Step1-4, ViralLab, Stats и т.н.) не са тествани — по-нисък приоритет, обсъждаме при нужда.

### [Стъпка 6, завършено] Тестове за `Storage`/`Keys`/`Vault` (криптиране на API ключове)
- **Действие:** добавени са **само нови файлове**, `app.js` не е пипнат:
  - `tests/helpers/load-app.mjs` — зарежда ЦЕЛИЯ `app.js` непроменен във vm sandbox с минимални browser-like заглушки (`window`/`document`/`localStorage`/`crypto` през вградения Node WebCrypto/`btoa`/`atob`). Преди да напиша това, проверих ръчно (grep), че `app.js` няма опасни извиквания на топ ниво извън регистрация на `DOMContentLoaded` listener — потвърдено безопасно за изолирано зареждане.
  - `tests/vault-keys.test.mjs` — 17 теста: `Storage` (get/set/remove/has, счупен JSON), `Keys` преди Vault (чист текст в localStorage), `Vault` (enable с кратка парола отказва, enable криптира и трие чистия текст, Keys.load() чете от RAM след enable, lock() изчиства RAM, unlock() с правилна/грешна парола, disable() връща чист текст / отказва с грешна парола без да трие blob-а, изолация между отделни инстанции).
- **Технически detail (важен, но не функционален проблем):** първоначално 6 теста фалираха заради Node-специфична особеност — обекти, върнати от изолирания `vm` sandbox, идват от различен JS "realm", и `assert.deepEqual` ги отхвърля дори при еднаква структура. Поправено с helper `assertDeepJSON()` (сравнение по сериализирана форма) — **само в теста**, `app.js` изобщо не е пипан по време на това дебъгване (потвърдено с checksum преди/след).
- **Проверка:** `npm test` → **25/25 минали** (8 network.js + 17 Storage/Keys/Vault). `md5sum app.js js/network.js` сравнени преди/след цялата работа — **и двата файла идентични**.
- **Ръчна проверка преди автоматизацията:** пуснах реален enable→lock→unlock→грешна-парола сценарий на ръка в Node конзола, за да съм сигурен, че поведението отговаря на документираното в коментарите на `app.js`, преди да го формализирам в тестове.

### [Стъпка 6.1] Поправка на счупени пътища в тестовата инфраструктура
- **Открит проблем:** при качването на проекта на 2026-08-08 `npm test` връщаше **0 теста** вместо очакваните 25, защото файловата структура не съвпадаше с вътрешните пътища:
  - `package.json` сочеше към `tests/*.test.mjs`, но реалните файлове са в `test/` (единствено число) + `vault-keys.test.mjs` в главната папка.
  - `test/network.test.mjs` internal import сочеше `./helpers/load-network.mjs`, но `load-network.mjs` е директно в `test/`, без подпапка `helpers/`.
  - `test/load-network.mjs` и `helpers/load-app.mjs` изчисляваха пътя до `js/network.js`/`app.js` с две нива нагоре (`../../`), а реално е нужно само едно ниво.
- **Действие:** поправени са само 4 реда общо, в 3 файла (`package.json`, `test/load-network.mjs`, `test/network.test.mjs`, `helpers/load-app.mjs`) — само пътища, никаква логика.
- **Проверка:** `npm test` → **25/25 минали**. `md5sum app.js js/network.js` преди/след — **идентични**, сайтът не е пипнат.

### [Стъпка 6.2] GitHub Actions workflow за автоматични тестове
- **Действие:** добавен нов файл `.github/workflows/run-tests.yml` — пуска `npm test` при всеки push/PR/ръчно (workflow_dispatch), по същия модел като съществуващите `daily-stats.yml`/`daily-trends.yml`.
- **Защо:** работният процес е през GitHub (без локален Node/Git), затова автоматична проверка при push замества нуждата от ръчно пускане на тестове.
- **Риск:** нулев — нов файл, не пипа съществуващи workflow-и или код.

### [Стъпка 7] Общ retry/fallback helper за providers
- **Анализ преди промяна:** и трите provider файла (`claude.js`, `gemini.js`, `openrouter.js`) вече имаха собствено, почти идентично копие на цикъла "пробвай моделите по ред, при грешка провери дали да превключиш на следващия" — с истински разлики само в кои HTTP кодове означават "смени модела" и дали има вътрешен retry (Gemini прави 1 кратък retry с backoff при 429, Claude/OpenRouter нямат такъв на това ниво).
- **Действие:** нов файл `js/providers/fallback-loop.js` с генерична `runModelFallbackLoop(models, attemptFn, opts)` — цикълът НЕ решава сам кои грешки значат "смени модела"; всичко се решава от provider-специфична `classify(error, model, retries)` функция, подадена от съответния `providers/*.js`.
  - `claude.js` — добавена `_classifyClaudeError()` (429/529 → next, друго → abort), `callClaude()` пренаписана да ползва `runModelFallbackLoop`. `_callClaudeSingle`/`getClaudeModelList` непипнати.
  - `openrouter.js` — добавена `_classifyOpenRouterError()` (429/503/400/без-status → next, друго → abort), `callOpenRouter()` пренаписана. `_callOpenRouterSingle`/`getOpenRouterFreeModels` непипнати.
  - `gemini.js` — единичното извикване е извадено в нова `_callGeminiSingle()` (преди беше inline в цикъла), добавена `_classifyGeminiError()`, която пази ТРИТЕ отделни нюанса от оригинала: мрежова/timeout грешка → тих преход към следващия модел (БЕЗ лог/toast/премахване от ростъра — точно както преди), 429 → 1 кратък retry с 1.5с изчакване после next, 404 → next + чисти кеша на списъка с модели. `callGeminiWithFallback()` пренаписана да ползва `runModelFallbackLoop` с `maxRetriesPerModel: 1`.
  - `index.html` — добавен `<script src="js/providers/fallback-loop.js">` преди provider файловете.
- **Тестове:** нов `test/providers-fallback.test.mjs` (15 теста) + `test/load-provider.mjs` (loader helper) — покриват generic цикъла (success/abort/next/retry/log:false пътищата) И трите `classify*Error` функции поотделно (включително Gemini retry-изчерпване, 404 cache-clear, тих мрежов преход), плюс 1 интеграционен тест на `callClaude` с мокнат `fetchTimeout` (429 на първия модел → превключва на втория). Общо `npm test` → **40/40 минали**.
- **Проверка:** `md5sum app.js js/network.js` преди/след — **идентични**, само `providers/*.js` + `index.html` (1 ред) пипнати умишлено.

### [Извън плана, по твоя заявка] AI Model Finder става реален, извикваем provider
- **Контекст:** отделна заявка успоредно с одита — "искам AI Model Finder да
  се използва навсякъде, където сайтът ползва AI", не само да показва
  списък. Приложено ВЪРХУ вече одитираната кодова база (не отменя нищо
  от Стъпки 1-7 по-горе).
- **Действие:** `js/providers/model-finder.js` пренаписан от информационен
  bridge на пълен 4-ти provider (Groq/Mistral/GitHub Models/Cloudflare
  Workers AI/Pollinations), закачен в `callAI()` (app.js) като последен
  fallback. Единичното извикване минава през **същия** `runModelFallbackLoop()`
  от Стъпка 7 — нов `_classifyModelFinderError()`, аналогичен на
  `_classifyClaudeError()`/`_classifyOpenRouterError()`.
- **Пипнати файлове:** `app.js` (callAI, Settings.fillFields/save/testKeys,
  AIProviderOrder.label, Prefs.setContentProvider whitelist — всички
  targeted добавки, не преработка), `index.html` (2 нови `<option>`, 5
  нови `<input>` полета в view "AI Model Finder"), `sw.js` (CACHE_VERSION
  → v23 + добавен липсващ `fallback-loop.js` в SHELL_FILES),
  `.github/workflows/scrape-ai-models.yml` (върнат — липсваше от това
  качване).
- **Проверка:** `npm test` → **40/40 минали преди И след** промените
  (нито един съществуващ тест пипнат). `node --check` чисто на всички JS
  файлове. Броят view/nav елементи в `index.html` съвпада (19/19).
- **Забележка:** истинско извикване към Groq/Mistral/GitHub Models/
  Cloudflare не може да се тества оттук (няма мрежов достъп до тези
  домейни в средата, в която работя) — логиката следва точно установения
  в Стъпка 7 модел, но реалната проверка е "качи и натисни 🧪 Тествай
  ключовете".

---

### [Извън плана, по твоя заявка] AI Model Finder — 3 конкретни бъга, докладвани от теб
- **Контекст:** докладвал си, че AI Model Finder "не работи коректно" — след
  уточнение, три отделни проблема.
- **Бъг 1 — HF скрейперът връщаше модели само за локална инсталация:**
  `ai-model-finder/app.js` и `scraper.mjs` викаха
  `huggingface.co/api/models?pipeline_tag=...` БЕЗ филтър за реално
  обслужвани (online) модели — резултатът, сортиран по downloads, е
  доминиран от огромни модели (Llama 405B и т.н.), качени само за сваляне,
  без работещ inference endpoint. **Поправка:** добавен `&inference_provider=all`
  към заявката и в двата файла — според официалната HF документация
  (huggingface.co/docs/inference-providers/hub-api#list-models) това връща
  само модели, обслужвани от поне един inference provider.
- **Бъг 2 (открит при анализа, съпътстващ) — несъответствие endpoint/how_to_connect:**
  за chat модели `endpoint` полето сочеше остарелия
  `api-inference.huggingface.co/models/<id>`, докато `how_to_connect` текста
  до него КАЗВАШЕ да се ползва `router.huggingface.co/v1` — двете си
  противоречаха. Поправено и в двата файла: `endpoint` вече също сочи
  router-а за chat модели (embeddings си бяха вече правилни).
- **Бъг 3 — "Тествай ключовете" в AI Model Finder не показваше нищо:**
  бутонът викаше глобалния `Settings.testKeys()` (тества И Claude/Gemini/
  OpenRouter/YouTube/Spotify/GitHub Token), но той пише резултата САМО в
  `#keyTestOut` — елемент, който живее във view "Настройки → API Ключове"
  (`.view{display:none} .view.active{display:block}` — виж `Nav.showView`).
  Докато потребителят стои във view "AI Model Finder", резултатът се пише в
  скрит елемент → изглежда все едно нищо не се случва. **Поправка:** нова
  `Settings.testModelFinderKeys()` в `app.js` — тества САМО 5-те Model Finder
  ключа (вика вече съществуващия `ModelFinder.testKeys()`) и пише резултата
  в нов `#modelFinderKeyTestOut` (добавен в `index.html`, веднага под бутона,
  видим в същия view). Бутонът в `index.html` вече вика новата функция;
  `Settings.testKeys()` и `#keyTestOut` останаха непипнати за view "Настройки".
- **Пипнати файлове:** `ai-model-finder/app.js`, `ai-model-finder/scraper.mjs`
  (само HF заявката + endpoint реда), `app.js` (нов метод в `Settings`,
  съществуващият `testKeys()` непипнат), `index.html` (1 нов `<div>`, 1 сменен
  `onclick`), `sw.js` (`CACHE_VERSION` → v24).
- **Проверка:** `npm test` → **40/40 минали** (нито един съществуващ тест
  пипнат). `node --check` чисто на всички засегнати `.js`/`.mjs` файлове.
- **Забележка:** реалната HF заявка с `inference_provider=all` не може да се
  провери оттук (няма мрежов достъп до huggingface.co в средата, в която
  работя) — филтърът е по официалната HF документация; провери резултата
  като отвориш AI Model Finder и натиснеш "Намери ми AI модели".

### [Стъпка 8, първа итерация] `SystemLog` изваден в `js/system-log.js`
- **Анализ преди промяна:** от 22-та останали top-level namespace-а в `app.js`
  (`Storage`, `AppState`, `Vault`, `Keys`, `ModelPref`, `AIProviderOrder`,
  `AICallLog`, `QuotaTracker`, `AICache`, `Nav`, `Settings`, `ProjectArchive`,
  `GeminiValidator`, `LyricsHistory`, `Step1-4`, `ViralLab`, `HookArena`,
  `GhostAudience`, `QuickUpload`, `Prefs`, `SystemLog`, `TrackRecord`, `Stats`),
  `SystemLog` имаше най-малко външни връзки (grep потвърди само 2: извикването
  `SystemLog.init()` в `app.js` вътре в `DOMContentLoaded` листенъра, и
  `onclick="SystemLog.clear()"` в `index.html`) — най-безопасният кандидат за
  първа итерация. `Settings` (738 реда, най-голям и най-заплетен — засяга
  ключове/Vault/Model Finder/тестове) нарочно оставен за по-късно, като
  най-рисковия namespace.
- **Действие:** нов файл `js/system-log.js` — съдържанието на `SystemLog` е
  преместено 1:1 (без промяна на логиката), с header коментар по модела на
  вече извадените файлове (`network.js`, `agent-roster.js` и т.н.). Премахнат
  от `app.js` (само тези редове, нищо друго). `index.html` — нов
  `<script src="js/system-log.js">` ПРЕДИ `app.js` (редът е без значение тук,
  защото `SystemLog.init()` се извиква вътре в `DOMContentLoaded`, не на
  top-level, но следва установения ред "helpers преди app.js"). `sw.js` —
  добавен в `SHELL_FILES` + `CACHE_VERSION` → v25.
- **Проверка:** `npm test` → **40/40 минали**. `node --check` чисто на
  `app.js` и новия `js/system-log.js`. `grep "SystemLog" app.js` → само 1 ред
  останал (`SystemLog.init()`, очаквано). Брой `view`/`nav-btn` елементи в
  `index.html` непроменен (19/19).
- **Следваща итерация (при желание):** следващите по нисък риск кандидати са
  `AppState`, `AICache`, `Prefs` или `QuotaTracker` (всеки под 80 реда, малко
  външни връзки) — `Settings` последен, като най-рисков.

### [Стъпка 8, втора итерация] `AICache` изваден в `js/ai-cache.js`
- **Анализ преди промяна:** grep потвърди `AICache`/`AI_CACHE_KEY`/
  `AI_CACHE_MAX_ENTRIES`/`_simpleHash` да се ползват **само** вътре в
  `app.js` (от `ViralLab` и `GhostAudience`) — нула външни референции от
  `index.html` или други `js/*.js` файлове (по-изолиран дори от
  `SystemLog`, който имаше 2 външни връзки). Единствената му зависимост е
  глобалният `Storage`, който си остава в `app.js` — безопасно заради
  установения принцип "методите се викат по-късно по време, не на топ
  ниво при зареждане на скрипта".
- **Действие:** нов файл `js/ai-cache.js` — `AI_CACHE_KEY`,
  `AI_CACHE_MAX_ENTRIES`, `_simpleHash()` и `AICache` преместени 1:1 (без
  промяна на логиката), с header коментар по установения модел. Премахнати
  от `app.js` (само тези редове, заменени с 1 ред pointer коментар).
  `index.html` — нов `<script src="js/ai-cache.js">` между
  `system-log.js` и `app.js`. `sw.js` — добавен в `SHELL_FILES` +
  `CACHE_VERSION` → v26.
- **Проверка:** `npm test` → **40/40 минали**. `node --check` чисто на
  `app.js`, `js/ai-cache.js`, `sw.js`. `md5sum` на всички останали файлове
  (всички провайдъри, `network.js`, `system-log.js` и т.н.) — **идентични**,
  само трите умишлено пипнати файла (`app.js`/`index.html`/`sw.js`) са
  различни. `AICache.get()`/`.set()` извикванията в `ViralLab`/
  `GhostAudience` останаха непроменени (само дефиницията се премести).
  Брой `view`/`nav-btn` елементи в `index.html` непроменен (19 view / 24
  nav-btn).
- **Следваща итерация (при желание):** остават `AppState`, `Prefs`,
  `QuotaTracker` като следващи ниско-рискови кандидати (описани в
  предната итерация по-горе) — `Settings` последен, като най-рисков.

### [Стъпка 8, трета итерация] `QuotaTracker` изваден в `js/quota-tracker.js`
- **Анализ преди промяна:** grep потвърди `QUOTA_TRACKER_KEY` да се ползва
  само вътре в `QuotaTracker`. Единствената зависимост е глобалният
  `Storage`. Външни извиквания: `QuotaTracker.record()` от
  `js/providers/fallback-loop.js` (вътре във функция, извиква се по-късно
  по време — редът на скриптовете е без значение) и
  `QuotaTracker.render()` от `onclick` в `index.html`.
- **Действие:** нов файл `js/quota-tracker.js` — `QUOTA_TRACKER_KEY` и
  `QuotaTracker` преместени 1:1, header коментар по установения модел.
  Премахнати от `app.js` (заменени с 1 ред pointer коментар). `index.html`
  — нов `<script src="js/quota-tracker.js">` между `ai-cache.js` и
  `app.js`. `sw.js` — добавен в `SHELL_FILES` + `CACHE_VERSION` → v27.
- **Проверка:** `npm test` → **40/40 минали**. `node --check` чисто.
  `md5sum` на всички останали файлове (вкл. `fallback-loop.js`,
  `ai-cache.js`, `system-log.js`) — **идентични**, само трите умишлено
  пипнати файла (`app.js`/`index.html`/`sw.js`) различни.
  `QuotaTracker.render()` извикването в `app.js` (Nav) останало непроменено.
  Брой `view`/`nav-btn` в `index.html` непроменен (19/24).
- **Следваща итерация (при желание):** остават `AppState` и `Prefs` като
  следващи ниско-рискови кандидати — `Settings` последен, като най-рисков.

### [Стъпка 8, четвърта итерация] `AppState` изваден в `js/app-state.js`
- **Анализ преди промяна:** `AppState` е с най-много ВЪТРЕШНИ извиквания в
  `app.js` (~70+ места из Step1-4, ProjectArchive, GeminiValidator,
  LyricsHistory, Nav — очаквано, това е централното "състояние на
  проекта"), но само 1 ВЪНШНА референция (диагностичен текст в
  `system-test.js`, не истинско извикване). Единствената зависимост е
  `Storage`. **Важен нюанс:** `STORAGE_KEY` се ползва и извън `AppState` —
  в `Settings.newProject()` (`Storage.remove(STORAGE_KEY)`) — това работи
  безпроблемно, защото top-level `const` в отделни classic `<script>`
  тагове на една страница споделят общ global scope (стандартно поведение
  на браузъра), точно както `KEYS_STORAGE`/`VAULT_ENC_KEY` вече се ползват
  между `Vault`/`Keys` и остатъка от `app.js`.
- **Действие:** нов файл `js/app-state.js` — `STORAGE_KEY` и `AppState`
  преместени 1:1, header коментар обяснява изрично споделянето на
  `STORAGE_KEY`. Премахнати от `app.js` (заменени с pointer коментар,
  `KEYS_STORAGE` — непипнат, остава за `Keys`). `index.html` — нов
  `<script src="js/app-state.js">` преди `app.js`. `sw.js` — добавен в
  `SHELL_FILES` + `CACHE_VERSION` → v28.
- **Тестова инфраструктура:** `helpers/load-app.mjs` вече зарежда
  `js/app-state.js` в СЪЩИЯ vm sandbox ПРЕДИ `app.js` (mirror на реалния
  ред в `index.html`) — иначе тестовете нямаше да виждат `AppState`/
  `STORAGE_KEY`. Само тестова инфраструктура, `app.js` логиката непипната.
- **Проверка:** `npm test` → **40/40 минали**. `node --check` чисто на
  всички засегнати файлове. `md5sum` — точно 4 файла различни, колкото
  умишлено пипнати (`app.js`/`index.html`/`sw.js`/`helpers/load-app.mjs`),
  всичко останало (вкл. всички тестове, всички провайдъри) идентично.
  Всички ~70 `AppState.data.*` извиквания в `app.js` останаха непроменени
  — само дефиницията се премести. Брой `view`/`nav-btn` в `index.html`
  непроменен (19/24).
- **Следваща итерация (при желание):** остава `Prefs` като следващ
  ниско-рисков кандидат — `Settings` последен, като най-рисков.

### [Стъпка 8, пета итерация] `Prefs` изваден в `js/prefs.js`
- **Анализ преди промяна:** grep потвърди `PREFS_STORAGE` да се ползва
  само вътре в `Prefs`. Външни извиквания (onclick в `index.html`):
  `setContentProvider`/`toggleAutopilot`/`toggleHealthCheck`/
  `toggleTheme`. Реални зависимости извън `Prefs`: `Storage`, `toast()`
  (вече в `js/ui/toast.js`), `AIProviderOrder.label()` и
  `Settings.silentHealthCheck()` (и двете все още в `app.js`) — и трите
  се извикват само лениво по-късно по време (при клик на потребителя или
  от `Prefs.init()`, самият той извикан от `DOMContentLoaded` в `app.js`),
  не на топ ниво — затова редът на скриптовете не чупи нищо.
- **Действие:** нов файл `js/prefs.js` — `PREFS_STORAGE` и `Prefs`
  преместени 1:1. Премахнати от `app.js` (заменени с pointer коментар).
  `index.html` — нов `<script src="js/prefs.js">` между
  `quota-tracker.js` и `app.js`. `sw.js` — добавен в `SHELL_FILES` +
  `CACHE_VERSION` → v29.
- **Тестова инфраструктура:** без промяна тук — потвърдено (`npm test`
  преди да пипна `helpers/load-app.mjs`), че нито един от 40-те
  съществуващи теста не минава през код, който реферира `Prefs`, така че
  не се налагаше да го добавям в тестовия sandbox (за разлика от
  `AppState` в предната итерация).
- **Проверка:** `npm test` → **40/40 минали**. `node --check` чисто.
  `md5sum` — точно 3 файла различни (`app.js`/`index.html`/`sw.js`),
  всичко останало идентично (вкл. `helpers/load-app.mjs` и всички
  тестове — непипнати този път). `Prefs.data.*`/`Prefs.init()`
  извикванията в `app.js` останаха непроменени. Брой `view`/`nav-btn` в
  `index.html` непроменен (19/24).
- **Резултат след 5 итерации:** `app.js` намален от 3480 → 3321 реда
  (~4.6%). Остават 17 namespace-а — следващите по нисък риск (по преценка
  от предишните итерации): `ModelPref`, `AIProviderOrder`, `AICallLog`,
  `Nav`. `Settings` (738 реда) остава последен, като най-рисков.

### [Стъпка 8, шеста итерация] `ModelPref` изваден в `js/model-pref.js`
- **Анализ преди промяна:** grep потвърди `ModelPref.*` да се извиква на
  6 места, всичките вътре в `Settings` (в `app.js`) — никакъв onclick в
  `index.html`. Единствената зависимост навън е `Storage`; единствената
  връзка в обратна посока е ленив извик `Settings.renderModelPref()` от
  `_renderIfVisible()`, задействан само ако панелът за модел предпочитания
  е видим в момента — не на топ ниво, следователно редът на скриптовете
  не чупи нищо.
- **Действие:** нов файл `js/model-pref.js` — `MODEL_PREF_KEY` и
  `ModelPref` преместени 1:1, header коментар по установения модел.
  Премахнати от `app.js` (заменени с 1 ред pointer коментар). `index.html`
  — нов `<script src="js/model-pref.js">` между `js/prefs.js` и `app.js`.
  `sw.js` — добавен в `SHELL_FILES` + `CACHE_VERSION` → v30.
- **Тестова инфраструктура:** без промяна — потвърдено, че нито един от
  40-те съществуващи теста не реферира `ModelPref`, значи не се налагаше
  да го добавям в `helpers/load-app.mjs` (същата логика както при `Prefs`
  в предната итерация).
- **Проверка:** `node --check` чисто на всички засегнати файлове
  (`app.js`, `js/model-pref.js`, `sw.js`). Всичките 6 извиквания на
  `ModelPref.*` в `Settings` останаха непроменени — само дефиницията се
  премести. `app.js` намален от 3321 → 3271 реда.
- **Следваща итерация (при желание):** остават `AIProviderOrder`,
  `AICallLog`, `Nav` като следващи ниско-рискови кандидати — `Settings`
  последен, като най-рисков.

### [Стъпка 8, седма итерация] `AIProviderOrder` изваден в `js/ai-provider-order.js`
- **Анализ преди промяна:** grep потвърди `AIProviderOrder.*` да се
  извиква на 8 места, всичките вътре в `Settings`/health-check логиката
  в `app.js` — никакъв onclick в `index.html`. Единствената зависимост е
  `Storage`; никаква обратна връзка (за разлика от `ModelPref`, който
  вика `Settings.renderModelPref()` лениво).
- **Действие:** нов файл `js/ai-provider-order.js` — `AI_PROVIDER_ORDER_KEY`
  и `AIProviderOrder` преместени 1:1, header коментар по установения
  модел. Премахнати от `app.js` (заменени с 1 ред pointer коментар).
  `index.html` — нов `<script src="js/ai-provider-order.js">` между
  `js/model-pref.js` и `app.js`. `sw.js` — добавен в `SHELL_FILES` +
  `CACHE_VERSION` → v31.
- **Тестова инфраструктура:** без промяна — нито един от 40-те теста не
  реферира `AIProviderOrder`.
- **Проверка:** `node --check` чисто на всички засегнати файлове.
  Всичките 8 извиквания на `AIProviderOrder.*` останаха непроменени —
  само дефиницията се премести. `app.js` намален от 3271 → 3253 реда.
- **Следваща итерация (при желание):** остават `AICallLog`, `Nav` като
  следващи ниско-рискови кандидати — `Settings` последен, като
  най-рисков.

### [Стъпка 8, осма итерация] `AICallLog` изваден в `js/ai-call-log.js`
- **Анализ преди промяна:** grep показа значително по-голяма повърхност
  от предните два namespace-а — 15 извиквания в `app.js` (health-check
  логика, `Settings.testKeys()`, диагностичен leaderboard) **плюс** 3
  директни `onclick` в `index.html` (`AICallLog.render()`,
  `AICallLog.clear()`, `AICallLog.renderLeaderboard()`). Единствената
  зависимост е `Storage`. Тъй като `<script>` таговете споделят общ
  global scope в браузъра (класическо, не module поведение — вече
  установено при предните итерации), онлайн `onclick` атрибутите
  продължават да работят независимо къде е дефиниран `AICallLog`,
  стига файлът да се зареди преди клика (гарантирано е — той е в
  `<head>`/преди body съдържанието да стане интерактивно).
- **Действие:** нов файл `js/ai-call-log.js` — `AI_CALL_LOG_KEY`,
  `AI_CALL_LOG_MAX` и `AICallLog` преместени 1:1, header коментар по
  установения модел (изрично споменава onclick зависимостта).
  Премахнати от `app.js` (заменени с 1 ред pointer коментар).
  `index.html` — нов `<script src="js/ai-call-log.js">` между
  `js/ai-provider-order.js` и `app.js`. `sw.js` — добавен в
  `SHELL_FILES` + `CACHE_VERSION` → v32.
- **Тестова инфраструктура:** без промяна — нито един тест не реферира
  `AICallLog`.
- **Проверка:** `node --check` чисто на всички засегнати файлове.
  Всичките 15 извиквания в `app.js` + 3-те `onclick` в `index.html`
  останаха непроменени — само дефиницията се премести. `app.js` намален
  от 3253 → 3157 реда.
- **Следваща итерация (при желание):** остава `Nav` като последен
  ниско-рисков кандидат преди `Settings` (738 реда, нарочно последен,
  като най-рисков).

### [Стъпка 8, девета итерация] `Nav` изваден в `js/nav.js`
- **Анализ преди промяна:** `Nav` е роутерът за sidebar-а — извикван е
  на 30+ места чрез `onclick="Nav.showView(...)"` директно в
  `index.html` (навигационни бутони, sidebar backdrop, mobile toggle),
  плюс `Nav.init()` веднъж в `app.js`. Самият `showView()` чете МНОГО
  други namespace-и (`Step2`, `Stats`, `ProjectArchive`, `Settings`,
  `AICallLog`, `QuotaTracker`, `AgentRoster`, `NicheToolkit`,
  `SystemTest`, `ModelFinder`) — но всичко това са runtime извиквания
  при клик на потребителя, не top-level код. Ключова проверка:
  `Nav.init()` се вика единствено вътре в `DOMContentLoaded` listener-а
  в `app.js` (ред 3073 преди промяната) — т.е. едва след като ВСИЧКИ
  `<script>` тагове вече са се изпълнили, значи редът на файловете
  спрямо `app.js` не е критичен. Единствената реална зависимост при
  зареждане е `AppState.load()` вътре в `init()` — `AppState` вече е
  извадена и се зарежда преди `app.js` от по-ранна итерация.
- **Действие:** нов файл `js/nav.js` — целият `Nav` обект преместен
  1:1, header коментар обяснява изрично защо редът на скриптовете не е
  проблем тук. Премахнат от `app.js` (заменен с 1 ред pointer коментар).
  `index.html` — нов `<script src="js/nav.js">` между `js/ai-call-log.js`
  и `app.js`. `sw.js` — добавен в `SHELL_FILES` + `CACHE_VERSION` → v33.
- **Тестова инфраструктура:** без промяна — нито един тест не реферира
  `Nav` (тестовете покриват само чисти функции: `network.js`,
  `Storage`/`Keys`/`Vault`).
- **Проверка:** `node --check` чисто на всички засегнати файлове.
  Всичките 30+ `onclick="Nav.*"` в `index.html` + извикването на
  `Nav.init()` в `app.js` останаха непроменени — само дефиницията се
  премести. `app.js` намален от 3157 → 3102 реда.
- **Резултат след 9 итерации:** `app.js` намален от 3480 → 3102 реда
  (~10.9%). Остават 13 namespace-а. `Settings` (738 реда) е единствената
  останала, нарочно оставена последна като най-рискова — след нея
  Стъпка 8 приключва.

### [Стъпка 8, десета итерация — ПОСЛЕДНА] `Settings` изваден в `js/settings.js`
- **Анализ преди промяна:** `Settings` е най-големият и най-свързан
  namespace (728 реда) — управлява API ключове, Trezor (Vault)
  криптиране, AuthGate (парола пред целия dashboard), модел
  предпочитания, ред на AI providers, export/import на ключове и на
  целия проект, "Нов проект". grep показа, че **абсолютно всичко** вътре
  е runtime код в методи (fillFields, vaultEnable/Disable/Lock/Unlock,
  authGateSetup/Disable/bioRegister/bioForget, save, testKeys,
  listGeminiModels, refreshModelLists, exportKeys/importKeys,
  exportProject/importProject, newProject и т.н.) — **нищо не се
  изпълнява на топ ниво** при дефиниране на обекта, затова редът на
  `<script>` таговете не е критичен. Единствената външна референция
  към `Settings.*` извън собствения му блок в `app.js` беше 1 коментар
  (не истинско извикване) — всички реални извиквания са в `onclick`
  атрибути в `index.html` (17 места: ключове, AuthGate, export/import,
  "Нов проект") + вътре в `Nav.showView()` (вече в `js/nav.js`, тя вика
  `Settings.fillFields()`/`Settings.silentHealthCheck()` runtime, след
  пълно зареждане). Зависимостите НА `Settings` (Keys, Vault, Storage,
  AuthGate, AppState, Prefs, ModelPref, AIProviderOrder, AICallLog, Nav,
  ModelFinder, GeminiValidator, Stats, ProjectArchive, toast(),
  getClaudeModelList/getGeminiModelList/getOpenRouterFreeModels) всички
  вече съществуват в общия global scope — няма нова зависимост, само
  местоположението на дефиницията се мести.
- **Действие:** нов файл `js/settings.js` — целият `Settings` обект
  преместен **байт-по-байт идентично** (потвърдено с `diff` срещу
  оригинално извлечения блок — 0 разлики в тялото, само добавен header
  коментар отгоре). Премахнат от `app.js` (заменен с 2-редов pointer
  коментар). `index.html` — нов `<script src="js/settings.js">` между
  `js/nav.js` и `app.js`. `sw.js` — добавен в `SHELL_FILES` +
  `CACHE_VERSION` → v34.
- **Тестова инфраструктура:** без промяна — нито един тест не реферира
  `Settings` (тестовете покриват само чисти функции: `network.js`,
  `Storage`/`Keys`/`Vault`).
- **Проверка:** `node --check` чисто на всички засегнати файлове
  (`app.js`, `js/settings.js`, `sw.js`). `diff` потвърди byte-identical
  body на извадения `Settings` спрямо оригинала. Всичките 17 `onclick`
  в `index.html` + извикванията от `Nav.showView()` останаха
  непроменени. `app.js` намален от 3102 → 2374 реда.
- **🎉 ИТОГ на Стъпка 8 (10 итерации, приключена):** `app.js` намален от
  оригиналните **3480 → 2374 реда (~31.8% намаление)**. 10 namespace-а
  извадени в собствени файлове: `SystemLog`, `AICache`, `QuotaTracker`,
  `AppState`, `Prefs`, `ModelPref`, `AIProviderOrder`, `AICallLog`,
  `Nav`, `Settings`. Остават в `app.js` други намерени по-рано
  namespace-и (Step1-4, ViralLab, Stats, ProjectArchive, GeminiValidator,
  QuickUpload, NicheToolkit, AgentRoster, SystemTest, ModelFinder,
  AuthGate, Vault, Keys, Storage и др.) — не са били част от Стъпка 8
  плана (по-нисък приоритет от началото, виж запис в Стъпка 6), могат
  да се обсъдят като нова, отделна стъпка при желание.
- **Всяка итерация е тествана с `node --check` + checksum/diff
  проверки; тестовата инфраструктура (40/40 теста) остана изцяло
  недокосната през цялата Стъпка 8, защото покрива само `network.js` и
  `Storage`/`Keys`/`Vault` — нито един от изнесените namespace-и не е
  бил в тестовия обхват.**

## Решения, взети от теб (2026-08-08)

1. **Дублирани HTML файлове** — оставяме ги непипнати засега. Ще решим по-късно кое е активно/legacy. Нищо не е преместено или изтрито.
2. **`.gitignore` за `keys.json`** — одобрено и изпълнено (виж по-горе).
3. **Baseline за `visualizer.html`** — отложено. Стъпки 3 и 4 от плана (baseline + извеждане на асетите) са на пауза до бъдещо решение как точно да процедираме (checksum подход vs. ръчно визуално тестване от твоя страна).

---

## Какво остава (следващ път, когато продължим)

- Стъпки 3–8 от оригиналния план са на пауза/чакат — виж таблицата по-горе.
- Когато решиш да се върнем на `visualizer.html`, просто кажи и ще подходим или с checksum-базирания метод, или ще изчакаме твоя визуален тест — по твой избор в момента.
- Когато решиш статуса на дублираните HTML файлове, кажи и ще действаме съответно (архивиране/изтриване само с изрично твое потвърждение).

## Какво остава (следваща сесия, по приоритет) — 2026-08-11

1. **Първо реално пускане** на `niche-scores.yml` (ръчно от Actions) —
   потвърждение на живите заявки към YouTube Trending, Wikipedia,
   MusicBrainz, Reddit, Deezer, iTunes (нищо от новия код не е
   тествано на живо, средата за писане няма достъп до мрежата).
2. Discogs, ListenBrainz, YouTube RSS — допълнителни Demand/Community
   сигнали за `track_niche_scores.py`.
3. По-силна независима discovery генерация (не само YouTube bootstrap
   + потвърждение) — виж "честно ограничение" по-горе.
4. `config.json` → `niche_scan_niches` с per-ниша feasibility/
   monetization, ако потребителят поиска персонализация отвъд
   неутралните placeholder-и.
