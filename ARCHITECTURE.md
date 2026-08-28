# CD-B Records Dashboard — Карта на проекта

**Цел на този документ:** да можеш (или бъдещ Клод) да работиш по
**един** модул наведнъж, без да подаваш целия проект като контекст —
и без риск да счупиш нещо друго. Прочети този файл + само файла,
който пипаш (+ файловете от "Зависимости" по-долу, ако правиш нещо
нетривиално) — това е достатъчно в 95% от случаите.

**Как да го ползваш при нова задача:**
1. Намери модула, който трябва да промениш, в таблицата по-долу.
2. Прочети "Зависимости" — това е пълният списък неща, от които
   зависи модулът (методи/константи на други модули). Не ти трябва
   нищо друго.
3. Прочети "Кой го ползва" — това е списъкът модули, които биха се
   счупили, ако смениш публичния API (имена на методи, аргументи,
   формат на връщаните данни) на този модул. Ако само добавяш нов
   метод или пипаш вътрешна логика без да пипаш сигнатурите — не е
   нужно да четеш нищо от този списък.
4. Ако е нов feature: нов файл, собствен namespace, добавен в
   `index.html` + `sw.js` (виж "Правила" по-долу) — не бъркай в
   `app.js` или в чужд модул.

---

## Статус на модулизацията

✅ **Завършена.** Оригиналният `app.js` (2374 реда, всичко в 1 файл)
е разделен на **18 самостоятелни модула** + `app.js` като чист
bootstrap (119 реда — само `window.addEventListener("DOMContentLoaded", ...)`
и историческите pointer коментари). Хронология и pointer коментари
за всяко преместване стоят в `app.js` на мястото, откъдето е
извадено съответното нещо.

| # | Namespace(-и) / функции | Файл | Итерация |
|---|---|---|---|
| 1 | `Stats` | `js/stats.js` | 1 |
| 2 | `GeminiValidator` | `js/gemini-validator.js` | 2 |
| 3 | `ProjectArchive` (+`ARCHIVE_STORAGE`) | `js/project-archive.js` | 3 |
| 4 | `QuickUpload` | `js/quick-upload.js` | 4 |
| 5 | `Step2` | `js/step2.js` | 5 |
| 6 | `Step4` | `js/step4.js` | 6 |
| 7 | `Step3` | `js/step3.js` | 7 |
| 8 | `Step1` | `js/step1.js` | 8 |
| 9 | `ViralLab` + `HookArena` + `GhostAudience` | `js/viral-lab.js` | 9 |
| 10 | `Storage` + `Vault` + `Keys` | `js/storage.js` | 10 |
| 11 | `TrackRecord` (+`TRACK_STORAGE`) | `js/track-record.js` | 11 |
| 12 | `LyricsHistory` | `js/lyrics-history.js` | 12 |
| 13a | `callAI()`, `fileToBase64()`, `extractJson()` | `js/ai-helpers.js` | 13 |
| 13b | `restoreUI()`, `updateVaultBanner()` | `js/ui-bootstrap.js` | 13 |

По-рано (преди тези 13 сесии, извън обхвата, който съм виждал 1:1,
само по pointer коментари в `app.js`): `AppState`, `ModelPref`,
`AIProviderOrder`, `AICallLog`, `QuotaTracker`, `AICache`, `Nav`,
`Settings`, `Prefs`, `ModelFinder`, `NicheToolkit`, `AgentRoster`,
`SystemTest`, `AuthGate` — вече са в собствени файлове (виж таблица
"Модули без пълен изходен код" по-долу).

**Остава в `app.js`** (119 реда): само
`window.addEventListener("DOMContentLoaded", ...)` — bootstrap
"лепилото", което подрежда извикванията на всички модули при
зареждане на страницата. Няма нито една собствена функция или
namespace — вече е чисто "main()" на приложението.

---

## Модули с пълен изходен код (проверени, точна информация)

### `js/storage.js` — `Storage`, `Vault`, `Keys`
**Основа на всичко.** Няма зависимости от други модули.
- `Storage`: `get`, `set`, `remove`, `has`, `getRaw`, `setRaw` —
  wrapper над `localStorage`.
