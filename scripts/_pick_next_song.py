#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_pick_next_song.py — за CRON режима на render-pro-short.yml (виж коментара
"КАК СЕ ТРИГВА" там). Когато workflow-ът се стартира по график (не ръчно от
таблото), няма подадени inputs — този скрипт избира АВТОМАТИЧНО следващата
песен от data/distrokid-library.json, която още няма генериран Short
(няма "shorts" ключ или е празен списък), по реда, в който се появява във
файла (round-robin по подразбиране, без нужда от отделен курсор-файл —
веднъж генериран Short, песента вече не е "следваща").

cover_url ГО НЯМАМЕ директно в distrokid-library.json (само previewAudio +
платформени линкове) — извличаме обложка чрез публичния iTunes Lookup API
(entry["appleUrl"], вече е lookup URL) и upgrade-ваме резолюцията чрез
стандартния трик '100x100bb' → '1200x1200bb' в artworkUrl100.

Пише резултата директно в $GITHUB_OUTPUT (audio_url/song_title/artist_name/
cover_url/found=true|false) — workflow стъпката го подава на render стъпката.
Ако няма нито една подходяща песен, или обложка не може да се извлече,
found=false и workflow стъпката прескача рендирането БЕЗ да гърми run-а
(няма смисъл целият cron job да е "failed", просто няма какво да се прави
този път).
"""

import json
import os
import sys

import requests

LIBRARY_JSON = os.path.join("data", "distrokid-library.json")


def pick_cover_url(apple_lookup_url: str) -> str:
    r = requests.get(apple_lookup_url, timeout=20)
    r.raise_for_status()
    data = r.json()
    results = data.get("results") or []
    if not results:
        raise ValueError("iTunes lookup не върна резултати")
    art = results[0].get("artworkUrl100") or ""
    if not art:
        raise ValueError("iTunes резултатът няма artworkUrl100")
    return art.replace("100x100bb", "1200x1200bb")


def main() -> int:
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if not gh_output:
        print("::error::GITHUB_OUTPUT не е зададен — очаквам да съм викнат от Actions", file=sys.stderr)
        return 1

    def emit(**kv):
        with open(gh_output, "a", encoding="utf-8") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")

    if not os.path.isfile(LIBRARY_JSON):
        print(f"::warning::{LIBRARY_JSON} липсва", file=sys.stderr)
        emit(found="false")
        return 0

    with open(LIBRARY_JSON, encoding="utf-8") as f:
        lib = json.load(f)

    for entry in lib:
        if entry.get("shorts"):
            continue
        audio_url = entry.get("previewAudio") or (entry.get("platforms") or {}).get("audioPreview")
        apple_url = entry.get("appleUrl") or (entry.get("platforms") or {}).get("apple")
        if not audio_url or not apple_url:
            continue  # нямаме нужните данни за тази песен — пробвай следващата
        try:
            cover_url = pick_cover_url(apple_url)
        except Exception as e:  # noqa: BLE001
            print(f"::warning::обложка за {entry.get('song')!r} се провали: {e} — пробвам следваща песен", file=sys.stderr)
            continue

        emit(
            found="true",
            audio_url=audio_url,
            cover_url=cover_url,
            song_title=entry.get("song", ""),
            artist_name=entry.get("artist", ""),
        )
        print(f"✓ избрана песен: {entry.get('artist')} — {entry.get('song')}", file=sys.stderr)
        return 0

    print("ℹ всички песни вече си имат Shorts (или няма нужните данни) — нищо за рендиране", file=sys.stderr)
    emit(found="false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
