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

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import (  # noqa: E402
    DATA_DIR, REPO_ROOT, QuotaBudget, YouTubeClient,
    call_ai_json, load_json, log, save_json,
)

_YT_API_BASE = "https://www.googleapis.com/youtube/v3"


def _fetch_video_metadata(video_ids):
    """Директен videos.list за конкретни video ID-та (batch до 50 наведнъж),
    независимо от data/stats-history.json snapshot-а. Ползва се за видеа,
    които са в Releases таба (т.40 — source of truth за собственост), но
    YouTube още не ги показва в обикновения uploads списък на канала
    (типично забавяне при DistroKid/дистрибуторски upload-и).
    Връща dict video_id -> метаданни в същия формат като load_channel_videos(),
    или {} при липсващ API ключ/грешка (никога не гърми целия sync).
    """
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        log("  ⚠ Липсва YOUTUBE_API_KEY — не мога да изтегля метаданни директно за Releases видеа.")
        return {}

    video_ids = list(video_ids)
    result = {}
    for i in range(0, len(video_ids), 50):
        chunk = video_ids[i:i + 50]
        params = {"part": "snippet", "id": ",".join(chunk), "key": api_key}
        query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        url = f"{_YT_API_BASE}/videos?{query}"
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            log(f"  ⚠ videos.list грешка при директно теглене на Releases видеа: {e}")
            continue
        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            result[item["id"]] = {
                "video_id": item["id"],
                "title": snippet.get("title", ""),
                "description": snippet.get("description", ""),
                "tags": snippet.get("tags", []),
                "published_at": snippet.get("publishedAt", ""),
            }
    return result

# DistroKid (и повечето дистрибутори) слагат стандартен ред в описанието
# на всяко видео, което разпространяват към YouTube — това е единственият
# надежден сигнал да различим РЕАЛЕН пуснат сингъл (през дистрибутор) от
# обикновен видео ъплоуд направо в канала (Shorts, visualizer, тийзър).
_DISTRIBUTOR_MARKERS = (
    "provided to youtube by distrokid",
    "provided to youtube by",  # други дистрибутори (CD Baby, TuneCore и т.н.) ползват същия формат
    "distrokid",
)


def _detect_distribution(description: str) -> str:
    d = (description or "").lower()
    for marker in _DISTRIBUTOR_MARKERS:
        if marker in d:
            return "distrokid" if "distrokid" in d else "distributor"
    return "channel-upload"

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


# Общи жанрове/поджанрове за heuristic fallback, отделно от trend_niches
# (който е списък с НИШОВИ trend стилове за discovery search заявки, не
# общо покритие). Без това, всяка нормална песен ("R&B", "Pop Ballad",
# "Hip-Hop" и т.н.) излизаше "unknown", защото trend_niches никога не
# съвпадаше с обикновени жанрове в заглавието.
_COMMON_GENRE_KEYWORDS = [
    "r&b", "rnb", "pop ballad", "pop", "hip-hop", "hip hop", "rap", "trap",
    "afrobeats", "amapiano", "reggaeton", "latin", "phonk", "hyperpop",
    "lo-fi", "lofi", "drill", "house", "techno", "edm", "dance", "ballad",
    "folk", "acoustic", "rock", "indie", "soul", "funk", "jazz", "country",
]


def _heuristic_classify(video, known_niches):
    """Fallback без AI — keyword match срещу config.json trend_niches +
    общ списък обичайни жанрове (_COMMON_GENRE_KEYWORDS), сканирани и в
    заглавието, И в описанието (много по-богат текст — DistroKid/дистри-
    буторски описания обикновено съдържат жанр/стил изрично). Честно,
    ниска увереност, никакво BPM."""
    title = (video.get("title") or "").lower()
    description = (video.get("description") or "").lower()
    haystack = f"{title}\n{description}"

    niche_match = next((n for n in known_niches if n.lower() in haystack), None)
    genre_match = next((g for g in _COMMON_GENRE_KEYWORDS if g in haystack), None)

    return {
        "video_id": video["video_id"],
        "genre": genre_match.title() if genre_match else "unknown",
        "subgenre": niche_match or (genre_match.title() if genre_match else "unknown"),
        "mood": "unknown",
        "energy": "unknown",
        "language": "unknown",
        "bpm": None,
        "style_tags": [],
        "source": "heuristic-fallback",
        "confidence": "low",
    }


def classify_videos(videos):
    """Опитва класификация през ЦЕЛИЯ AI арсенал (call_ai_json — Groq/
    Mistral/GitHub Models/Cloudflare/Pollinations/Anthropic, виж
    _youtube_common.py), на батч (до 15 наведнъж); heuristic fallback
    per-video само ако АБСОЛЮТНО никой provider не отговори."""
    config = load_json(CONFIG_PATH, {})
    known_niches = config.get("trend_niches", [])

    results = {}
    batch_size = 15
    for i in range(0, len(videos), batch_size):
        batch = videos[i:i + batch_size]
        user_prompt = "Класифицирай следните песни:\n\n" + "\n".join(
            f"- video_id: {v['video_id']} | заглавие: {v.get('title', '')} | "
            f"описание: {(v.get('description') or '')[:300]}"
            for v in batch
        )
        ai_result, provider = call_ai_json(CLASSIFY_SYSTEM_PROMPT, user_prompt, max_tokens=2000)
        ai_by_id = {}
        if isinstance(ai_result, list):
            ai_by_id = {r.get("video_id"): r for r in ai_result if isinstance(r, dict) and r.get("video_id")}

        for v in batch:
            if v["video_id"] in ai_by_id:
                r = ai_by_id[v["video_id"]]
                r["source"] = f"ai-classified ({provider})"
                r["confidence"] = "medium"
                results[v["video_id"]] = r
            else:
                log(f"  ⚠ Няма AI резултат за '{v.get('title')}' — heuristic fallback.")
                results[v["video_id"]] = _heuristic_classify(v, known_niches)
    return results