- `Vault`: `isEnabled`, `isUnlocked`, `enable`, `disable`, `lock`,
  `unlock`, `load`, `save`, `_deriveKey`, `_reencrypt` — опционално
  AES-GCM криптиране на API ключовете.
- `Keys`: `load`, `save` — четат/пишат през `Vault`, ако е включен,
  иначе директно през `Storage`.
- Storage ключове: `KEYS_STORAGE`, `VAULT_ENC_KEY`, `VAULT_FLAG_KEY`.
- **Кой го ползва:** буквално всичко останало (AppState, ModelPref,
  AICallLog, QuotaTracker, AICache, Prefs, TrackRecord, всички
  Step-ове, Stats, ProjectArchive...).
- **Script ред:** зареден пръв от всички (преди `js/ui/toast.js`).

### `js/track-record.js` — `TrackRecord`
- Методи: `load`, `saveAll`, `save`, `link`, `render`,
  `getCalibrationContext`.
- Storage ключ: `TRACK_STORAGE`.
- **Зависимости:** `AppState`, `Storage`, `toast()`.
- **Кой го ползва:** `ViralLab` (`viral-lab.js`) — за запис на
  прогноза и за калибрационен контекст в нови анализи.

### `js/lyrics-history.js` — `LyricsHistory`
- Методи: `push`, `render`, `toggle`, `revert`.
- **Зависимости:** `AppState`.
- **Кой го ползва:** `Step1` (при ново генериране), `ViralLab`
  (при "✨ Подобри"), директно от `index.html` бутон "🕐 История на
  версиите".

### `js/viral-lab.js` — `ViralLab`, `HookArena`, `GhostAudience`
Три тясно свързани обекта в един файл (анализ на вирусен потенциал,
hook evolution, симулация на фокус-група).
- `ViralLab`: `analyze`, `improveSection`, `render`, `_bar`, `_stars`.
- `HookArena`: `start`, `run`, `_generateInitial`, `_breed`,
  `_scoreHooks`, `_renderGeneration`, `compareWithRealHits`.
- `GhostAudience`: `run`, `render`.
- **Зависимости:** `AppState`, `GeminiValidator`, `LyricsHistory`,
  `TrackRecord`, `callAI()`, `extractJson()`, `toast()`.
- **Кой го ползва:** `Step1` (извиква `ViralLab.analyze()`), `app.js`
  → `restoreUI()` (извиква `ViralLab.render(p.viralReport)` при
  зареждане на запазен проект).

### `js/step1.js` — `Step1`
Главният workflow за нова песен: ниша → Album Sprint → концепция →
текст.
- Методи: `scanNiches`, `_autoTrendScan`, `_scoreGivenNiches`,
  `_renderNicheResults`, `runOutlierScan`, `runKeywordSuggest`,
  `generateAlbumSprint`, `_scoreAlbumSprint`, `_renderAlbumSprint`,
  `useAlbumIdea`, `_renderDashNicheQuick`, `generateConcept`,
  `generateLyrics`, `validateWithGemini`.
- **Зависимости:** `AppState`, `Keys`, `Storage`, `GeminiValidator`,
  `LyricsHistory`, `ViralLab`, `callAI()`, `callGemini()`,
  `extractJson()`, `fetchTimeout()`, `toast()`,
  `NICHE_TOOLKIT_SCORES_KEY` (от `js/niche-toolkit.js`).

### `js/step2.js` — `Step2`
- Методи: `syncTitleToVisualizer`, `generateFxConfig`.
- **Зависимости:** `AppState`, `callAI()`, `extractJson()`,
  `GeminiValidator`, `toast()`.
- Бележка в кода: видео логиката на визуализатора все още не е
  вградена тук — placeholder за бъдеща работа.

### `js/step3.js` — `Step3`
DistroKid & Обложка.
- Методи: `generateCoverPrompt`, `generateCoverImage`,
  `_generateCoverImageGemini`, `_generateCoverImagePollinations`,
  `generateCoverImageFree`, `generateSpotifyAppleText`,
  `buildDistrokidFields`, `copyField`, `_copySA`, `generateABTitles`,
  `checkSimilarity`, `generateShortFormScripts`, `_copyShortForm`,
  `_useTitle`.
