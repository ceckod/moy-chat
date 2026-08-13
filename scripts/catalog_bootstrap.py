#!/usr/bin/env python3
"""
catalog_bootstrap.py — попълва/обновява data/catalog.json
============================================================

Решение B1 (одобрено): каталогът на авторските песни се строи АВТОМАТИЧНО
от вече публикуваните видеа на канала (data/stats-history.json, писан от
scripts/track_stats.py), обогатени с описание/тагове от videos.list, и
класифицирани по жанр/поджанр/mood/BPM/език/energy/style_tags през Claude
(ANTHROPIC_API_KEY). Никакво ръчно въвеждане не е нужно за старта.

Работи и инкрементално: при всеки run обработва само видеата, които ги
НЯМА още в catalog.json по video_id — затова е безопасно да се пуска и
от youtube_discovery_engine.py при всеки daily job (стъпка 3 от Daily
Workflow), не само еднократно.

Ако ANTHROPIC_API_KEY липсва (или Claude отговори с грешка/невалиден
JSON), пада на heuristic класификация по ключови думи от config.json
("trend_niches" списъка) — честно маркирана source="heuristic-fallback",
confidence="low", вместо да измисля стойности или да гърми целия run.

Употреба:
    python scripts/catalog_bootstrap.py
    (или се извиква от youtube_discovery_engine.py като функция —
     виж sync_new_tracks() по-долу)
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import (  # noqa: E402
    DATA_DIR, REPO_ROOT, QuotaBudget, YouTubeClient,
    call_anthropic_json, load_json, log, save_json,
)

STATS_PATH = DATA_DIR / "stats-history.json"
CATALOG_PATH = DATA_DIR / "catalog.json"
CONFIG_PATH = REPO_ROOT / "config.json"

CLASSIFY_SYSTEM_PROMPT = """Ти си музикален A&R анализатор. За всяка подадена песен (заглавие + описание
+ тагове от YouTube) определи структурирани музикални метаданни.
Връщай ЕДИНСТВЕНО валиден JSON масив, без преамбюл, без markdown fences.
За всяка песен в масива връщай ТОЧНО този формат:
{
  "video_id": "...",
  "genre": "най-широка категория, напр. Electronic, Pop, Hip-Hop",
  "subgenre": "по-тясна/разпознаваема категория, напр. 'Dark Synthwave', 'Melodic Techno' — това е категорията, по която ще се групират плейлисти, затова бъди конкретен, но не измисляй прекалено нишова дума",
  "mood": "напр. Melancholic, Euphoric, Aggressive, Dreamy, Nostalgic",
  "energy": "Low | Medium | High",
  "language": "ISO 639-1 код по думите в заглавието/описанието, напр. en, bg, es — 'unknown' ако не си сигурен",
  "bpm": число (приблизителна оценка по стил/жанр) или null ако наистина няма как да прецениш,
  "style_tags": [до 5 кратки тага]
}
Ако липсва достатъчно информация за дадено поле, използвай null (за bpm) или "unknown" (за текстовите полета) — НЕ измисляй правдоподобно звучаща стойност."""


def load_channel_videos():
    stats = load_json(STATS_PATH, {"snapshots": []})
    snaps = stats.get("snapshots", [])
    if not snaps:
        return []
    latest = snaps[-1]
    return latest.get("videos", [])


def _heuristic_classify(video, known_niches):
    """Fallback без AI — прост keyword match срещу config.json trend_niches
    + груба евристика по заглавие. Честно, ниска увереност, никакво BPM."""
    title = (video.get("title") or "").lower()
    matched = next((n for n in known_niches if n.lower() in title), None)
    return {
        "video_id": video["video_id"],
        "genre": "unknown",
        "subgenre": matched or "unknown",
        "mood": "unknown",
        "energy": "unknown",
        "language": "unknown",
        "bpm": None,
        "style_tags": [],
        "source": "heuristic-fallback",
        "confidence": "low",
    }


def classify_videos(videos):
    """Опитва Claude класификация на батч (до 15 наведнъж, за разумен
    context/output размер); heuristic fallback per-video при неуспех."""
    config = load_json(CONFIG_PATH, {})
    known_niches = config.get("trend_niches", [])

    results = {}
    batch_size = 15
    for i in range(0, len(videos), batch_size):
        batch = videos[i:i + batch_size]
        user_prompt = "Класифицирай следните песни:\n\n" + "\n".join(
            f"- video_id: {v['video_id']} | заглавие: {v.get('title', '')}" for v in batch
        )
        ai_result = call_anthropic_json(CLASSIFY_SYSTEM_PROMPT, user_prompt, max_tokens=2000)
        ai_by_id = {}
        if isinstance(ai_result, list):
            ai_by_id = {r.get("video_id"): r for r in ai_result if isinstance(r, dict) and r.get("video_id")}

        for v in batch:
            if v["video_id"] in ai_by_id:
                r = ai_by_id[v["video_id"]]
                r["source"] = "ai-classified"
                r["confidence"] = "medium"
                results[v["video_id"]] = r
            else:
                log(f"  ⚠ Няма AI резултат за '{v.get('title')}' — heuristic fallback.")
                results[v["video_id"]] = _heuristic_classify(v, known_niches)
    return results


def sync_new_tracks():
    """Инкрементален sync: добавя в catalog.json само видеата, които ги
    няма още (по video_id). Връща брой новодобавени записи."""
    catalog = load_json(CATALOG_PATH, {"schema_version": 1, "tracks": []})
    catalog.setdefault("tracks", [])
    known_ids = {t["youtube_video_id"] for t in catalog["tracks"] if t.get("youtube_video_id")}

    channel_videos = load_channel_videos()
    new_videos = [v for v in channel_videos if v.get("video_id") and v["video_id"] not in known_ids]

    if not new_videos:
        log("→ Каталогът вече е синхронизиран с всички видеа от канала — 0 нови.")
        return 0, catalog

    log(f"→ Намерени {len(new_videos)} видео(а), липсващи от каталога — класифицирам...")
    classified = classify_videos(new_videos)

    now = datetime.now(timezone.utc).isoformat()
    for v in new_videos:
        c = classified.get(v["video_id"], {})
        catalog["tracks"].append({
            "id": f"track_{v['video_id']}",
            "title": v.get("title", ""),
            "youtube_video_id": v["video_id"],
            "release_date": (v.get("published_at") or "")[:10] or None,
            "genre": c.get("genre", "unknown"),
            "subgenre": c.get("subgenre", "unknown"),
            "mood": c.get("mood", "unknown"),
            "energy": c.get("energy", "unknown"),
            "bpm": c.get("bpm"),
            "language": c.get("language", "unknown"),
            "style_tags": c.get("style_tags", []),
            "source": c.get("source", "heuristic-fallback"),
            "confidence": c.get("confidence", "low"),
            "classified_at": now,
        })

    catalog["last_bootstrap"] = catalog.get("last_bootstrap") or now
    catalog["last_updated"] = now
    save_json(CATALOG_PATH, catalog)
    log(f"✅ Каталогът е обновен — {len(new_videos)} нови записа, общо {len(catalog['tracks'])}.")
    return len(new_videos), catalog


def main():
    added, _ = sync_new_tracks()
    if added == 0:
        log("Няма промяна в data/catalog.json.")


if __name__ == "__main__":
    main()