def sync_new_tracks(releases_video_ids=None):
    """Инкрементален sync: добавя в catalog.json само видеата, които ги
    няма още (по video_id). Връща брой новодобавени записи.

    releases_video_ids (т.40): ако е подадено (set от video ID-та от
    Releases таба на канала), ВСЯКО от тях, което липсва в каталога, се
    добавя ДИРЕКТНО чрез videos.list — дори ако все още не се появява в
    обикновения списък с видеа на канала (data/stats-history.json
    snapshot). Причината: Releases табът е по-надежден и по-бърз източник
    на истина за собственост от чакането YouTube да покаже DistroKid
    upload-а и в редовния uploads списък (понякога отнема дни). Тези
    записи се маркират distribution=\"distrokid\" директно, без да
    минават през description-marker heuristика.
    """
    catalog = load_json(CATALOG_PATH, {"schema_version": 1, "tracks": []})
    catalog.setdefault("tracks", [])
    known_ids = {t["youtube_video_id"] for t in catalog["tracks"] if t.get("youtube_video_id")}

    channel_videos = load_channel_videos()
    new_videos = [v for v in channel_videos if v.get("video_id") and v["video_id"] not in known_ids]

    forced_distrokid_ids = set()
    if releases_video_ids:
        already_covered = known_ids | {v["video_id"] for v in new_videos}
        missing_release_ids = set(releases_video_ids) - already_covered
        if missing_release_ids:
            log(f"→ {len(missing_release_ids)} video ID от Releases липсват в каталога и не са в "
                f"последния channel snapshot — тегля метаданните им директно (videos.list)...")
            fetched = _fetch_video_metadata(missing_release_ids)
            for vid in missing_release_ids:
                meta = fetched.get(vid)
                if meta:
                    new_videos.append(meta)
                    forced_distrokid_ids.add(vid)
                else:
                    log(f"  ⚠ Не успях да изтегля метаданни за {vid} от Releases "
                        f"(частен/изтрит/регионално ограничен видео?) — прескачам.")

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
            # "distrokid" = реален пуснат сингъл през дистрибутора (detect-нато
            # от "Provided to YouTube by..." в описанието, ИЛИ директно
            # потвърдено от Releases таба — виж forced_distrokid_ids по-горе),
            # "distributor" = друг дистрибутор със същия формат, "channel-upload" =
            # обикновено видео директно в канала (Shorts/visualizer/тийзър — не е
            # непременно официален релийз). Discovery engine-ът може да
            # ползва това поле, за да пъха в playlist-ите само реални релийзи.
            "distribution": "distrokid" if v["video_id"] in forced_distrokid_ids
                             else _detect_distribution(v.get("description", "")),
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


def reclassify_unknown():
    """Преизкласифицира вече съществуващи catalog записи, заседнали на
    genre=unknown/subgenre=unknown (напр. песни, обработени преди AI
    ключ/description capture да са били налични). НЕ пипа вече успешно
    класифицирани записи — само истинските "unknown" случаи. Взима
    свежото title+description от последния snapshot в stats-history.json
    (същия източник като sync_new_tracks), не от стария catalog запис."""
    catalog = load_json(CATALOG_PATH, {"schema_version": 1, "tracks": []})
    catalog.setdefault("tracks", [])
    stuck = [t for t in catalog["tracks"] if t.get("genre") == "unknown" and t.get("subgenre") == "unknown"]
    if not stuck:
        log("→ Няма заседнали 'unknown' записи за преизкласифициране.")
        return 0, catalog

    by_video_id = {v["video_id"]: v for v in load_channel_videos()}
    to_reclassify = []
    for t in stuck:
        vid = t.get("youtube_video_id")
        fresh = by_video_id.get(vid)
        if fresh:
            to_reclassify.append(fresh)
        else:
            log(f"  ⚠ '{t.get('title')}' ({vid}) вече не е в stats-history snapshot-а — пропускам.")

    if not to_reclassify:
        log("→ Няма прясно видео-описание за преизкласифициране (пусни track_stats.py първо?).")
        return 0, catalog

    log(f"→ Преизкласифицирам {len(to_reclassify)} заседнали 'unknown' записа...")
    classified = classify_videos(to_reclassify)

    by_track_id = {t["youtube_video_id"]: t for t in catalog["tracks"]}
    updated = 0
    for v in to_reclassify:
        c = classified.get(v["video_id"])
        if not c:
            continue
        track = by_track_id[v["video_id"]]
        track["genre"] = c.get("genre", "unknown")
        track["subgenre"] = c.get("subgenre", "unknown")
        track["mood"] = c.get("mood", "unknown")
        track["energy"] = c.get("energy", "unknown")
        track["bpm"] = c.get("bpm")
        track["language"] = c.get("language", "unknown")
        track["style_tags"] = c.get("style_tags", [])
        track["source"] = c.get("source", "heuristic-fallback")
        track["confidence"] = c.get("confidence", "low")
        track["distribution"] = _detect_distribution(v.get("description", ""))
        track["classified_at"] = datetime.now(timezone.utc).isoformat()
        updated += 1

    if updated:
        catalog["last_updated"] = datetime.now(timezone.utc).isoformat()
        save_json(CATALOG_PATH, catalog)
        log(f"✅ Преизкласифицирани {updated} записа в data/catalog.json.")
    return updated, catalog


def main():
    if "--reclassify-unknown" in sys.argv:
        reclassify_unknown()
        return
    added, _ = sync_new_tracks()
    if added == 0:
        log("Няма промяна в data/catalog.json.")


if __name__ == "__main__":
    main()
