#!/usr/bin/env python3
"""
fetch_distrokid_links.py — сървърно обхождане на HyperFollow страниците
========================================================================
Пуска се от .github/workflows/distrokid-links.yml (workflow_dispatch —
ръчно от Actions таба, или от бутона "▶️ Пусни сканиране в GitHub Actions"
в dashboard-а, виж ShortsStudio.dispatchLibraryScan() в js/shorts-studio.js).

ЗАЩО ТОЗИ СКРИПТ СЪЩЕСТВУВА: браузърната версия (ShortsStudio.enrichLibrary())
трябва да минава през публични CORS прокси (CodeTabs/allorigins/...), защото
distrokid.com не праща CORS хедъри и браузърът директно отказва да прочете
отговора. Тези прокситата се оказаха ненадеждни при 30+ последователни
заявки (viseha do timeout). Тук няма такъв проблем — GitHub Actions runner-ът
прави обикновена сървър-до-сървър HTTP заявка, никакъв браузър, никакъв CORS,
следователно и никаква нужда от прокси.

Чете data/distrokid-library.json (записан от dashboard-а през бутона
"💾 Запази трайно в GitHub repo-то" — ТРЯБВА да е направено поне веднъж
преди първото пускане на този workflow, иначе файлът липсва и скриптът
излиза чисто без грешка). За всяка песен БЕЗ вече намерени Spotify+Apple+
YouTube (същия skip критерий като enrichLibrary() в js/shorts-studio.js —
не хабим заявки/време за вече готови песни) сваля реалната HyperFollow
страница и извлича вградените платформени линкове (data-hyperfollow-store
атрибута — най-надежден, после domain regex като резерва — огледало на
_fetchPlatformLinksFromPage() в JS), после пише резултата обратно в СЪЩИЯ
файл (data/distrokid-library.json), който workflow-ът после commit-ва.

Ако добавиш нова платформа в PLATFORM_DOMAIN_PATTERNS/_PLATFORM_LABELS от
JS страната, добави я и тук (PLATFORM_DOMAIN_PATTERNS по-долу), за да не се
разминат двете имплементации.
"""

from __future__ import annotations

import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import load_json, save_json, _UA_HEADER  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / "data" / "distrokid-library.json"

# Само тези три се броят за "песента е готова" (виж enrichLibrary() skip
# критерия в js/shorts-studio.js) — останалите платформи по-долу пак се
# извличат, ако страницата ги съдържа, но не блокират skip-а сами по себе си.
CORE_PLATFORMS = ("spotify", "apple", "youtube")

# Domain regex fallback — само за платформи, които data-hyperfollow-store
# атрибутът не покрие (по-стари HyperFollow страници без него). Дръж
# синхронизирано с _PLATFORM_PATTERNS в js/shorts-studio.js.
PLATFORM_DOMAIN_PATTERNS = {
    "spotify": r'(https://open\.spotify\.com/track/[^\s"\'<>]+)',
    "apple": r'(https://music\.apple\.com/[^\s"\'<>]+)',
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


def fetch_page(url: str, timeout: int = 20, retries: int = 2) -> str | None:
    """GET директно (без прокси нужда — сървър-до-сървър, не браузър)."""
    req = urllib.request.Request(url, headers=_UA_HEADER)
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            print(f"    ⚠️ HTTP {e.code} (опит {attempt + 1}/{retries + 1})")
        except Exception as e:  # timeout, connection reset и т.н.
            print(f"    ⚠️ {e} (опит {attempt + 1}/{retries + 1})")
        if attempt < retries:
            time.sleep(2)
    return None


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


def main() -> None:
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
        html = fetch_page(url)
        if html is None:
            print("    ❌ страницата не се прочете (всички опити отказаха).")
            continue

        found = extract_links(html)
        before = dict(platforms)
        platforms.update(found)
        if platforms != before:
            changed += 1
            print(f"    ✅ намерени: {', '.join(found.keys()) or '—'}")
        else:
            print(f"    ⚪ нищо ново намерено ({len(html)} символа прочетени).")

        time.sleep(1)  # леко забавяне между заявките, не бомбардираме DistroKid

    save_json(DATA_PATH, library)
    print(f"\nГотово: {changed} песни обновени, {skipped} вече бяха готови, от общо {total}.")


if __name__ == "__main__":
    main()
