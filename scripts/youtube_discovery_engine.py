#!/usr/bin/env python3
"""
youtube_discovery_engine.py — YouTube Auto Playlist Discovery Engine
========================================================================
Пуска се от .github/workflows/youtube-discovery.yml (daily cron +
workflow_dispatch — "Run Now"/"Dry Run" бутоните в Dashboard-а просто
тригват този workflow ръчно с dry_run input).

Concurrency / job lock — ВАЖНО ИНЖЕНЕРНО РЕШЕНИЕ:
  Вместо git-committed lock файл (риск от race condition — два паралелни
  Actions run-а могат да commit-нат lock почти едновременно, точно
  проблемът, който lock-ът трябва да предотврати), защитата срещу
  паралелно изпълнение е през GitHub Actions `concurrency:` group в
  .github/workflows/youtube-discovery.yml — това е нативен, атомарен
  механизъм на GitHub, не на нашия код. Скриптът тук прави ДОПЪЛНИТЕЛНА,
  defensive проверка (виж check_soft_lock()) само за видимост в лога,
  не като единствена защита.

Следва Daily Workflow от спецификацията:
  1-3.  Синхронизира каталога (нови мои видеа) — catalog_bootstrap.py
  4.    Клъстерира каталога (AI subgenre/genre групиране, min_cluster_size)
  5.    За всеки клъстер: намира/създава playlist (по cluster_key —
        НИКОГА дубликати), спазва manual overrides (locked/disabled)
  6-11. Persistent candidate cache (data/discovery-candidates-cache.json,
        TTL) — search.list само когато pool-ът е малък/остарял
  12-14 Филтриране, global dedup (с cross-playlist similarity threshold
        изключение), freshness scoring
  15-19 Self-track ratio + min distance, динамично позициониране, НИКОГА
        не се маха моя песен автоматично
  20-21 Diff engine (ADD/REMOVE/REORDER/KEEP) — празен diff → 0 API calls
  22-23 Dry Run / Real execution
  24-25 Partial failure handling + verification след write
  26-28 track-performance.json (learning loop, playlist lift = estimate)
  29    discovery-log.json (append-only, богата схема)
  36-37 Git commit само на data/*.json, idempotent при повторен run

Safety toggles (data/discovery-config.json): enable_external_discovery,
enable_auto_playlist_creation, enable_auto_reorder,
enable_auto_removal_of_external_tracks — всички проверени преди
съответното действие, никога подразбиращо се "true" в кода.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import (  # noqa: E402
    DATA_DIR, REPO_ROOT, QuotaBudget, YouTubeClient,
    get_oauth_access_token, load_json, log, retry, save_json,
)
from catalog_bootstrap import sync_new_tracks  # noqa: E402

CONFIG_PATH = DATA_DIR / "discovery-config.json"
ROOT_CONFIG_PATH = REPO_ROOT / "config.json"
RELEASES_CACHE_PATH = DATA_DIR / "releases-catalog-cache.json"
CATALOG_PATH = DATA_DIR / "catalog.json"
STATE_PATH = DATA_DIR / "playlists-state.json"
LOG_PATH = DATA_DIR / "discovery-log.json"
PERF_PATH = DATA_DIR / "track-performance.json"
STATS_PATH = DATA_DIR / "stats-history.json"
CACHE_PATH = DATA_DIR / "discovery-candidates-cache.json"
SOFT_LOCK_PATH = DATA_DIR / ".discovery-job.softlock"  # ephemeral, НЕ git-committed — виж докстринга по-горе

MAX_LOG_RUNS = 60


def slugify(text: str) -> str:
    text = (text or "unknown").strip().lower()
    # т.22.08.2026 бъгфикс: преди тук беше [^a-z0-9], което трие ЦЯЛОСТНО
    # всеки кирилски етикет (напр. "Български Хип-Хоп" -> "") и пада на
    # "unknown" fallback-а — всички кирилски subgenre-и се сливаха в ЕДИН
    # общ клъстер вместо да отиват в правилния си (bulgarian-hip-hop,
    # bulgarian-pop, bulgarian-folk...). Добавен диапазон а-я, за да се
    # пази кирилицата в slug-а вместо да се трие.
    text = re.sub(r"[^a-zа-я0-9]+", "-", text)
    return re.sub(r"-+", "-", text).strip("-") or "unknown"


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


def _age_days(iso_str):
    return (_now() - datetime.fromisoformat(iso_str.replace("Z", "+00:00"))).days if iso_str else None


# ---------------------------------------------------------------------------
# SOFT LOCK (defensive, вижи докстринга — GH `concurrency:` е авторитетният механизъм)
# ---------------------------------------------------------------------------

def check_soft_lock(ttl_minutes):
    if not SOFT_LOCK_PATH.exists():
        return True
    try:
        started = SOFT_LOCK_PATH.read_text().strip()
        age = (_now() - datetime.fromisoformat(started)).total_seconds() / 60
        if age < ttl_minutes:
            log(f"⚠ Soft lock файл съществува и е само на {age:.0f} мин (TTL {ttl_minutes}) — "
                f"вероятно паралелен run в СЪЩИЯ runner (необичайно). Продължавам предпазливо, "
                f"истинската защита е GH Actions `concurrency:` group в workflow-а.")
        else:
            log(f"⚪ Намерен stale soft lock ({age:.0f} мин стар) — прескачам, не блокира run-а.")
    except Exception:
        pass
    return True


def write_soft_lock():
    try:
        SOFT_LOCK_PATH.write_text(_iso(_now()))
    except Exception:
        pass


def release_soft_lock():
    try:
        if SOFT_LOCK_PATH.exists():
            SOFT_LOCK_PATH.unlink()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# КЛЪСТЕРИРАНЕ
# ---------------------------------------------------------------------------

def cluster_catalog(catalog_tracks, min_cluster_size):
    """Групира по AI-присвоения subgenre (fallback: genre), пази само групи
    с >= min_cluster_size песни. Връща {cluster_key: {"label":..., "tracks":[...]}}"""
    buckets = defaultdict(list)
    labels = {}
    for t in catalog_tracks:
        label = t.get("subgenre") if t.get("subgenre") not in (None, "unknown", "") else t.get("genre")
        if not label or label == "unknown":
            continue
        key = slugify(label)
        buckets[key].append(t)
        labels[key] = label

    significant = {k: {"label": labels[k], "tracks": v} for k, v in buckets.items() if len(v) >= min_cluster_size}
    skipped = {k: len(v) for k, v in buckets.items() if len(v) < min_cluster_size}
    if skipped:
        log(f"  ⚪ Пропуснати клъстери под min_cluster_size ({min_cluster_size}): {skipped}")
    return significant


_BG_STYLE_HINTS = ("чалга", "кючек", "поп-фолк", "popfolk", "pop-folk", "народна", "bulgarian")


def _is_bulgarian_style_label(label: str) -> bool:
    """т.42: определя дали cluster label-ът е специфично-български стил
    (чалга/кючек/поп-фолк и т.н.), при който запазваме оригиналното име
    както го е присвоил AI класификатора (кирилица или не), вместо да го
    насилваме да звучи като превод. За всичко останало описанието е на
    английски."""
    low = label.lower()
    return any(h in low for h in _BG_STYLE_HINTS) or bool(re.search(r"[а-яА-Я]", label))


def build_playlist_description(cluster_label: str) -> str:
    """Генерира описание на плейлиста. По подразбиране на английски (т.42
    — по искане: описанията да са четими за по-широка аудитория), но
    самото име на стила/жанра НИКОГА не се превежда/транслитерира —
    запазва се точно както AI класификаторът го е присвоил (важно за
    специфично-български стилове като чалга/кючек, за които няма добър
    английски еквивалент и превод би звучал криво)."""
    return (
        f"🎧 {cluster_label} Discovery — a curated mix blending fresh {cluster_label} picks "
        f"with select original releases. Refreshed periodically by the CD-B Discovery Engine."
    )


def _label_similarity(label_a: str, label_b: str) -> float:
    """Груба Jaccard similarity върху токенизирани label-и, за
    CROSS_PLAYLIST_SIMILARITY_THRESHOLD (т.13). Съзнателна опростена
    евристика v1 — нямаме пълен style-embedding pipeline; документирано
    ограничение, не претенция за точна музикална similarity.

    БЪГФИКС 2026-08-16: тази функция и докстринга ѝ преди стояха без
    собствен `def` ред — бяха слети в тялото на build_playlist_description()
    (СЛЕД неговия return, значи никога не се изпълняваха) като недостижим
    код. `_label_similarity` реално НЕ съществуваше като име, докато
    pick_candidates_for_playlist() я вика на ред ~547 при cross-playlist
    dedup — NameError, необхванат от try/except по-нагоре, чупеше целия
    run веднага щом даден candidate бъде преизползван между 2+ плейлиста.
    Виж PROJECT_STATE.md за пълния анализ."""
    ta, tb = set(label_a.lower().split()), set(label_b.lower().split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# ---------------------------------------------------------------------------
# FIND-OR-CREATE PLAYLIST (спазва manual overrides: locked/disabled)
# ---------------------------------------------------------------------------

def _maybe_sync_description(playlist_entry, cluster_label, yt: YouTubeClient, dry_run):
    """т.42: описанието се задаваше само веднъж, при създаване на плейлиста
    (playlists.insert), и никога повече не се пипаше — затова стари
    плейлисти оставаха завинаги с остарялото описание дори след промяна
    в шаблона. Тази функция го синхронизира на всеки run, ако е остаряло.
    Спазва 'locked' manual override (т.34) — никога не пипа плейлист,
    който потребителят изрично е заключил."""
    if playlist_entry.get("locked"):
        return
    fresh = build_playlist_description(cluster_label)
    if playlist_entry.get("description") == fresh:
        return
    if dry_run:
        log(f"  🧪 [DRY RUN] Бих обновил описанието на '{playlist_entry['name']}'.")
        return
    if not yt.can_write:
        return
    playlist_id = playlist_entry.get("youtube_playlist_id")
    if not playlist_id or playlist_id == "DRY_RUN_PENDING":
        return
    try:
        retry(lambda: yt.write(
            "playlists", {"part": "snippet"},
            {"id": playlist_id, "snippet": {"title": playlist_entry["name"], "description": fresh}},
            "playlists.update", method="PUT",
        ), label=f"обновяване на описание за '{playlist_entry['name']}'")
        playlist_entry["description"] = fresh
        playlist_entry["last_updated"] = _iso(_now())
        log(f"  ✏️ Обнових описанието на '{playlist_entry['name']}'.")
    except Exception as e:
        log(f"  ⚠ Неуспешно обновяване на описание за '{playlist_entry['name']}': {e}")


def find_or_create_playlist(cluster_key, cluster_label, state, yt: YouTubeClient, dry_run, cfg):
    existing = next((p for p in state["playlists"] if p["cluster_key"] == cluster_key), None)
    if existing:
        _maybe_sync_description(existing, cluster_label, yt, dry_run)
        return existing, False

    if not cfg.get("enable_auto_playlist_creation", True):
        log(f"  ⚪ enable_auto_playlist_creation=false — пропускам нов клъстер '{cluster_label}'.")
        return None, False

    active_count = sum(1 for p in state["playlists"] if not p.get("archived"))
    if active_count >= cfg["max_playlists"]:
        log(f"  ⚪ Достигнат max_playlists ({cfg['max_playlists']}) — пропускам нов клъстер '{cluster_label}'.")
        return None, False

    name = f"{cluster_label} — Discover"
    description = build_playlist_description(cluster_label)
    now = _iso(_now())
    entry = {
        "cluster_key": cluster_key, "label": cluster_label, "youtube_playlist_id": None,
        "name": name, "description": description, "created_at": now, "last_updated": now,
        "tracks": [], "history": [],
        "archived": False,
        # manual overrides (т.34 от спецификацията) — engine-ът никога не ги презаписва сам:
        "locked": False, "disabled": False,
        "excluded_video_ids": [], "forced_video_ids": [],
        "self_track_ratio_override": None, "max_playlist_size_override": None,
        "self_track_ratio_min_override": None, "min_playlist_size_override": None,
    }

    if dry_run:
        log(f"  🧪 [DRY RUN] Бих създал нов playlist: '{name}'")
        entry["youtube_playlist_id"] = "DRY_RUN_PENDING"
        return entry, True

    if not yt.can_write:
        log(f"  ⚠ Няма OAuth access — не мога да създам playlist '{name}' (read-only run).")
        return None, False

    result = retry(lambda: yt.write(
        "playlists", {"part": "snippet,status"},
        {"snippet": {"title": name, "description": description}, "status": {"privacyStatus": "public"}},
        "playlists.insert",
    ), label=f"създаване на playlist '{name}'")
    entry["youtube_playlist_id"] = result["id"]
    log(f"  ✅ Създаден нов playlist: '{name}' ({result['id']})")
    return entry, True


# ---------------------------------------------------------------------------
# RELEASES SOURCE-OF-TRUTH (т. по изрично желание): единственият източник
# за "кои песни са мои" вече е releases табът на канала
# (https://www.youtube.com/@handle/releases), НЕ description-marker
# евристика върху всички ъплоуди. YouTube Data API няма публичен endpoint
# за този таб (проверено — channelSections.list поддържа само
# allPlaylists/popularUploads/recentUploads/singlePlaylist/multiplePlaylists
# и т.н., нищо releases-специфично), затова четем реалната страница през
# yt-dlp (--flat-playlist, само метаданни, без сваляне на видео).
# ---------------------------------------------------------------------------

def _resolve_release_playlist_to_video_ids(playlist_id):
    """Всеки запис в /releases таба е playlist ID (формат 'OLAK5uy_...'),
    НЕ video ID — YouTube представя всеки официален релийз като мини-
    плейлист (обикновено 1 песен вътре за single). Тази функция "отваря"
    конкретния playlist и връща истинските video ID-та вътре в него."""
    try:
        result = subprocess.run(
            ["yt-dlp", "--flat-playlist", "--dump-single-json", "--skip-download", "--no-warnings",
             f"https://www.youtube.com/playlist?list={playlist_id}"],
            capture_output=True, text=True, timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return set()
    if result.returncode != 0:
        return set()
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return set()
    entries = data.get("entries", []) or []
    return {e["id"] for e in entries if e.get("id")}


def fetch_releases_video_ids(url):
    """Връща set() от РЕАЛНИ video ID-та от releases таба, или None при
    грешка (мрежа/yt-dlp липсва/невалиден отговор) — НИКОГА празен set()
    при грешка, за да не изтрием случайно целия my_release_pool заради
    временен проблем с четенето.

    ВАЖНО (т.41 — двустепенно резолвиране): /releases табът връща списък
    от PLAYLIST ID-та (всеки релийз е мини-плейлист, формат 'OLAK5uy_...'),
    не video ID-та директно. Затова след първоначалния flat-playlist на
    /releases, "отваряме" всеки от тези плейлисти поотделно, за да вземем
    истинското video ID вътре — иначе self-track сравнението никога не
    съвпада с нищо в каталога (playlist ID никога няма да е равен на
    video ID), независимо колко е свеж/пълен каталогът.
    """
    try:
        result = subprocess.run(
            ["yt-dlp", "--flat-playlist", "--dump-single-json", "--skip-download", "--no-warnings", url],
            capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        log("  ⚠ yt-dlp не е инсталиран в средата — releases списъкът не може да се обнови този run.")
        return None
    except subprocess.TimeoutExpired:
        log("  ⚠ yt-dlp timeout при четене на releases таба.")
        return None
    if result.returncode != 0:
        log(f"  ⚠ yt-dlp гръмна (код {result.returncode}) при четене на releases: "
            f"{(result.stderr or '')[:300]}")
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        log("  ⚠ yt-dlp върна невалиден JSON за releases.")
        return None
    entries = data.get("entries", []) or []
    release_playlist_ids = {e["id"] for e in entries if e.get("id")}

    video_ids = set()
    unresolved = []
    for pid in release_playlist_ids:
        resolved = _resolve_release_playlist_to_video_ids(pid)
        if resolved:
            video_ids |= resolved
        else:
            unresolved.append(pid)
    if unresolved:
        log(f"  ⚠ Не успях да резолвирам {len(unresolved)}/{len(release_playlist_ids)} "
            f"release плейлиста към video ID (мрежа/timeout за конкретния плейлист) — прескачам ги.")
    return video_ids


def load_releases_video_ids(cfg):
    """TTL-кеширан достъп до releases списъка (data/releases-catalog-cache.json)
    — не викаме yt-dlp при всеки run, само когато кешът остарее
    (cfg['releases_cache_ttl_days'])."""
    cache = load_json(RELEASES_CACHE_PATH, {"fetched_at": None, "video_ids": []})
    ttl_days = cfg.get("releases_cache_ttl_days", 3)
    stale = True
    if cache.get("fetched_at"):
        try:
            age = (_now() - datetime.fromisoformat(cache["fetched_at"])).days
            stale = age >= ttl_days
        except ValueError:
            stale = True

    url = cfg.get("releases_url")
    if not stale:
        return set(cache["video_ids"])
    if not url:
        log("  ⚠ Липсва 'releases_url' в discovery-config.json — ползвам стар кеш "
            f"({len(cache['video_ids'])} песни), ако има.")
        return set(cache["video_ids"])

    fresh = fetch_releases_video_ids(url)
    if fresh is None:
        log(f"  ⚠ Неуспешен refresh на releases списъка — ползвам стар кеш ({len(cache['video_ids'])} песни).")
        return set(cache["video_ids"])

    save_json(RELEASES_CACHE_PATH, {"fetched_at": _iso(_now()), "video_ids": sorted(fresh)})
    log(f"  🔄 Releases списък опреснен от {url} — {len(fresh)} песни.")
    return fresh


# ---------------------------------------------------------------------------
# PERSISTENT CANDIDATE CACHE (т.11) + DISCOVERY (т.10, 12-14)
# ---------------------------------------------------------------------------

def freshness_score(published_at_iso, fresh_target_days, max_age_days):
    age_days = _age_days(published_at_iso)
    if age_days is None:
        return 0.5
    if age_days <= fresh_target_days:
        return 1.0
    if age_days >= max_age_days:
        return 0.0
    return max(0.0, 1 - (age_days - fresh_target_days) / (max_age_days - fresh_target_days))


def _parse_iso8601_duration_seconds(duration):
    """'PT1H2M10S' -> 3730 секунди. Връща None ако не може да се парсне
    (напр. празен низ или неочакван формат от YouTube API)."""
    if not duration:
        return None
    m = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", duration)
    if not m or not any(m.groups()):
        return None
    h, mnt, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mnt * 60 + s


def _search_youtube(query, yt: YouTubeClient, window_days, max_results=15, own_channel_id=None,
                     max_duration_seconds=None, min_duration_seconds=None):
    published_after = _iso(_now() - timedelta(days=window_days))
    data = retry(lambda: yt.get(
        "search",
        {"part": "snippet", "type": "video", "videoCategoryId": "10", "order": "relevance",
         "maxResults": max_results, "publishedAfter": published_after, "q": query},
        "search.list",
    ), label=f"search.list('{query}')")
    ids = [i["id"]["videoId"] for i in data.get("items", []) if i.get("id", {}).get("videoId")]
    if not ids:
        return []
    # part=contentDetails идва без допълнителна quota цена (videos.list е
    # фиксирана цена, независимо от броя part-ове) — ползваме го за duration,
    # за да филтрираме компилации/mix-ове (т.43) И Shorts (т.44) в двете
    # посоки от един и същ API отговор.
    vdata = retry(lambda: yt.get("videos", {"part": "snippet,statistics,contentDetails", "id": ",".join(ids)},
                                  "videos.list"),
                   label="videos.list за кандидати")
    out = []
    skipped_own = 0
    skipped_long = 0
    skipped_short = 0
    for v in vdata.get("items", []):
        stats = v.get("statistics", {})
        snippet = v["snippet"]
        # КРИТИЧНО: search.list е ГЛОБАЛНО YouTube търсене — нищо не пречи
        # собствен видео/Shorts на канала да съвпадне по ключови думи с
        # заявката и да се върне като резултат. Без тази проверка такова
        # видео влиза в candidate pool-а маркирано is_mine=False и после
        # се вкарва в playlist-а като "external" песен, докато всъщност е
        # авторско. Затова изрично изключваме собствения channelId тук,
        # преди резултатът изобщо да влезе в кеша.
        if own_channel_id and snippet.get("channelId") == own_channel_id:
            skipped_own += 1
            continue
        duration_s = _parse_iso8601_duration_seconds(v.get("contentDetails", {}).get("duration"))
        # т.43/44: изключваме едновременно компилации/mix-ове/DJ сетове
        # (обикновено 30мин-3ч) И Shorts/teaser клипове (обикновено <60с),
        # за да влизат в плейлистите само единични истински песни. Ако
        # duration изобщо не може да се парсне (рядко, странен формат от
        # API), НЕ филтрираме — по-добре едно нежелано видео да мине,
        # отколкото да изгубим валидни кандидати заради parsing edge case.
        if max_duration_seconds and duration_s is not None and duration_s > max_duration_seconds:
            skipped_long += 1
            continue
        if min_duration_seconds and duration_s is not None and duration_s < min_duration_seconds:
            skipped_short += 1
            continue
        out.append({
            "video_id": v["id"], "title": snippet["title"], "channel": snippet["channelTitle"],
            "published_at": snippet["publishedAt"], "views": int(stats.get("viewCount", 0)),
            "duration_seconds": duration_s,
            "discovered_at": _iso(_now()), "status": "unused", "used_in": [],
        })
    if skipped_own:
        log(f"  ⚪ Пропуснати {skipped_own} резултат(а) от собствения канал (не са external кандидати).")
    if skipped_long:
        log(f"  ⚪ Пропуснати {skipped_long} резултат(а) над {max_duration_seconds}s "
            f"(вероятно компилации/mix-ове, не единични песни).")
    if skipped_short:
        log(f"  ⚪ Пропуснати {skipped_short} резултат(а) под {min_duration_seconds}s "
            f"(вероятно Shorts/teaser клипове, не пълни песни).")
    return out


def refresh_candidate_pool(cluster_key, cluster_label, cache, yt, cfg, run_log, own_channel_id=None):
    """Връща (unused_candidates, did_search: bool). Прави search.list САМО
    ако pool-ът е под min_candidate_pool ИЛИ cache записът е по-стар от
    candidate_cache_ttl_days — иначе директно връща вече кешираните
    неизползвани кандидати, БЕЗ нито един API call (т.11/30)."""
    entry = cache["clusters"].setdefault(cluster_key, {"candidates": [], "last_search_at": None})
    unused = [c for c in entry["candidates"] if c.get("status") == "unused"]
    age = _age_days(entry["last_search_at"])
    stale = age is None or age > cfg["candidate_cache_ttl_days"]

    if not cfg.get("enable_external_discovery", True):
        return unused, False
    if len(unused) >= cfg["min_candidate_pool"] and not stale:
        log(f"  ⚪ Candidate cache за '{cluster_label}' е свеж и достатъчно голям ({len(unused)}) — 0 search.list.")
        return unused, False

    # т.19.08.2026 бъгфикс: candidate_search_queries_per_playlist_per_run
    # (discovery-config.json) стоеше дефиниран, но никога не се четеше —
    # винаги правеше точно 1 заявка, независимо от стойността в конфига.
    # Сега прави до N вариации на заявката (ограничени до броя шаблони по-
    # долу), спира веднага при първата неуспешна (напр. изчерпана дневна
    # quota), но пази каквото вече е намерил от предходните успешни заявки
    # в СЪЩИЯ run — не изхвърля частичния резултат заради по-късна грешка.
    query_templates = [
        f"{cluster_label} music",
        f"{cluster_label} official audio",
        f"{cluster_label} new release",
        f"{cluster_label} mix",
    ]
    queries_n = max(1, int(cfg.get("candidate_search_queries_per_playlist_per_run", 1)))
    queries = query_templates[:queries_n]

    did_search = False
    total_added = 0
    for q in queries:
        try:
            found = _search_youtube(q, yt, cfg["candidate_search_window_days"],
                                     own_channel_id=own_channel_id,
                                     max_duration_seconds=cfg.get("max_track_duration_seconds", 720),
                                     min_duration_seconds=cfg.get("min_track_duration_seconds", 60))
            run_log["candidate_searches"] += 1
            did_search = True
        except RuntimeError as e:
            log(f"  ⚠ Discovery search неуспешен за '{cluster_label}' ('{q}'): {e}")
            run_log["warnings"].append(f"search неуспешен за '{cluster_label}' ('{q}'): {e}")
            break  # спри тук — не пробвай следващите заявки (напр. изчерпана quota), но пази вече намереното

        known_ids = {c["video_id"] for c in entry["candidates"]}
        added = [c for c in found if c["video_id"] not in known_ids]
        entry["candidates"].extend(added)
        total_added += len(added)

    if not did_search:
        return unused, False

    entry["last_search_at"] = _iso(_now())
    log(f"  🔎 search.list за '{cluster_label}' ({len(queries)} заявки): +{total_added} нови кандидата в cache-а.")
    return [c for c in entry["candidates"] if c.get("status") == "unused"], True


def _candidate_score(c, cfg):
    """Комбинирано класиране: 60% свежест + 40% нормализирани views. Преди
    класирането беше чисто по views — печелеше винаги старата вирусна песен
    пред нещо ново с по-малко гледания. freshness_score() ползва
    fresh_track_target_days/max_track_age_days от config-а (бяха дефинирани,
    но никога не се извикваха никъде — мъртви настройки до тази промяна)."""
    fresh = freshness_score(c.get("published_at"), cfg["fresh_track_target_days"], cfg["max_track_age_days"])
    norm_views = min(1.0, c.get("views", 0) / cfg["min_candidate_views"] / 10)  # ~10x над прага = максимален views score
    return 0.6 * fresh + 0.4 * norm_views


def pick_candidates_for_playlist(cluster_key, cluster_label, unused_candidates, cache, cfg,
                                  used_globally, excluded_ids, needed=5):
    """Global dedup + cross-playlist similarity threshold изключение (т.13) +
    min_candidate_views филтър. Класира по _candidate_score() (свежест+views),
    не чисто по views. Маркира избраните като 'used' в cache-а."""
    picked = []
    ranked = sorted(unused_candidates, key=lambda c: _candidate_score(c, cfg), reverse=True)
    for c in ranked:
        if len(picked) >= needed:
            break
        if c["video_id"] in excluded_ids:
            continue
        if c["views"] < cfg["min_candidate_views"]:
            continue
        prior_uses = c.get("used_in", [])
        if prior_uses:
            # вече използвана в друг playlist — разрешено само ако similarity >= threshold
            best_sim = max(_label_similarity(cluster_label, u) for u in prior_uses)
            if best_sim < cfg["cross_playlist_similarity_threshold"]:
                continue
        elif c["video_id"] in used_globally:
            continue  # защитна мрежа — не би трябвало да стигне дотук без used_in запис
        picked.append(c)

    for c in picked:
        c["status"] = "used"
        c.setdefault("used_in", []).append(cluster_label)
    return picked


# ---------------------------------------------------------------------------
# SELF-TRACK ПОЗИЦИОНИРАНЕ (т.15-19) + REORDER (т.17, 20)
# ---------------------------------------------------------------------------

def current_self_ratio(tracks):
    if not tracks:
        return 0.0
    return sum(1 for t in tracks if t.get("is_mine")) / len(tracks)


def choose_self_track_to_insert(my_tracks_pool, tracks_already_in_playlist, min_playlist_size_for_self):
    if len(tracks_already_in_playlist) < min_playlist_size_for_self:
        return None
    used_ids = {t["youtube_video_id"] for t in tracks_already_in_playlist if t.get("is_mine")}
    remaining = [t for t in my_tracks_pool if t["youtube_video_id"] not in used_ids]
    if not remaining:
        return None
    remaining.sort(key=lambda t: t.get("release_date") or "", reverse=True)
    return remaining[0]


def valid_insert_distance(tracks_ordered, candidate_position, min_distance):
    for offset, t in enumerate(tracks_ordered):
        if t.get("is_mine") and abs(offset - candidate_position) <= min_distance:
            return False
    return True


def build_insert_plan(playlist_entry, my_tracks_pool, new_external, cfg):
    """ADD-операции. External → append в края. Self → explicit позиция САМО
    ако distance/ratio constraints са спазени, иначе се отлага (т.18: никога
    не насилвай ratio в малък playlist)."""
    tracks = list(playlist_entry["tracks"])
    ops = []
    excluded = set(playlist_entry.get("excluded_video_ids", []))

    for ext in new_external:
        if ext["video_id"] in excluded:
            continue
        tracks.append({"youtube_video_id": ext["video_id"], "is_mine": False, "title": ext["title"], "added_at": "PENDING"})
        ops.append({"action": "insert", "video_id": ext["video_id"], "is_mine": False, "title": ext["title"], "position": None})

    ratio_min = playlist_entry.get("self_track_ratio_min_override") or cfg.get("self_track_ratio_min", 0)
    ratio_max = playlist_entry.get("self_track_ratio_override") or cfg["self_track_ratio_max"]
    # т.19.08.2026 бъгфикс: self_track_ratio_min (discovery-config.json) беше
    # дефиниран, но никога не се четеше — единствената активна граница беше
    # ratio_max (винаги 1 опит за self-track вмъкване, докато ratio < max).
    # Сега min реално означава нещо: ако сме СЪЩЕСТВЕНО под долната граница
    # ("catch-up" режим), позволяваме до 2 опита за вмъкване в рамките на
    # СЪЩИЯ run, вместо само 1 — иначе поведението остава напълно същото
    # като преди (1 опит, докато ratio < max). min_distance ограничението
    # (valid_insert_distance) важи за ВСЕКИ опит поотделно — т.18 "никога не
    # насилвай ratio в малък playlist" не е засегнато от тази промяна.
    max_attempts = 2 if current_self_ratio(tracks) < ratio_min else 1
    inserted = 0
    while inserted < max_attempts and current_self_ratio(tracks) < ratio_max:
        candidate = choose_self_track_to_insert(my_tracks_pool, tracks, cfg["min_playlist_size_for_self_tracks"])
        if not candidate:
            break
        n = len(tracks)
        search_positions = list(range(max(0, n // 3), n + 1))
        random.shuffle(search_positions)
        for pos in search_positions:
            if valid_insert_distance(tracks, pos, cfg["min_external_between_self"]):
                tracks.insert(pos, {"youtube_video_id": candidate["youtube_video_id"], "is_mine": True,
                                     "title": candidate["title"], "added_at": "PENDING"})
                ops.append({"action": "insert", "video_id": candidate["youtube_video_id"], "is_mine": True,
                            "title": candidate["title"], "position": pos})
                inserted += 1
                break
        else:
            log(f"    ⚪ Отложих моя песен в '{playlist_entry['label']}' — min_distance ограничението "
                f"не позволява безопасна позиция засега.")
            break  # позицията пак ще липсва при следващ опит в СЪЩИЯ run — не зацикляй

    # т.34: forced_video_ids — ръчно принудени песни, добавят се независимо от ratio/discovery,
    # но НЕ заобикалят global каталог логиката (очаква се да е валиден video_id)
    existing_ids = {t["youtube_video_id"] for t in tracks}
    for forced_id in playlist_entry.get("forced_video_ids", []):
        if forced_id not in existing_ids:
            ops.append({"action": "insert", "video_id": forced_id, "is_mine": False, "title": f"(forced) {forced_id}", "position": None})
    return ops


def build_reorder_plan(playlist_entry, cfg):
    """REORDER (т.17/20): само за self-tracks, само ако enable_auto_reorder,
    само ако два self-tracks нарушават min_distance (напр. заради ръчна
    редакция или стар bug) — ограничено до max_reorder_ops_per_playlist_per_run,
    за да не правим ежедневно скъпо пренареждане без реална причина (т.'Не
    променяй playlist всеки ден без причина')."""
    if not cfg.get("enable_auto_reorder", True):
        return []
    tracks = playlist_entry["tracks"]
    min_distance = cfg["min_external_between_self"]
    self_positions = [i for i, t in enumerate(tracks) if t.get("is_mine")]

    ops = []
    for i in range(len(self_positions) - 1):
        a, b = self_positions[i], self_positions[i + 1]
        if b - a <= min_distance and len(ops) < cfg["max_reorder_ops_per_playlist_per_run"]:
            new_pos = min(len(tracks) - 1, a + min_distance + 2)
            if new_pos != b:
                ops.append({"action": "reorder", "video_id": tracks[b]["youtube_video_id"],
                            "title": tracks[b].get("title", ""), "position": new_pos})
    return ops


# ---------------------------------------------------------------------------
# PRUNING (т.14, 18-19) — само external, никога self, никога forced/excluded
# ---------------------------------------------------------------------------

def fetch_video_status_map(video_ids, yt: YouTubeClient, run_log):
    """т.22.08.2026: батчва videos.list?part=status за до 50 ID-та наведнъж
    (API лимит на един повик). Връща {video_id: privacyStatus}; ID-та,
    които изобщо липсват от отговора (изтрити/terminated канал/напълно
    недостъпни за API ключа), НЕ фигурират в резултата — липсата от dict-а
    Е самата сигнализация за 'изчезнало видео', проверявай с 'in status_map'."""
    status_map = {}
    ids = sorted(set(video_ids))
    for i in range(0, len(ids), 50):
        batch = ids[i:i + 50]
        try:
            data = retry(lambda: yt.get("videos", {"part": "status", "id": ",".join(batch)}, "videos.list"),
                          label="videos.list (availability check)")
        except RuntimeError as e:
            log(f"  ⚠ Availability check неуспешен за батч от {len(batch)} видеа: {e}")
            if run_log is not None:
                run_log["warnings"].append(f"Availability check неуспешен: {e}")
            continue
        for item in data.get("items", []):
            status_map[item["id"]] = item.get("status", {}).get("privacyStatus")
    return status_map


def build_availability_prune_plan(playlist_entry, status_map):
    """т.22.08.2026: премахва песни, които вече НЕ са публично достъпни
    (privacyStatus == 'private') или изобщо липсват от YouTube отговора
    (изтрити/terminated канал) — преди тази проверка НИКОГА не се
    правеше след първоначалното добавяне, значи веднъж заседнала
    'счупена' (private/изтрита) песен стоеше в playlist-а завинаги.

    За разлика от build_prune_plan (capacity-базиран, само external),
    тук важи за ВСИЧКИ песни в playlist-а — включително is_mine и
    forced_video_ids — защото private/изтрито видео е технически
    счупено за зрителя независимо от curation статуса; 'unlisted' НЕ се
    трие тук, защото unlisted видео все пак се пуска нормално, когато се
    отвори директно от playlist-а."""
    tracks = playlist_entry["tracks"]
    ops = []
    for t in tracks:
        vid = t["youtube_video_id"]
        status = status_map.get(vid)  # None = липсва изцяло от отговора
        if status is None or status == "private":
            ops.append({"action": "delete", "video_id": vid, "title": t.get("title", ""),
                        "playlist_item_id": t.get("playlist_item_id"),
                        "reason": "deleted-or-inaccessible" if status is None else "private"})
    return ops


def build_prune_plan(playlist_entry, cfg):
    if not cfg.get("enable_auto_removal_of_external_tracks", True):
        return []
    tracks = playlist_entry["tracks"]
    max_size = playlist_entry.get("max_playlist_size_override") or cfg["max_playlist_size"]
    if len(tracks) <= max_size:
        return []
    overflow = len(tracks) - max_size
    # т.19.08.2026 бъгфикс: min_playlist_size (discovery-config.json, UI label
    # "Мин. размер на playlist" в Настройки на Discovery Engine — js/youtube-
    # discovery.js) стоеше дефиниран и дори РЕДАКТИРУЕМ от потребителя през
    # UI-то, но никога не се четеше тук — pruning нямаше долна граница.
    # Огледално на max_playlist_size по-горе: никога не смалявай playlist-а
    # под min_playlist_size, дори overflow над max_size да го позволява.
    min_size = playlist_entry.get("min_playlist_size_override") or cfg.get("min_playlist_size", 0)
    overflow = min(overflow, max(0, len(tracks) - min_size))
    if overflow <= 0:
        return []
    forced = set(playlist_entry.get("forced_video_ids", []))
    removable = [t for t in tracks if not t.get("is_mine") and t["youtube_video_id"] not in forced]
    removable.sort(key=lambda t: t.get("added_at") or "")  # най-старите (least fresh) първи
    to_remove = removable[:overflow]
    return [{"action": "delete", "video_id": t["youtube_video_id"], "title": t.get("title", ""),
             "playlist_item_id": t.get("playlist_item_id")} for t in to_remove]


# ---------------------------------------------------------------------------
# ПРИЛАГАНЕ НА DIFF + VERIFICATION (т.20-25)
# ---------------------------------------------------------------------------

def apply_ops(playlist_entry, ops, yt: YouTubeClient, dry_run, run_log):
    applied, failed = [], []
    playlist_id = playlist_entry["youtube_playlist_id"]
    now = _iso(_now())

    for op in ops:
        if dry_run:
            log(f"    🧪 [DRY RUN] {op['action']} → '{op.get('title', op['video_id'])}'"
                f"{' (моя)' if op.get('is_mine') else ''}")
            applied.append({**op, "dry_run": True, "at": now})
            continue
        if not yt.can_write:
            log(f"    ⚠ Пропускам {op['action']} '{op.get('title')}' — няма OAuth access (read-only run).")
            continue
        try:
            if op["action"] == "insert":
                body = {"snippet": {"playlistId": playlist_id, "resourceId": {"kind": "youtube#video", "videoId": op["video_id"]}}}
                if op.get("position") is not None:
                    body["snippet"]["position"] = op["position"]
                result = retry(lambda: yt.write("playlistItems", {"part": "snippet"}, body, "playlistItems.insert"),
                                label=f"добавяне на '{op.get('title')}'")
                op["playlist_item_id"] = result.get("id")
            elif op["action"] == "delete":
                item_id = op.get("playlist_item_id")
                if not item_id:
                    log(f"    ⚠ Пропускам delete за '{op.get('title')}' — липсва playlist_item_id.")
                    continue
                retry(lambda: yt.delete("playlistItems", {"id": item_id}, "playlistItems.delete"),
                      label=f"премахване на '{op.get('title')}'")
            elif op["action"] == "reorder":
                item_id = next((t.get("playlist_item_id") for t in playlist_entry["tracks"] if t["youtube_video_id"] == op["video_id"]), None)
                if not item_id:
                    continue
                body = {"id": item_id, "snippet": {"playlistId": playlist_id,
                        "resourceId": {"kind": "youtube#video", "videoId": op["video_id"]}, "position": op["position"]}}
                retry(lambda: yt.write("playlistItems", {"part": "snippet"}, body, "playlistItems.update", method="PUT"),
                      label=f"пренареждане на '{op.get('title')}'")
            applied.append({**op, "dry_run": False, "at": now})
        except RuntimeError as e:
            log(f"    ❌ Грешка при {op['action']} '{op.get('title')}': {e}")
            failed.append({**op, "error": str(e), "at": now})
            run_log["errors"].append({"playlist": playlist_entry["cluster_key"], "op": op["action"],
                                       "video_id": op.get("video_id"), "error": str(e), "at": now})
    return applied, failed


def verify_playlist_state(playlist_id, expected_inserted_ids, expected_removed_ids, yt: YouTubeClient, run_log, label):
    """т.25: не приемай write за успешен само защото request е изпратен —
    прочети реалното състояние и сравни. Несъответствия → warning, не hard fail
    (следващият run ще ги хване през нормалния diff engine пак)."""
    if not (expected_inserted_ids or expected_removed_ids):
        return
    try:
        data = retry(lambda: yt.get("playlistItems", {"part": "snippet", "playlistId": playlist_id, "maxResults": 50},
                                     "playlistItems.list"), label="verification playlistItems.list")
        live_ids = {i["snippet"]["resourceId"]["videoId"] for i in data.get("items", [])}
    except RuntimeError as e:
        run_log["warnings"].append(f"Verification неуспешна за '{label}': {e}")
        return

    missing = [vid for vid in expected_inserted_ids if vid not in live_ids]
    still_present = [vid for vid in expected_removed_ids if vid in live_ids]
    if missing:
        run_log["warnings"].append(f"Verification: '{label}' — {len(missing)} добавени видеа не се виждат все още в playlist-а.")
    if still_present:
        run_log["warnings"].append(f"Verification: '{label}' — {len(still_present)} видеа, чието премахване бе заявено, все още присъстват.")


def fetch_playlist_items(playlist_id, yt: YouTubeClient):
    items, page_token = [], None
    while True:
        params = {"part": "snippet", "playlistId": playlist_id, "maxResults": 50}
        if page_token:
            params["pageToken"] = page_token
        data = retry(lambda: yt.get("playlistItems", params, "playlistItems.list"), label="playlistItems.list")
        for it in data.get("items", []):
            sn = it["snippet"]
            items.append({"playlist_item_id": it["id"], "video_id": sn["resourceId"]["videoId"],
                          "title": sn.get("title", ""), "position": sn.get("position")})
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return items


# ---------------------------------------------------------------------------
# LEARNING LOOP (т.26-28)
# ---------------------------------------------------------------------------

def update_track_performance(state):
    perf = load_json(PERF_PATH, {"schema_version": 1, "entries": []})
    stats = load_json(STATS_PATH, {"snapshots": []})
    latest_snap = stats["snapshots"][-1] if stats.get("snapshots") else None
    views_by_id = {v["video_id"]: v.get("views", 0) for v in (latest_snap or {}).get("videos", [])}

    entries_by_key = {(e["video_id"], e["playlist"]): e for e in perf["entries"]}
    for pl in state["playlists"]:
        for t in pl["tracks"]:
            if not t.get("is_mine") or t.get("added_at") in (None, "PENDING"):
                continue
            key = (t["youtube_video_id"], pl["cluster_key"])
            age_days = _age_days(t["added_at"])
            current_views = views_by_id.get(t["youtube_video_id"])
            if current_views is None or age_days is None:
                continue

            entry = entries_by_key.get(key)
            if not entry:
                entry = {"video_id": t["youtube_video_id"], "playlist": pl["cluster_key"],
                          "position_added": t.get("position"), "added_at": t["added_at"],
                          "views_before": current_views, "views_24h": None, "views_7d": None,
                          "views_30d": None, "lift_estimate": None}
                perf["entries"].append(entry)
                entries_by_key[key] = entry
                continue

            if age_days >= 1 and entry["views_24h"] is None:
                entry["views_24h"] = current_views
            if age_days >= 7 and entry["views_7d"] is None:
                entry["views_7d"] = current_views
            if age_days >= 30 and entry["views_30d"] is None:
                entry["views_30d"] = current_views

            if entry["views_7d"] is not None and entry["views_before"] is not None:
                rate = (entry["views_7d"] - entry["views_before"]) / 7
                entry["lift_estimate"] = {
                    "value": round(rate, 1), "unit": "views/day since added",
                    "confidence": "low" if entry["views_30d"] is None else "medium",
                    "note": "Correlation/lift estimate спрямо views преди добавянето — НЕ доказана причинност. "
                            "Изисква минимален sample size, за да се ползва за repositioning (т.28).",
                }
    save_json(PERF_PATH, perf)


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cfg = load_json(CONFIG_PATH, {})
    dry_run = args.dry_run or cfg.get("dry_run_default", False)
    run_id = str(uuid.uuid4())[:8]
    run_started = _iso(_now())
    run_log = {
        "run_id": run_id, "started_at": run_started, "dry_run": dry_run,
        "status": "running", "new_own_tracks": 0, "clusters_changed": [],
        "playlists_created": 0, "tracks_added": 0, "tracks_removed": 0,
        "tracks_reordered": 0, "candidate_searches": 0, "no_changes": False,
        "errors": [], "warnings": [],
    }

    check_soft_lock(cfg.get("job_lock_ttl_minutes", 30))
    write_soft_lock()
    try:
        _run(cfg, dry_run, run_log)
    finally:
        release_soft_lock()


def _run(cfg, dry_run, run_log):
    if cfg.get("paused"):
        log("⏸️ Discovery Engine е на пауза (data/discovery-config.json → paused=true) — нищо не правя.")
        run_log["status"] = "paused"
        _append_run_log(run_log)
        return

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        log("::error::Липсва YOUTUBE_API_KEY.")
        run_log["status"] = "error"
        run_log["errors"].append({"error": "Липсва YOUTUBE_API_KEY"})
        _append_run_log(run_log)
        sys.exit(1)

    access_token = None if dry_run else get_oauth_access_token()
    if not dry_run and not access_token:
        log("⚠ Няма OAuth access token — READ-ONLY режим (анализ + лог, без писане в YouTube). "
            "Виж README.md → 'Еднократен OAuth setup'.")

    quota = QuotaBudget(cfg.get("youtube_search_daily_budget_units", 3000))
    yt = YouTubeClient(api_key, access_token, quota)

    root_cfg = load_json(ROOT_CONFIG_PATH, {})
    own_channel_id = root_cfg.get("youtube_channel_id") or root_cfg.get("CHANNEL_ID")
    if not own_channel_id:
        log("  ⚠ Липсва youtube_channel_id в config.json — self-exclusion филтърът за "
            "external кандидати НЯМА да работи този run (риск от собствени видеа в discovery резултатите).")

    releases_video_ids = load_releases_video_ids(cfg)
    if not releases_video_ids:
        log("  ⚠ Releases списъкът е празен/недостъпен — self-track insertion ще бъде пропуснат този run "
            "(няма да се вкарват мои песни, докато не се оправи).")
    else:
        log(f"  ℹ️ Releases пул (self-track source of truth): {len(releases_video_ids)} video ID-та "
            f"заредени от {cfg.get('releases_url', '(няма url)')}.")

    log("→ Синхронизирам каталога с нови видеа от канала...")
    added_count, catalog = sync_new_tracks(releases_video_ids)
    run_log["new_own_tracks"] = added_count

    clusters = cluster_catalog(catalog["tracks"], cfg["min_cluster_size"])
    log(f"→ {len(clusters)} значими клъстера: {[c['label'] for c in clusters.values()]}")

    state = load_json(STATE_PATH, {"schema_version": 1, "playlists": []})
    state.setdefault("playlists", [])
    cache = load_json(CACHE_PATH, {"schema_version": 1, "clusters": {}})
    cache.setdefault("clusters", {})

    # т.22.08.2026: единична batch проверка за наличност на ВСИЧКИ песни,
    # вече седящи във всички playlist-и (не само тези, добавени този run) —
    # видеа станали 'private' или изтрити СЛЕД добавянето никога не се
    # преоткриваха от старата логика, значи си стояха завинаги.
    all_current_video_ids = {t["youtube_video_id"] for p in state["playlists"] for t in p.get("tracks", [])}
    video_status_map = fetch_video_status_map(all_current_video_ids, yt, run_log) if all_current_video_ids else {}

    for cluster_key, cluster in clusters.items():
        label = cluster["label"]
        log(f"\n── Клъстер: {label} ({len(cluster['tracks'])} мои песни) ──")
        if releases_video_ids:
            eligible = [t for t in cluster["tracks"] if t["youtube_video_id"] in releases_video_ids]
            not_eligible = [t for t in cluster["tracks"] if t["youtube_video_id"] not in releases_video_ids]
            log(f"    ℹ️ Self-track pool за '{label}': {len(eligible)}/{len(cluster['tracks'])} "
                f"песни са в Releases таба.")
            if not_eligible:
                sample = ", ".join(t.get("title", t["youtube_video_id"])[:40] for t in not_eligible[:5])
                log(f"    ℹ️ НЕ са в Releases (значи няма да се self-insert-ват): {sample}"
                    + (" ..." if len(not_eligible) > 5 else ""))

        entry, is_new = find_or_create_playlist(cluster_key, label, state, yt, dry_run, cfg)
        if entry is None:
            continue
        if is_new:
            state["playlists"].append(entry)
            run_log["playlists_created"] += 1

        if entry.get("disabled"):
            log("  ⏸️ Playlist е disabled (manual override) — пропускам изцяло.")
            continue
        if entry.get("locked"):
            log("  🔒 Playlist е locked (manual override) — без промени тази сесия, само performance tracking.")
            continue

        # синхронизирай локалния track-списък с истинското състояние в YouTube
        if entry["youtube_playlist_id"] not in (None, "DRY_RUN_PENDING") and yt.api_key:
            try:
                live_items = fetch_playlist_items(entry["youtube_playlist_id"], yt)
                by_id = {t["youtube_video_id"]: t for t in entry["tracks"]}
                entry["tracks"] = [
                    {**by_id.get(it["video_id"], {}), "youtube_video_id": it["video_id"], "title": it["title"],
                     "playlist_item_id": it["playlist_item_id"],
                     "is_mine": by_id.get(it["video_id"], {}).get("is_mine", False),
                     "added_at": by_id.get(it["video_id"], {}).get("added_at", "unknown")}
                    for it in live_items
                ]
            except RuntimeError as e:
                log(f"  ⚠ Не успях да прочета текущото съдържание: {e} — работя с локалния state.")
                run_log["warnings"].append(f"Не успях да прочета '{label}' от YouTube: {e}")

        used_globally = {t["youtube_video_id"] for p in state["playlists"] for t in p["tracks"]}
        excluded_ids = set(entry.get("excluded_video_ids", []))
        unused_candidates, _ = refresh_candidate_pool(cluster_key, label, cache, yt, cfg, run_log, own_channel_id)
        new_external = pick_candidates_for_playlist(cluster_key, label, unused_candidates, cache, cfg,
                                                      used_globally, excluded_ids,
                                                      needed=cfg.get("external_tracks_per_run", 5))

        # Единствен източник на истина за "моя песен" вече е releases табът
        # на канала (yt-dlp, кеширан в releases_video_ids по-горе) — НЕ
        # description-marker евристика. Обикновени видео ъплоуди (Shorts,
        # visualizer, тийзъри), които не са в releases списъка, никога не
        # влизат в пула, дори да имат разпозната дистрибуция.
        my_release_pool = [t for t in cluster["tracks"] if t["youtube_video_id"] in releases_video_ids]
        insert_ops = build_insert_plan(entry, my_release_pool, new_external, cfg)
        reorder_ops = build_reorder_plan(entry, cfg)
        prune_ops = build_prune_plan(entry, cfg)
        availability_prune_ops = build_availability_prune_plan(entry, video_status_map)
        if availability_prune_ops:
            log(f"  🧹 {len(availability_prune_ops)} песен(ни) вече не са публично достъпни "
                f"(private/изтрити) — премахвам от playlist-а.")
        ops = insert_ops + reorder_ops + prune_ops + availability_prune_ops

        if not ops:
            log("  ✅ Няма промяна за този playlist днес (NO CHANGES).")
            continue

        run_log["clusters_changed"].append(cluster_key)
        applied, failed = apply_ops(entry, ops, yt, dry_run, run_log)

        inserted_ids, removed_ids = [], []
        for op in applied:
            if op["action"] == "insert":
                inserted_ids.append(op["video_id"])
                if not dry_run:
                    entry["tracks"].append({"youtube_video_id": op["video_id"], "is_mine": op["is_mine"],
                                            "title": op.get("title", ""), "added_at": op["at"],
                                            "playlist_item_id": op.get("playlist_item_id")})
                    run_log["tracks_added"] += 1
                entry["history"].append({"date": op["at"], "action": "added", "video_id": op["video_id"],
                                         "is_mine": op.get("is_mine", False), "dry_run": op["dry_run"]})
            elif op["action"] == "delete":
                removed_ids.append(op["video_id"])
                if not dry_run:
                    entry["tracks"] = [t for t in entry["tracks"] if t["youtube_video_id"] != op["video_id"]]
                    run_log["tracks_removed"] += 1
                entry["history"].append({"date": op["at"], "action": "removed", "video_id": op["video_id"], "dry_run": op["dry_run"]})
            elif op["action"] == "reorder":
                if not dry_run:
                    run_log["tracks_reordered"] += 1
                entry["history"].append({"date": op["at"], "action": "reordered", "video_id": op["video_id"], "dry_run": op["dry_run"]})

        entry["history"] = entry["history"][-100:]
        entry["last_updated"] = _iso(_now())

        if not dry_run and entry["youtube_playlist_id"] not in (None, "DRY_RUN_PENDING"):
            verify_playlist_state(entry["youtube_playlist_id"], inserted_ids, removed_ids, yt, run_log, label)

    save_json(CACHE_PATH, cache)

    if not dry_run:
        try:
            update_track_performance(state)
        except Exception as e:
            log(f"⚠ Learning loop update неуспешен: {e}")
            run_log["warnings"].append(f"Learning loop грешка: {e}")

    state["last_run"] = run_log["started_at"]
    state["last_run_status"] = "dry_run" if dry_run else ("error" if run_log["errors"] else "ok")
    if not dry_run:
        save_json(STATE_PATH, state)
    else:
        save_json(DATA_DIR / "discovery-dry-run-preview.json", state)

    run_log["no_changes"] = not run_log["clusters_changed"]
    run_log["status"] = "ok" if not run_log["errors"] else "partial_failure"
    run_log["quota_spent_units"] = quota.spent
    run_log["quota_calls"] = quota.calls
    _append_run_log(run_log)

    log(f"\n✅ Run {run_log['run_id']} завършен. Playlist-и: +{run_log['playlists_created']} нови, "
        f"песни: +{run_log['tracks_added']} / -{run_log['tracks_removed']} / ~{run_log['tracks_reordered']} пренаредени. "
        f"Quota: ~{quota.spent} units. {'ПРАЗЕН DIFF (no changes).' if run_log['no_changes'] else ''}")


def _append_run_log(run_log):
    data = load_json(LOG_PATH, {"schema_version": 1, "runs": []})
    data.setdefault("runs", [])
    data["runs"].append(run_log)
    data["runs"] = data["runs"][-MAX_LOG_RUNS:]
    save_json(LOG_PATH, data)


if __name__ == "__main__":
    main()