- **v1.27.0:** `generateCoverImage()` пробва Gemini/Imagen първи (ако
  има ключ), при грешка/липсващ ключ автоматично пада на Pollinations
  (`pollinationsImageUrlAsync()`, безплатно, без ключ). Нов
  `generateCoverImageFree()` — директен бутон, прескача Gemini.
- **Зависимости:** `AppState`, `Keys`, `callAI()`, `callGemini()`,
  `extractJson()`, `fetchTimeout()`, `proxied()`, `GeminiValidator`,
  `toast()`, `pollinationsImageUrlAsync()` (нова, виж
  `js/providers/pollinations-image.js`).

### `js/step4.js` — `Step4`
YouTube публикуване (unlisted).
- Методи: `initGoogleAuth`, `uploadVideo`, `uploadCaptions` (нов,
  v1.27.0).
- Свойства: `tokenClient`, `accessToken`.
- **v1.27.0:** OAuth scope разширен с `youtube.force-ssl` (нужен за
  `captions.insert`) — потребители, вписани преди тази версия, трябва
  да се впишат отново. `uploadCaptions(videoId, srtContent,
  languageCode, name)` — multipart качване на `.srt` към вече качено
  видео.
- **Зависимости:** `Keys`, `AppState`, `QuickUpload`, `toast()`.

### `js/quick-upload.js` — `QuickUpload`
"⚡ Бърз ъплоуд за стари песни" — прескача концепция/обложка.
- Методи: `initListener`, `onAudioSelected`, `_pastedLyrics`,
  `_sendAudioToVisualizer`, `_checkBothReady`, `_runAnalysisAndMeta`,
  `_fillResultFields`, `generateSubtitles` (нов, v1.27.0), `autoUpload`,
  `manualUpload`, `runFull`, `_setRunning`, `_setVideoProgress`, `log`.
- Свойства: `audioFile`, `videoBlob`, `videoFileName`, `subtitlesSrt`
  (нов, v1.27.0), `subtitlesLanguageCode` (нов, v1.27.0).
- **v1.27.0:** `generateSubtitles()` транскрибира `audioFile` през
  `callGroqTranscribe()` (Groq Whisper), генерира `.srt` с
  `segmentsToSrt()`. `autoUpload()`/`manualUpload()` вече автоматично
  извикват `Step4.uploadCaptions()` след успешен video upload, ако
  `subtitlesSrt` вече е готов (не прекъсва качването при грешка тук,
  само лог с ⚠️).
- **Зависимости:** `callAI()`, `callGeminiMultimodal()`, `toast()`,
  `callGroqTranscribe()`, `segmentsToSrt()` (нови, виж
  `js/providers/subtitles.js`), `Step4.uploadCaptions()`.

### `js/shorts-studio.js` — `ShortsStudio` (нов)
"🎞️ AI Shorts Studio" — качваш 1 песен → AI избира N различни "hook"
момента → визуализаторът прави по едно 9:16 видео за всеки → AI
генерира уникално заглавие/описание/хаштагове за всеки → 1 бутон качва
всички последователно в YouTube (unlisted).
- Методи: `onAudioSelected`, `runFull`, `_analyzeAndPickMoments` (Gemini
  multimodal — жанр/настроение/език/текст + масив от N `{start,end,
  hook_reason,hook_text}` диапазона), `_generateMetaForAll` (Claude —
  масив от N `{title,description,tags}`, всеки различен от другите),
  `_renderAllClips`/`_renderOneClip` (последователно, презарежда
  собствен скрит iframe `#shortsVisualizerFrame` за всеки клип с ново
  `cdb-quick-audio` съобщение + `clipStart`/`clipEnd`/`aspect:"9:16"`),
  `_renderResults` (преглед/редакция), `uploadAll` (цикъл през
  `Step4.uploadVideo` за всеки готов клип).
