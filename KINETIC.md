# Kinetic Видео (раздел в сайта)

Сайт → 🎬 Kinetic Видео → 1) напиши идея и питай агентите (те пишат думите, ефектите и промптовете за снимките) → 2) песен → 3) качи снимките по ред → Генерирай.
Сайтът качва файловете в GitHub Release, пуска workflow `kinetic-video.yml` и показва видеото, когато е готово.

Еднократно: качи `kinetic-video.yml` ръчно в `.github/workflows/` (auto-update не пипа тази папка).
Нужен е GitHub токен в Настройки → API Ключове (като за Mastering Pro; с права за repo + Actions).

JSON за агентите: {"style":"slam_red","scenes":[{"text":"NEW OPUS"},{"text":"ARE YOU KIDDING","effect":"glitch"}]}
Ефекти: slam, glitch, stretch, zoom, slide. Стилове: slam_red, glitch, stretch, zoom_punch, clean.
Старите job Releases (kinetic-job-*) могат да се трият от GitHub → Releases.
