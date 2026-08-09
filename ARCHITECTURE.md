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
  `generateSpotifyAppleText`, `buildDistrokidFields`, `copyField`,
  `_copySA`, `generateABTitles`, `checkSimilarity`,
  `generateShortFormScripts`, `_copyShortForm`, `_useTitle`.
- **Зависимости:** `AppState`, `Keys`, `callAI()`, `callGemini()`,
  `extractJson()`, `fetchTimeout()`, `proxied()`, `GeminiValidator`,
  `toast()`.

### `js/step4.js` — `Step4`
YouTube публикуване (unlisted).
- Методи: `initGoogleAuth`, `uploadVideo`.
- Свойства: `tokenClient`, `accessToken`.
- **Зависимости:** `Keys`, `AppState`, `QuickUpload`, `toast()`.

### `js/quick-upload.js` — `QuickUpload`
"⚡ Бърз ъплоуд за стари песни" — прескача концепция/обложка.
- Методи: `initListener`, `onAudioSelected`, `_pastedLyrics`,
  `_sendAudioToVisualizer`, `_checkBothReady`, `_runAnalysisAndMeta`,
  `_fillResultFields`, `autoUpload`, `manualUpload`, `runFull`,
  `_setRunning`, `_setVideoProgress`, `log`.
- Свойства: `audioFile`, `videoBlob`, `videoFileName`.
- **Зависимости:** `callAI()`, `callGeminiMultimodal()`, `toast()`.

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

### `js/ai-helpers.js` — `callAI()`, `fileToBase64()`, `extractJson()`
- `callAI(prompt, maxTokens)` — единна точка за AI генериране,
  оркестрира Claude/Gemini/OpenRouter/ModelFinder с fallback по ред
  от `AIProviderOrder`.
- `fileToBase64(file)` — File/Blob → base64 (без data-URI префикс).
- `extractJson(text)` — извлича първия валиден JSON блок от AI текст.
- **Зависимости:** `Keys`, `Prefs`, `AIProviderOrder`, `callClaude()`,
  `callGemini()`, `callOpenRouter()`, `callModelFinder()`, `toast()`.
- **Кой го ползва:** `Step1`, `Step2`, `Step3`, `QuickUpload`,
  `ViralLab` (`callAI`+`extractJson`); `QuickUpload` (`fileToBase64`).

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
| `js/providers/model-finder.js` | `ModelFinder` | Динамичен списък AI модели. |
| `js/providers/fallback-loop.js` | — | Fallback логика между провайдъри. |
| `js/network.js` | — | `fetchTimeout()`, `proxied()`. |
| `js/youtube.js` | — | `fetchRecentTrendingVideos()`, `youtubeTopTitles()`, `youtubeOutlierScan()`, `keywordSuggest()`. |
| `js/system-log.js` | — | Системен лог. |
| `js/system-test.js` | `SystemTest` | Диагностика/self-test. |
| `js/auth-gate.js` | `AuthGate` | Login gate преди достъп до dashboard-а. |
| `js/niche-toolkit.js` | `NicheToolkit` (+`NICHE_TOOLKIT_SCORES_KEY`) | Ползва се от `Step1`. |
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

## Известен технически дълг (не е поправен, само отбелязан)

- В `app.js`, около мястото откъдето беше извадено `TrackRecord`, стои
  "осиротял" коментарен блок за `STATS` (без код след него — `Stats`
  вече е другаде, с отделен коректен pointer коментар). Изглежда
  като remnant от по-стара сесия. Безопасен е (само коментар, не
  чупи нищо), но е за почистване при удобен случай.
