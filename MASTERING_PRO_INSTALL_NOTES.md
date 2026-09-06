# Mastering Pro — инсталация през `incoming/` (актуализирано)

Този ZIP е стъкмен специално да мине през твоя СЪЩЕСТВУВАЩ
`auto-update.yml` / `update_engine.py` flow — просто го качваш в
`incoming/update.zip` през GitHub уеб интерфейса ("Add file → Upload
files"), commit-ваш директно в main, и workflow-ът сам:

- прилага `scripts/master_engine.py`, `scripts/cleanup_mastering_jobs.py`,
  `scripts/requirements-mastering.txt`, `js/mastering-pro.js` (нови файлове)
- прилага обновения `index.html` (панелът "🎛️ Pro Мастеринг" вече е вътре,
  плюс `<script src="js/mastering-pro.js">` тагът — engine-ът ще го засече
  през SHA256 diff-а като обновен `index.html`, нормален update)
- създава `mastering-jobs/.gitkeep` (празна папка, готова за job-овете)
- пуска `npm test` + secret scan + критични файлове проверка, и само при
  100% успех прави commit — иначе автоматичен rollback, нищо не се чупи.

## ⚠️ ЕДНО НЕЩО НЕ МОЖЕ да мине автоматично: workflow файловете

`update_engine.py` изрично НИКОГА не пипа `.github/workflows/*`
(виж коментара в самия код — "workflow файловете се управляват ръчно",
умишлено за сигурност). Затова тези 2 файла трябва да ги качиш РЪЧНО,
директно през GitHub уеб интерфейса:

1. Иди в repo-то си на github.com → `.github/workflows/` → **Add file → Create new file**
2. Име: `mastering-pro.yml` → постави съдържанието от приложения `mastering-pro.yml` (в оригиналния `mastering-pro-addon.zip`, папка `.github/workflows/`)
3. Commit directly to main
4. Повтори за `mastering-pro-cleanup.yml`

Без тези 2 файла panel-ът ще се появи в сайта, но бутонът "Обработи (Pro)"
ще гърми с "GitHub 404" при dispatch-ване, защото workflow-ът просто няма
да съществува все още.

## GitHub Token правата (Настройки → API Ключове)

Токенът (`Keys.load().ghToken`) трябва да има:
- **Contents**: Read and write
- **Actions**: Read and write

## Известни ограничения

- **Входни файлове** (target.wav/reference.wav): лимит **~1800MB на файл**
  (виж `MASTERING_PRO_MAX_FILE_MB` в `js/mastering-pro.js`) — качват се
  като GitHub Release assets (Releases API, до 2GB твърд таван), а НЕ
  като git blob-ове, така че НЕ се трупат в git историята за постоянно —
  трият се автоматично (виж `scripts/cleanup_mastering_jobs.py`).
- **Изходен файл** (result.wav): продължава да се commit-ва в git
  (~100MB практически таван на файл) — единствената причина е, че
  release asset-ите НЕ поддържат CORS за browser fetch (виж подробния
  коментар в `.github/workflows/mastering-pro.yml` и в `js/mastering-pro.js`),
  а git/Contents API (`raw.githubusercontent.com`) поддържа. 100MB ≈ ~8-9
  минути 16-bit/44.1kHz стерео — напълно достатъчно за единичен трак.
- `mastering-jobs/` git папката (result.wav + status.json) и осиротелите
  `mastering-job-*` release-и се чистят на всеки 12ч.
- Никакви GitHub Secrets не са нужни — `matchering` е чисто локална
  Python библиотека, никакви външни API извиквания.
