# Kinetic Video — видео от снимки + текст + музика, без приложения

1. В `kinetic-jobs/` направи папка (напр. `demo`) и качи в нея: `scenario.json`, снимките, едно аудио (mp3/wav).
2. GitHub → Actions → **Kinetic Video** → Run workflow → job = `demo`.
3. След 2-5 мин: Releases → свали `demo.mp4`.

Сцените се режат на бийтовете на музиката; всяка има 1-3 думи, снимката е фон.
Ефекти: slam, glitch, stretch, zoom, slide. Стилове: slam_red, glitch, stretch, zoom_punch, clean.
Сцена без `image` = плътен цвят. Пример: `kinetic-jobs/_example/scenario.json`.

## Промпт за AI агентите
„Напиши scenario.json за кратко видео на тема X. Формат: {style, scenes:[{text, image, effect}]}.
Всяка сцена: 1-3 думи, главни букви, силни и кратки. 8-14 сцени. image = 1.jpg, 2.jpg... по ред.
За всяка сцена дай и промпт за снимка (вертикална 9:16, без текст в кадъра, тъмна, контрастна)."
