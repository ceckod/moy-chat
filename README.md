# CD-B Records — Control Dashboard

Единен HTML файл (SPA), който управлява целия музикален процес в 4 стъпки.
Работи изцяло в браузъра — без Python бекенд, без сървър. Всички ключове
и данни се пазят локално на устройството (localStorage).

## Файлове
- `index.html` — цялата структура и стилове
- `app.js` — цялата логика (API извиквания, чеклист, навигация)
- `manifest.json` — за да можеш да добавиш иконата на телефона си
- `assets/icon-192.png`, `assets/icon-512.png` — **трябва да ги добавиш сам**
  (лого на CD-B Records в квадратен формат, PNG, прозрачен фон)

## Как да го качиш в GitHub Pages

1. Създай нов repo в GitHub (може да е публичен — няма тайни ключове в кода).
2. Качи `index.html`, `app.js`, `manifest.json` и папка `assets/` с иконите.
3. Отиди в **Settings → Pages** на repo-то → избери branch `main` → Save.
4. След 1-2 минути сайтът ти ще е достъпен на:
   `https://<твоя-username>.github.io/<repo-name>/`

## Как да го сложиш като икона на телефона

**Android (Chrome):** Отвори линка → меню (⋮) → "Add to Home screen".
**iPhone (Safari):** Отвори линка → бутон Share → "Add to Home Screen".

## Първо стартиране — API ключове

Отвори приложението → бутон **⚙️ API Ключове / Настройки** горе-долу вляво →
въведи:
- **Anthropic (Claude) API Key** — от console.anthropic.com
- **Google Gemini API Key** — от aistudio.google.com
- **Google Client ID (OAuth)** — от Google Cloud Console (за YouTube upload).
  Трябва да разрешиш "YouTube Data API v3" в проекта си и да добавиш
  твоя GitHub Pages домейн в "Authorized JavaScript origins".

Всичко се пази само в браузъра ти — нищо не се качва в GitHub repo-то.

## Известни ограничения / TODO

- **Стъпка 2 (Визуализатор):** Мястото е подготвено в `index.html`
  (секция `panel-2`) и в `app.js` (обект `Step2`). Твоят съществуващ
  визуализатор (видео1 + видео2 + лого) трябва да се вгради тук —
  прати кода му (без самите видео файлове) за интеграция.
- **Стъпка 3 (DistroKid):** Реализирано като *auto-fill асистент* —
  генерира текстовете, но не автоматизира самия DistroKid сайт
  (браузърът не може да управлява друг сайт по security причини).
- **Обложка (Imagen):** Ако директното извикване от браузъра върне
  CORS грешка, ще трябва малък безплатен proxy (напр. Cloudflare
  Worker) само за тази функция.
- **Google/YouTube Trends за Стъпка 1:** В момента Score-ът се генерира
  чрез Claude на база общи познания за жанра. За реални данни може да
  се добави YouTube Data API `search.list` заявка по-късно.
