#!/usr/bin/env python3
"""
fetch_distrokid_links.py — точна версия с последване на пренасочванията
========================================================================
Използва Playwright, за да извлече КРАЙНИТЕ реални URL адреси на платформите,
избягвайки счупените проследяващи линкове на DistroKid.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import load_json, save_json  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / "data" / "distrokid-library.json"

CORE_PLATFORMS = ("spotify", "apple", "youtube")


def clean_url(url: str) -> str:
    """Изчиства проследяващи параметри от линка."""
    if not url:
        return ""
    # Премахваме DistroKid tracking параметри
    url = re.sub(r'([\?&])(uo|app|ls|at|ct|pt)=[^&]*', '', url)
    return url.rstrip('?&')


async def main_async() -> None:
    if not DATA_PATH.exists():
        print("⚪ data/distrokid-library.json липсва — първо запази библиотеката от dashboard-а.")
        return

    library = load_json(DATA_PATH, [])
    if not library:
        print("⚪ Библиотеката е празна.")
        return

    total = len(library)
    changed = 0
    skipped = 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        for i, entry in enumerate(library, 1):
            platforms = entry.setdefault("platforms", {})
            title = entry.get("song") or "?"

            if all(platforms.get(p) for p in CORE_PLATFORMS):
                skipped += 1
                print(f"[{i}/{total}] ⏭️  {title} — вече готова, пропускам.")
                continue

            url = entry.get("url")
            if not url:
                continue

            print(f"[{i}/{total}] 🔎 {title} ...")
            try:
                await page.goto(url, wait_until="networkidle", timeout=30000)
                await page.wait_for_timeout(2000)

                # Селектираме всички a елементи на страницата
                anchors = await page.query_selector_all('a[href]')
                found = {}

                for a in anchors:
                    href = await a.get_attribute('href')
                    text = (await a.inner_text()).lower()

                    if not href:
                        continue

                    # Проверка за Spotify
                    if 'spotify.com' in href:
                        found['spotify'] = clean_url(href)

                    # Проверка за Apple Music (филтрираме itunes.apple.com линкове, които свалят файл)
                    elif 'music.apple.com' in href:
                        found['apple'] = clean_url(href)

                    # Проверка за YouTube
                    elif 'youtube.com' in href or 'youtu.be' in href:
                        found['youtube'] = clean_url(href)

                    # Deezer
                    elif 'deezer.com' in href:
                        found['deezer'] = clean_url(href)

                    # Tidal
                    elif 'tidal.com' in href:
                        found['tidal'] = clean_url(href)

                before = dict(platforms)
                platforms.update(found)

                # Премахваме iHeartRadio, ако е счупено
                if 'iheartradio' in platforms and not found.get('iheartradio'):
                    del platforms['iheartradio']

                if platforms.get("spotify"): entry["spotifyUrl"] = platforms["spotify"]
                if platforms.get("apple"): entry["appleUrl"] = platforms["apple"]
                if platforms.get("youtube"): entry["youtubeUrl"] = platforms["youtube"]

                if platforms != before:
                    changed += 1
                    print(f"    ✅ намерени: {', '.join(found.keys()) or '—'}")
                else:
                    print(f"    ⚪ нищо ново намерено.")

            except Exception as e:
                print(f"    ❌ грешка: {e}")

            await asyncio.sleep(1)

        await browser.close()

    save_json(DATA_PATH, library)
    print(f"\nГотово: {changed} обновени, {skipped} пропуснати от общо {total}.")


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
