# Карта на модулите — AI Music Suite / CD-B Records Dashboard

Цел: когато работим по конкретна функционалност, да знаем **точно** кои
файлове са в обхвата и кои НЕ трябва да се пипат. Всеки модул по-долу е
самостоятелна, разпознаваема отговорност — но виж "Кръстосани
зависимости" накрая, защото няколко модула НЕ са напълно изолирани.

---

## 0. System Core — фундамент, никога не се пипа изолирано за "малка" задача

Ако задачата пипа нещо тук, третирай я като high-risk, независимо колко
малка изглежда промяната (виж одита, Раздел 3 "Критични файлове").

```
index.html
app.js
js/storage.js
js/network.js
js/app-state.js
js/nav.js
js/ui-bootstrap.js
js/ui/toast.js
js/ui/guard-click.js
manifest.json
config.json
sw.js
package.json
```

## 1. Settings & Preferences

```
js/settings.js
js/auth-gate.js
js/prefs.js
js/model-pref.js
js/ai-provider-order.js
```

## 2. AI Core — оркестрация + provider-и

Използва се от почти всеки друг модул (виж "Кръстосани зависимости").

```
js/ai-helpers.js
js/ai-cache.js
js/ai-call-log.js
js/quota-tracker.js
js/agent-roster.js
js/gemini-validator.js
js/providers/claude.js
js/providers/gemini.js
js/providers/openrouter.js
js/providers/fallback-loop.js
js/providers/model-finder.js
js/providers/pollinations-image.js
js/providers/code-logo.js
js/providers/subtitles.js
```

## 2b. Project Dashboard — aggregation layer (добавен 2026-08-16, P0 от Phase-0 audit)

```
js/dashboard.js
```
Чете AppState/ProjectArchive/TrackRecord/QuotaTracker, извежда derived
"текущ проект / etap / next action" в `#projectNextAction` (view
`dashboard`, най-отгоре, преди "Бърз ъплоуд"). Не въвежда нов storage
key, не мести данни. Вика се от `Nav.showView("dashboard")` редом до
съществуващия `Stats.renderDashboard()` (различна отговорност — YouTube
channel stats, не се пипа).

## 3. Song Creation Flow — Стъпки 1-4 + Бърз ъплоуд

```
js/step1.js
js/step2.js
js/step3.js
js/step4.js
js/lyrics-history.js
js/quick-upload.js
js/youtube.js
js/release-roadmap.js
```

## 4. Viral Lab & Niche Analysis

```
js/viral-lab.js
js/niche-toolkit.js
js/niche-scoring.js
js/niche-data-sources.js
```

## 5. Archive & Stats

```
js/project-archive.js
js/track-record.js
js/stats.js
```

## 6. Diagnostics

```
js/system-log.js
js/system-test.js
```

## 7. Visualizer Engine — ИЗРИЧНО ИЗВЪН Auto Update flow-а

```
visualizer.html
```
По конвенция (виж `incoming/README.md`, `update_engine.py` коментар) —
не се пипа/качва освен ако изрично не поискаш точно него. 18MB, само
~65KB от които е реален код (виж одита, Раздел 21).

## 8. Automation & Data — GitHub Actions + Python (НЕ browser код)

```
scripts/track_stats.py
scripts/track_trends.py
scripts/track_niche_scores.py
scripts/discover_niches.py
scripts/clock-and-keys.js
.github/workflows/daily-stats.yml
.github/workflows/daily-trends.yml
.github/workflows/niche-scores.yml
.github/workflows/scrape-ai-models.yml
.github/workflows/run-tests.yml
data/*.json   ← ГЕНЕРИРАНИ от скриптовете, не се редактират ръчно
```

## 9. AI Model Finder — самостоятелен под-проект

```
ai-model-finder/*
```
Не се дели с главния `js/` — има собствен `app.js`, собствена логика.

## 9b. Suno Audio Preview Player — самостоятелен инструмент (добавен 2026-08-13)

```
js/suno-preview.js
```
Изолиран — само собствен localStorage ключ (`cdb_suno_preview_history_v1`)
+ Storage/toast от System Core. Не чете/пише `AppState.data.project`,
не е обвързан с текущата песен. UI markup: `index.html`, view
`#view-suno-preview` (секция "Инструменти" в nav-а).

## 10. Auto Update / Infra — обновяващата система сама по себе си

```
update_engine.py
.github/workflows/auto-update.yml
incoming/README.md
js/system-update.js
```

## 11. Тестове

```
test/*.test.mjs
vault-keys.test.mjs
```
Не е "модул" в смисъла по-горе — покрива части от няколко модула
наведнъж (Storage, providers/fallback-loop, niche-scoring, network).

## 12. Мъртъв код — вече почистен (2026-08-13)

Списъкът по-долу вече НЕ съществува в repo-то — изтрит на 2026-08-13.
Оставен тук като история + за да знае `scripts/cleanup_dead_files.py`
какво да пази проверявано, ако някога стар ZIP/backup внесе същите
файлове отново.

