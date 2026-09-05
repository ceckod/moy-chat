#!/usr/bin/env python3
"""
fetch_distrokid_links.py — сървърно обхождане на HyperFollow страниците (Playwright)
========================================================================
Използва headless Chromium с реален User-Agent, за да заобиколи Cloudflare 403 
Forbidden грешките при заявки от GitHub Actions runner-а.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import load_json, save_json  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / "data" / "distrokid-library.json"

CORE_PLATFORMS = ("spotify", "apple", "youtube")

PLATFORM_DOMAIN_PATTERNS = {
    "spotify": r'(https://open\.spotify\.com/track/[^\s"\'<>]+)',
    "apple": r'(https://(?:music|itunes)\.apple\.com/[^\s"\'<>]+)',
    "youtube": r'(https://(?:www\.)?youtube\.com/watch\?v=[^\s"\'<>]+|https://youtu\.be/[^\s"\'<>]+)',
    "deezer": r'(https://www\.deezer\.com/[^\s"\'<>]+)',
    "tidal": r'(https://(?:www\.)?tidal\.com/[^\s"\'<>]+)',
    "amazonMusic": r'(https://music\.amazon\.com/[^\s"\'<>]+)',
    "iheartradio": r'(https://www\.iheart\.com/[^\s"\'<>]+)',
    "pandora": r'(https://www\.pandora\.com/[^\s"\'<>]+)',
    "napster": r'(https://(?:www\.)?napster\.com/[^\s"\'<>]+)',
    "soundcloud": r'(https://soundcloud\.com/[^\s"\'<>]+)',
}

STORE_ATTR_RE = re.compile(
    r'data-testid="hyperfollow-store-link"[^>]*data-hyperfollow-store="([^"]+)"[^>]*href="([^"]+)"'
)


def extract_links(html: str) -> dict:
    found = {}
    for store_key, href in STORE_ATTR_RE.findall(html):
        found["apple" if store_key == "applemusic" else store_key] = href
    for key, pattern in PLATFORM_DOMAIN_PATTERNS.items():
        if key in found:
            continue
        m = re.search(pattern, html)
        if m:
            found[key] = m.group(1)
    return found


async def main_async() -> None:
    if not DATA_PATH.exists():
        print(
            "⚪ data/distrokid-library.json липсва — първо натисни "
            "\"💾 Запази трайно в GitHub repo-то\" от dashboard-а поне "
            "веднъж. Нищо за правене този път."
        )
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
                print(f"[{i}/{total}] ⏭️  {title} — вече готова (Spotify+Apple+YouTube), пропускам.")
                continue

            url = entry.get("url")
            if not url:
                print(f"[{i}/{total}] ⚪ {title} — няма hyperfollow url в записа, пропускам.")
                continue

            print(f"[{i}/{total}] 🔎 {title} ...")
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                if response and response.status >= 400:
                    print(f"    ⚠️ HTTP {response.status}")
                    continue

                await page.wait_for_timeout(1500)
                html = await page.content()

                found = extract_links(html)
                before = dict(platforms)
                platforms.update(found)

                # Синхронизация с директните полета (за обратна съвместимост)
                if platforms.get("spotify"):
                    entry["spotifyUrl"] = platforms["spotify"]
                if platforms.get("apple"):
                    entry["appleUrl"] = platforms["apple"]
                if platforms.get("youtube"):
                    entry["youtubeUrl"] = platforms["youtube"]

                if platforms != before:
                    changed += 1
                    print(f"    ✅ намерени: {', '.join(found.keys()) or '—'}")
                else:
                    print(f"    ⚪ нищо ново намерено ({len(html)} символа прочетени).")

            except Exception as e:
                print(f"    ❌ грешка при четене: {e}")

            await asyncio.sleep(1)

        await browser.close()

    save_json(DATA_PATH, library)
    print(f"\nГотово: {changed} песни обновени, {skipped} вече бяха готови, от общо {total}.")


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
