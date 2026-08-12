# incoming/ — къде отива update ZIP-ът

Тази папка е "пощенската кутия" на Auto Update системата.

## Как да пуснеш update

1. Изтегли ZIP-а, който Claude ти е дал.
2. Отиди в repo-то на github.com (не приложението, самия уеб сайт).
3. Влез в тази папка (`incoming/`).
4. **Add file → Upload files.**
5. Пусни ZIP-а и го преименувай на `update.zip` (ако вече не се казва така).
6. **Commit directly to the main branch.**

Веднага след commit-а, GitHub Action-ът (`.github/workflows/auto-update.yml`)
се пуска автоматично:

```
твоят commit (ZIP в incoming/)
        ↓
GitHub Action се тригва
        ↓
update_engine.py:
  разархивира → сравнява със сегашния repo → backup на променените файлове
  → прилага промените → проверява критични файлове → сканира за случайно
  качени API ключове → пуска npm test
        ↓
   ВСИЧКО чисто?              НЕЩО гръмна?
        │                          │
        ▼                          ▼
   git commit                  rollback (нищо
   (промените влизат            не се качва,
    в repo-то)                  repo-то остава
                                 непроменено)
        ↓                          ↓
incoming/update.zip се трие в двата случая (обработен е)
update_report.txt се commit-ва в двата случая (виждаш резултата
в dashboard-а → Настройки → Проект & Данни → "🔄 Auto Update")
```

## Важно

- **НЕ качвай `visualizer.html`** в ZIP-а, освен ако изрично не искаш да
  го обновиш — той тежи 18MB и не е част от обичайния Auto Update flow
  (виж бележката в `update_engine.py`, в началото на файла).
- Ако update-ът се провали (тестове/секрет/липсващ критичен файл), **нищо
  не се чупи** — engine-ът прави автоматичен rollback ПРЕДИ commit, репото
  остава точно както е било.
- Тази папка не трябва да съдържа нищо друго освен `update.zip` (и този
  README) — `.gitkeep` пази папката видима в git, докато е празна.