- **Линкове за стрийминг:** `findLinks()` търси Spotify (официален
  Spotify Web API search, през `NicheToolkit._getSpotifyToken()`) +
  Apple Music (публичен iTunes Search API) за ТЕКУЩАТА песен; DistroKid/
  HyperFollow — през импортирана библиотека (`importDistrokidLibrary()`
  парсва пейстнат списък от DistroKid "My Music", `_findDistrokidLink()`
  прави fuzzy match по заглавие) или fallback генеричен
  `hyperfollow.com/{юзърнейм}` (проверен реално дали резолвва).
  `enrichLibrary()` — bulk версия, минава през ЦЯЛАТА импортирана
  библиотека наведнъж и допълва Spotify+Apple+**YouTube** (YouTube Data
  API `search.list`, ползва `Keys.load().ytApiKey` от Настройки) за
  всяка песен, пази резултата обратно в `cdb_distrokid_library_v1`. AI-ят
  НИКОГА не измисля линкове — описанието се генерира с `{{SPOTIFY_LINK}}`
  токени, `_injectLinks()` ги замества детерминирано (или трие реда,
  ако е празно).
- **Зависимости:** `fileToBase64()`, `callGeminiMultimodal()`,
  `callAI()`, `extractJson()`, `toast()`, `Step4.uploadVideo()`,
  `Step4.accessToken`/`Step4.initGoogleAuth()` (споделен Google вход
  чрез генеричните `.g-auth-status`/`.g-signin-slot` селектори).
- **Не пипа `visualizer.html`-я public API извън добавка** — виж
  следващия раздел.
- **Кой го ползва:** само `index.html` (`view-shorts-studio`).

### `visualizer.html` — разширение за clip режим (v за Shorts Studio)
`cdb-quick-audio` съобщението вече приема по избор `clipStart`/
`clipEnd` (секунди) и `aspect` — ако са зададени, `startExport()`
записва САМО този диапазон от песента (вместо цялата), със заглавие/
плейър видими веднага от началото на диапазона. Без тези полета
поведението е 100% same-as-before (използва се от `QuickUpload`
непроменено).

