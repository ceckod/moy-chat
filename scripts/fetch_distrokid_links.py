#!/usr/bin/env python3
"""
fetch_distrokid_links.py — извличане на платформени линкове + аудио демо от HyperFollow
==================================================================================
Използва Playwright, за да извлече реалните URL адреси на стрийминг платформите
и директния линк към аудио плейъра (preview audio) на DistroKid.
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
    url = re.sub(r'([\?&])(uo|app|ls|at|ct|pt)=[^&]*', '', url)
    return url.rstrip('?&')


async def extract_audio_preview(page) -> str | None:
    """Извлича директния MP3/M4A линк за аудио демото от страницата."""
    try:
        # 1. Търсене в <audio> / <source> елементи
        audio_src = await page.evaluate("""() => {
            const audio = document.querySelector('audio source, audio');
            if (audio && audio.src) return audio.src;
            return null;
        }""")
        if audio_src and audio_src.startswith('http'):
            return audio_src

        # 2. Търсене в целия HTML за линкове към качени аудио превюта в CDN на DistroKid
        html = await page.content()
        audio_match = re.search(r'(https://[^\s"\'<>]+\.(?:mp3|m4a|aac)(?:\?[^\s"\'<>]*)?)', html, re.IGNORECASE)
        if audio_match:
            return audio_match.group(1)

    except Exception:
        pass
    return None


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

            url = entry.get("url")
            if not url:
                continue

            print(f"[{i}/{total}] 🔎 {title} ...")
            try:
                await page.goto(url, wait_until="networkidle", timeout=30000)
                await page.wait_for_timeout(2000)

                # 1. Извличане на платформени линкове
                anchors = await page.query_selector_all('a[href]')
                found = {}

                for a in anchors:
                    href = await a.get_attribute('href')
                    if not href:
                        continue

                    if 'spotify.com' in href:
                        found['spotify'] = clean_url(href)
                    elif 'music.apple.com' in href:
                        found['apple'] = clean_url(href)
                    elif 'youtube.com' in href or 'youtu.be' in href:
                        found['youtube'] = clean_url(href)
                    elif 'deezer.com' in href:
                        found['deezer'] = clean_url(href)
                    elif 'tidal.com' in href:
                        found['tidal'] = clean_url(href)

                # 2. Извличане на линк към демо аудиото (preview play бутона)
                preview_audio = await extract_audio_preview(page)
                if preview_audio:
                    entry["previewAudio"] = preview_audio
                    found['audioPreview'] = preview_audio

                before = dict(platforms)
                platforms.update(found)

                if platforms.get("spotify"): entry["spotifyUrl"] = platforms["spotify"]
                if platforms.get("apple"): entry["appleUrl"] = platforms["apple"]
                if platforms.get("youtube"): entry["youtubeUrl"] = platforms["youtube"]

                if platforms != before or preview_audio:
                    changed += 1
                    print(f"    ✅ намерени: {', '.join(found.keys()) or '—'}")
                else:
                    print(f"    ⚪ нищо ново намерено.")

            except Exception as e:
                print(f"    ❌ грешка: {e}")

            await asyncio.sleep(1)

        await browser.close()

    save_json(DATA_PATH, library)
    print(f"\nГотово: {changed} обновени от общо {total}.")


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