```
22-та root-ниво дубликата на js/*.js (бивш одит, Раздел 6)
ai.html, aichat.html, site-ai.html, site-ai-agent.html
load-app.mjs (дубликат на helpers/load-app.mjs)
app-state.test.mjs (root, дубликат на test/app-state.test.mjs)
CDB-Dashboard.md (дубликат на "Технически-одит-CDB-Dashboard.md")
```

Автоматично почистване занапред: `python3 scripts/cleanup_dead_files.py --apply`
(dry run по подразбиране без `--apply`) — виж коментарите в самия файл.

---

## 13. YouTube Discovery Engine — auto playlist discovery (добавен 2026-08-13)

```
js/youtube-discovery.js
scripts/_youtube_common.py
scripts/_secret_scan.py
scripts/catalog_bootstrap.py
scripts/youtube_discovery_engine.py
scripts/youtube_oauth_bootstrap.py      ← пуска се РЪЧНО ЛОКАЛНО, никога в Actions
.github/workflows/youtube-discovery.yml
data/catalog.json
data/discovery-config.json
data/playlists-state.json
data/discovery-log.json
data/track-performance.json
data/discovery-candidates-cache.json
```

Следва същия dual-layer модел като модул 8 (Automation & Data): реалната
работа (клъстериране, YouTube playlist writes, discovery на нова музика)
е в Python + GitHub Actions; `js/youtube-discovery.js` само чете
резултатните `data/*.json` файлове (raw.githubusercontent, като
`Stats.dataUrl()`) и тригва workflow-а ръчно през GitHub Actions API
(workflow_dispatch), ползвайки съществуващия `ghToken` (Keys).

**Важно за playlist WRITE операции**: API key (YOUTUBE_API_KEY) НЕ е
достатъчен — `playlists.insert`/`playlistItems.insert/delete` изискват
OAuth access token. Без GitHub Secrets `YOUTUBE_OAUTH_CLIENT_ID/SECRET/
REFRESH_TOKEN` (еднократен setup, виж `scripts/youtube_oauth_bootstrap.py`
+ README.md), engine-ът автоматично пада в read-only режим (анализира и
логва, но не пише) — не гърми.

**Concurrency**: защитата срещу два едновременни daily run-а е през
GitHub Actions `concurrency:` group в workflow-а (атомарен, нативен
механизъм), НЕ git-committed lock файл (обмислено и отхвърлено съзнателно
— виж докстринга в `youtube_discovery_engine.py` защо файлов lock би имал
race condition точно в сценария, който трябва да предотврати).

**Persistent candidate cache** (`data/discovery-candidates-cache.json`,
TTL-базиран) пести YouTube `search.list` (100 units/call) — прави се
search само когато pool-ът от неизползвани кандидати е малък/остарял, не
всеки daily run за всеки playlist.

**Manual overrides** (т.34): всеки playlist entry в `playlists-state.json`
поддържа `locked`/`disabled`/`excluded_video_ids`/`forced_video_ids`/
`self_track_ratio_override`/`max_playlist_size_override` — engine-ът ги
чете и уважава, никога не ги презаписва сам. Управляват се от Dashboard-а.

Кръстосани зависимости: чете `data/stats-history.json` (модул 8, писан от
`scripts/track_stats.py`) за каталог bootstrap и performance данни. Не
пипа/не се пипа от `js/youtube.js` (модул 3, trending/outlier — различна
отговорност, само служи като референтен модел за trending логиката).

## Кръстосани зависимости (важно — модулите НЕ са напълно изолирани)

- **AI Core (2)** се вика от почти всеки друг модул (`Song Creation`,
  `Viral Lab`, `Niche Analysis`, дори `Settings` за тестване на
  ключове). Промяна в `callAI()` сигнатурата или provider поведението
  засяга ВСИЧКИ тях — дори задачата да изглежда "само AI Core".
- **System Core (0)** се чете директно от буквално всеки модул
  (`Storage`, `AppState`, `fetchTimeout`/`proxied`). Никой модул не е
  реално изолиран от него.
- **`index.html`** съдържа markup за ВСИЧКИ модули наведнъж (единен SPA
  файл) — промяна "само в AI Core" пак може да изисква редакция на
  съответната секция в `index.html`, ако добавяш/махаш UI елемент.
- **Settings (1) ↔ почти всичко** — `Settings.fillFields()` и
  свързаните методи четат/пишат ключове, ползвани от AI Core, YouTube,
  Niche анализа и т.н.

**Практическо правило:** преди да пипаме "само модул X", проверявам
дали промяната засяга публичния интерфейс (методи, извиквани отвън) на
X — ако да, трябва grep за всички викащи го модули, не само тези в
списъка на X.

---

## Как ще ползваме тази карта

1. Кажи ми кой модул (или комбинация) искаш да пипнем.
2. Аз чета **само** файловете от съответния списък (+ проверка за
   кръстосани зависимости по-горе) — през публичния repo, директно.
3. Правя минималната необходима промяна, обяснявам засегнатото.
4. Връщам малък `update.zip` за `incoming/` — само с реално
   променените файлове (Auto Update flow-ът пази всичко останало
   недокоснато, `REMOVE_MISSING_FILES=False`).