### `js/stats.js` — `Stats`
YouTube Тракер / Analytics dashboard (data/*.json от GitHub Actions).
- Методи: `saveRepoConfig`, `trendsUrl`, `dataUrl`, `fetchData`,
  `fetchTrendsData`, `renderDashboard`, `renderAnalytics`,
  `renderTopMovers`, `_computeTopMovers`, `renderTrendNiches`,
  `_drawChart`.
- **Зависимости:** `Vault`, `Keys`, `fetchTimeout()`, `toast()`,
  `Nav`, `Chart` (external CDN — cdnjs Chart.js 4.4.4).

### `js/gemini-validator.js` — `GeminiValidator`
"Втори, независим поглед" — автоматичен review на всяка стъпка.
- Методи: `autoReview` (fire-and-forget), `review`, `_log`, `render`.
- **Зависимости:** `callGemini()`, `AppState`.
- Забележка в кода: нарочно НЕ минава през `callAI()` — винаги е
  Gemini, дори когато Gemini е и основният генератор.

### `js/project-archive.js` — `ProjectArchive`
История от предишни песни (auto-архивиране при "Нов проект").
- Методи: `load`, `saveAll`, `saveCurrent`, `loadItem`, `remove`,
  `render`.
- Storage ключ: `ARCHIVE_STORAGE`.
- **Зависимости:** `Storage`, `AppState`, `GeminiValidator`, `Stats`,
  `toast()`.

### `js/system-update.js` — `SystemUpdate` (нов, v1.28.0)
**Read-only** dashboard панел за Auto Update системата (виж
`update_engine.py` + `.github/workflows/auto-update.yml` в root-а —
това НЕ е `js/` модул, а отделна Python/CI система; `system-update.js`
е само UI прозорецът към нея). Чете `README.md` (текуща версия, regex
на `**Версия:**` реда) и `update_report.txt` (последен Auto Update
резултат) през обикновен relative `fetch()` към собствения произход —
**без GitHub API, без token, без auth**. Изрично НЕ commit-ва нищо и
НЕ тригва workflow директно — единственият начин да се стартира update
е потребителят да качи ZIP в `incoming/` през самия GitHub (виж
`incoming/README.md`).
- Методи: `init()` (вика се от `js/nav.js` при отваряне на view
  `set-project`), `refresh()` (бутон "🔄 Провери статус"), `render()`,
  `_fetchVersion()`, `_fetchReport()`, `_escapeHtml()`.
- **Зависимости:** `fetchTimeout()` (`js/network.js`).
- **Кой го ползва:** `js/nav.js` (`showView`), `index.html` (бутон в
  "Настройки — Проект & Данни").

### `js/ai-helpers.js` — `callAI()`, `fileToBase64()`, `extractJson()`
- `callAI(prompt, maxTokens, forceFirst)` — единна точка за AI
  генериране, оркестрира Claude/Gemini/OpenRouter/ModelFinder с
  fallback по ред от `AIProviderOrder`. **v1.27.0:** нов трети,
  по избор параметър `forceFirst` (напр. `"claude"`) — избутва
  конкретен provider на първо място за ТОВА извикване, без да пипа
  запазения ред от `AIProviderOrder`/ръчния избор в Prefs; пълният
  fallback синджир остава непроменен, ако форсираният provider няма
  ключ или гръмне грешка. Ползва се от `Step1.generateLyrics()`, за
  да гарантира Claude като приоритетен генератор на текста на песента
  (естественост на изказа).
- `fileToBase64(file)` — File/Blob → base64 (без data-URI префикс).
- `extractJson(text)` — извлича първия валиден JSON блок от AI текст.
- **Зависимости:** `Keys`, `Prefs`, `AIProviderOrder`, `callClaude()`,
  `callGemini()`, `callOpenRouter()`, `callModelFinder()`, `toast()`.
- **Кой го ползва:** `Step1`, `Step2`, `Step3`, `QuickUpload`,
  `ViralLab` (`callAI`+`extractJson`); `QuickUpload` (`fileToBase64`).

### `js/providers/pollinations-image.js` — `pollinationsImageUrl()`, `pollinationsImageUrlAsync()` (нов, v1.27.0)
Безплатна генерация на изображения (image.pollinations.ai), БЕЗ
никакъв API ключ — отделен provider, но само за ИЗОБРАЖЕНИЯ (не минава
през `callAI()`, който е само за текст).
- `pollinationsImageUrl(prompt, opts)` — синхронно конструира готов
  image URL (endpoint-ът генерира при GET заявка, няма нужда от POST).
- `pollinationsImageUrlAsync(prompt, opts)` — реално сваля байтовете
  и връща `data:` URL, за да хване HTTP/мрежова грешка ПРЕДИ да се
  покаже `<img>` (вместо да разчита на браузърния `onerror`). Автоматичен
  retry до 3 пъти при HTTP 429 (споделен rate limit между всички
  анонимни потребители), с нов случаен seed на всеки опит.
- **Зависимости:** `fetchTimeout()`, `proxied()` (само в async
  варианта).
- **Кой го ползва:** `Step3` (`generateCoverImage`/
  `generateCoverImageFree`, fallback/директен избор пред Gemini/Imagen).

### `js/providers/code-logo.js` — `renderCodeLogo()` (нов, v1.27.1)
100% code-генерирано 3D текстово лого (Canvas 2D — extrusion слоеве +
вертикален градиент + bevel highlight контур + сянка), **БЕЗ AI**.
Трета опция до другите два бутона за обложка — за случаи, в които се
иска ГАРАНТИРАНО точен текст (напр. wordmark лого "CD-B Records"),
което дифузионните AI модели не могат да обещаят надеждно (известно
ограничение на технологията — виж AUDIT_PROGRESS.md, addendum 2 за
v1.27.0).
- `renderCodeLogo(text, opts)` — синхронна, чист browser Canvas API,
  връща `data:image/png` веднага (без мрежова заявка изобщо).
  `opts`: `subtitle`, `baseColor`, `depthColor`, `background`,
  `fontFamily`, `width`, `height`.
- **Зависимости:** само браузърния `document.createElement("canvas")`
  — няма external заявки, няма ключове.
- **Кой го ползва:** `Step3.generateCoverImageCodeLogo()` (нов бутон
  "🔤 Генерирай код-лого", чете `#codeLogoText`/`#codeLogoSubtitle`).

### `js/providers/subtitles.js` — `callGroqTranscribe()`, `segmentsToSrt()` (нов, v1.27.0)
Автоматична транскрипция на аудио → синхронизирани `.srt` субтитри,
през Groq Whisper (`whisper-large-v3-turbo`, безплатен tier, **същия**
`groqKey`, който вече се ползва в `js/providers/model-finder.js`).
- `callGroqTranscribe(audioFile, opts)` — multipart качване към
  `api.groq.com/openai/v1/audio/transcriptions`, `response_format:
  verbose_json` за сегментни timestamp-и; пробва
  `whisper-large-v3-turbo` → `whisper-large-v3` като резерва.
- `segmentsToSrt(segments)` — форматира сегментите в стандартен `.srt`
  текст (с пренасяне на дълги редове на 2 реда за четимост).
- **Зависимости:** `Keys`, `fetchTimeout()`, `proxied()`.
- **Кой го ползва:** `QuickUpload.generateSubtitles()`.

### `js/ui-bootstrap.js` — `restoreUI()`, `updateVaultBanner()`
- `restoreUI()` — хидратира екрана от `AppState` след презареждане
  (F5) — вика `ViralLab.render()` ако има запазен `viralReport`.
- `updateVaultBanner()` — показва/скрива лентата "🔒 Ключовете са
  заключени".
- **Зависимости:** `AppState`, `ViralLab` (за `restoreUI`); `Vault`
  (за `updateVaultBanner`).
- **Кой го ползва:** само `app.js` (вика ги в
  `DOMContentLoaded` листенъра).

### `app.js` (bootstrap, 119 реда)
Само `window.addEventListener("DOMContentLoaded", () => {...})` —
подрежда извикванията на всички модули при зареждане: `Nav.init()`,
`restoreUI()`, `Step3.buildDistrokidFields()`,
`GeminiValidator.render()`, `SystemLog.init()`, `Prefs.init()`,
`Stats.renderDashboard()`, `QuickUpload.initListener()`,
`updateVaultBanner()`, `AgentRoster.maybeShowGate()`, динамично
зареждане на Google Identity Services скрипта →
`Step4.initGoogleAuth()`.
- **Зависимости:** буквално всички модули (то е bootstrap-ът — не е
  необичайно да "знае" за всичко). Не съдържа никаква собствена
  бизнес логика — само реда на извикване.

---

## Модули без пълен изходен код (не са качвани в тази сесия)

Тези файлове съществуват в реалния проект (виждат се в `index.html`
script таговете) и имат pointer коментари в `app.js`, но не съм
чел съдържанието им 1:1 — по-долу е само каквото се подразбира от
коментарите. **Ако ще пипаш някой от тях, качи файла в разговора,
за да мога да работя по него безопасно** — без изходния код не мога
да гарантирам, че промяна другаде няма да го счупи.

| Файл | Namespace(-и) | Каквото се знае от pointer коментари |
|---|---|---|
| `js/app-state.js` | `AppState` (+`STORAGE_KEY`) | Централно състояние на текущия проект (`AppState.data.project`) — ползва се навсякъде. |
| `js/model-pref.js` | `ModelPref` | Кой AI модел е "по подразбиране" за всеки provider. |
| `js/ai-provider-order.js` | `AIProviderOrder` | Ред, в който `callAI()` пробва Claude/Gemini/OpenRouter. |
| `js/ai-call-log.js` | `AICallLog` (+`AI_CALL_LOG_KEY`/`AI_CALL_LOG_MAX`) | Лог на AI извиквания. |
| `js/quota-tracker.js` | `QuotaTracker` (+`QUOTA_TRACKER_KEY`) | Следене на AI квоти. |
| `js/ai-cache.js` | `AICache` (+`AI_CACHE_KEY`/`AI_CACHE_MAX_ENTRIES`/`_simpleHash`) | Кеш на AI отговори. |
| `js/nav.js` | `Nav` | Sidebar router / mobile navigation. Ползва се от `Stats`. |
| `js/settings.js` | `Settings` | Vault/AuthGate/ключове UI, export/import, "Нов проект". |
| `js/prefs.js` | `Prefs` (+`PREFS_STORAGE`) | Потребителски предпочитания (напр. предпочитан AI provider). |
| `js/providers/claude.js` | — | `callClaude()`. |
| `js/providers/gemini.js` | — | `callGemini()`, `callGeminiMultimodal()`. |
| `js/providers/openrouter.js` | — | OpenRouter provider логика. |
| `js/providers/model-finder.js` | `ModelFinder`, `callModelFinder()` | Реален 4-ти AI provider (Groq/Mistral/GitHub Models/Cloudflare/Pollinations) + информационен панел за `ai-model-finder/ai-models.json`. **2026-08-10:** панелът вече показва ✅/⚠️ `verified` badge на всеки модел (виж запис в `AUDIT_PROGRESS.md`). |
| `js/providers/fallback-loop.js` | — | Fallback логика между провайдъри. |
| `js/network.js` | — | `fetchTimeout()`, `proxied()`. |
| `js/youtube.js` | — | `fetchRecentTrendingVideos()`, `youtubeTopTitles()`, `youtubeOutlierScan()`, `keywordSuggest()`. |
| `js/system-log.js` | — | Системен лог. |
| `js/system-test.js` | `SystemTest` | Диагностика/self-test. |
| `js/auth-gate.js` | `AuthGate` | Login gate преди достъп до dashboard-а. |
| `js/niche-scoring.js` | `NicheScoring` | **2026-08-10:** чист, детерминистичен scoring модул (без fetch/DOM) — 5 под-индекса (Demand/Momentum/Opportunity-HHI/Monetization/Feasibility), централни тегла, insufficient-data логика. Тествано в `test/niche-scoring.test.mjs` (27 теста). Ползва се от `NicheToolkit.analyzeNicheExtended()`. |
| `js/niche-data-sources.js` | `NicheDataSources` | **2026-08-10:** безключови допълнителни сигнали — Deezer, iTunes Search API, MusicBrainz, YouTube RSS. Никога не хвърля грешка нагоре (връща `{available:false,error}`). Ползва се от `NicheToolkit.analyzeNicheExtended()`. |
| `js/niche-toolkit.js` | `NicheToolkit` (+`NICHE_TOOLKIT_SCORES_KEY`) | Ползва се от `Step1`. **2026-08-10:** нов `analyzeNicheExtended()` — допълнителен 5-под-индекс панел върху `NicheScoring`/`NicheDataSources`, не заменя стария `analyzeNiche()`. |
| `js/agent-roster.js` | `AgentRoster` | "Работещи AI агенти днес" проверка. |
| `js/release-roadmap.js` | — | Roadmap функционалност. |
| `js/ui/toast.js` | — | `toast()`. |
| `js/ui/guard-click.js` | — | `guardClick()` — debounce/guard за бутони. |
| `scripts/clock-and-keys.js` | — | Извън `js/`, вероятно clock widget + keys helper. |

---

## Ред на зареждане (текущ `index.html`)

Всички зависимости между модулите са **runtime** (вътре в методи, не
на топ ниво), затова редът на `<script>` таговете технически не е
критичен за коректност — но е поддържан логически: базови модули
най-отпред, feature-модули по-назад, `app.js` последен преди
auth/niche/roadmap добавките.

```
js/storage.js              ← най-отпред, всичко зависи от него
js/ai-helpers.js
js/ui/toast.js
js/system-test.js
js/ui/guard-click.js
js/network.js
js/agent-roster.js
js/providers/fallback-loop.js
js/providers/claude.js
js/providers/gemini.js
js/providers/openrouter.js
js/providers/model-finder.js
js/youtube.js
js/system-log.js
js/app-state.js
js/ai-cache.js
js/quota-tracker.js
js/prefs.js
js/model-pref.js
js/ai-provider-order.js
js/ai-call-log.js
js/nav.js
js/settings.js
js/stats.js
js/gemini-validator.js
js/project-archive.js
js/quick-upload.js
js/track-record.js
js/lyrics-history.js
js/step2.js
js/step4.js
js/step3.js
js/viral-lab.js
js/step1.js
js/ui-bootstrap.js
app.js                     ← bootstrap-ът, последно преди долните 3
js/auth-gate.js
js/niche-toolkit.js
js/release-roadmap.js
scripts/clock-and-keys.js
```

---

## Правила за бъдеща работа (за да не се чупи нищо)

1. **Нов feature = нов файл, собствен namespace.** Не добавяй нов
   код в `app.js` — то е запазено само за истинско споделено ядро
   (AI оркестрация, restore UI и т.н.).
2. **Всеки нов/променен файл → 3 задължителни стъпки:**
   - добави/провери `<script src="js/....js">` в `index.html`;
   - добави пътя в `SHELL_FILES` в `sw.js`;
   - вдигни `CACHE_VERSION` в `sw.js` с 1.
3. **Header коментар във всеки модул** — списък със зависимости
   (кои други namespace-и/функции ползва) и кой го ползва отвън, по
   образеца на файловете по-горе. Това е това, което прави картата в
   този документ поддържаема — при промяна на зависимостите, обнови
   и коментара, и този файл.
4. **Никога не сменяй публичен метод (име/аргументи/връщан формат)
   без да провериш "Кой го ползва"** в таблицата по-горе — иначе
   чупиш другия модул тихо, без синтактична грешка.
5. **Преди всеки push/deploy:**
   ```bash
   node --check app.js
   node --check js/<всеки-променен-файл>.js
   npm test
   ```
   Очакван резултат: `# tests 40` / `# pass 40` / `# fail 0`.
6. **Тестовете покриват само `network.js` и `Storage`/`Keys`/
   `Vault`** (`js/storage.js`). Ако пипаш точно тях — `npm test` е
   особено важен, не формалност. За всичко останало разчитай на
   ръчна проверка в браузъра (виж чеклиста в последния
   `INSTALL_STEPS_*.md`).
7. **Ако задачата засяга модул от таблицата "без пълен изходен
   код"** — качи го в разговора първо. Работа по него "на сляпо",
   само по описанието тук, носи риск от счупване, защото описанието
   е по памет от pointer коментари, не от прочетен код.

---

## GitHub Actions workflows (`.github/workflows/`)

| Файл | Какво прави | Кога |
|---|---|---|
| `daily-stats.yml` | `scripts/track_stats.py` — статистика на твоя YouTube канал → `data/stats-history.json` | нощно + ръчно |
| `daily-trends.yml` | `scripts/track_trends.py` — growth/competition по ниши от `config.json` → `data/trends-history.json` | 08:00 UTC + ръчно |
| `run-tests.yml` | `npm test` при всеки push/PR | push/PR |
| `scrape-ai-models.yml` | `ai-model-finder/scraper.mjs` → `ai-model-finder/ai-models.json` — **добавен на 2026-08-10** (липсваше изцяло, виж `AUDIT_PROGRESS.md`) | 03:00 UTC + ръчно |
| `auto-update.yml` | `update_engine.py` (root) — ZIP от `incoming/*.zip` → SHA256 diff → backup → apply → критични файлове → secret scan → `npm test` → commit **само при 100% успех**, иначе автоматичен rollback. **Добавен на 2026-08-12, v1.28.0** — виж `README.md` Changelog и `incoming/README.md` за пълния flow. `visualizer.html` изрично защитен/недосегаем от този flow. | push на `incoming/*.zip` + ръчно (`workflow_dispatch`) |

---

## Известен технически дълг (не е поправен, само отбелязан)

- В `app.js`, около мястото откъдето беше извадено `TrackRecord`, стои
  "осиротял" коментарен блок за `STATS` (без код след него — `Stats`
  вече е другаде, с отделен коректен pointer коментар). Изглежда
  като remnant от по-стара сесия. Безопасен е (само коментар, не
  чупи нищо), но е за почистване при удобен случай.
