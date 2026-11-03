#!/usr/bin/env python3
"""
top100_kyuchek.py — умен плейлист "Топ 100 кючеци" (обновява се всеки ден в 07:00 ч. българско време)
========================================================================================================
Пуска се от .github/workflows/top100-kyuchek.yml (cron + workflow_dispatch).

КАК РАБОТИ
  1. ЗАЯВКИ: ВСЕКИ конфигуриран AI агент предлага YouTube заявки за кючеци (обединяват се, най-често
     предложените печелят) + няколко фиксирани, ротиращи по дни. AI агентите не могат да търсят в
     YouTube — търси YouTube Data API с тези заявки (по гледания и по дата).
  2. ФИЛТЪР: правила (дължина, минимум гледания, възраст, компилации/MIX/караоке) режат шума.
  3. ГЛАСУВАНЕ: ВСЕКИ AI агент независимо казва кои нови кандидати са истински единични кючеци.
     Приема се при достатъчно мнозинство (min_yes_ratio). Резултатът се помни — един кандидат се гласува
     веднъж. Ако нито един агент не е достъпен — пада на ключови думи в заглавието.
  4. МОИ ПЕСНИ: каталогът (data/catalog.json) добавя моите кючеци и те участват по ОБЩИТЕ правила
     (същият минимум гледания/дължина, същата формула). Без AI гласуване — вече са известни.
  5. КЛАСИРАНЕ (детерминирано, не от AI): score = views_weight * лог.гледания + freshness_weight * свежест,
     свежест = 0.5 ** (възраст / half_life). Първо най-гледаните и най-новите.
  6. ПЛЕЙЛИСТ: диф с минимален брой операции (LIS — това, което вече е в правилен относителен ред,
     не се пипа). Всяка операция е 50 quota единици, затова има дневен бюджет; ако не стига, плейлистът
     се доизгражда на следващия ден (най-високо класираните първи).

ВРЕМЕ: cron на GitHub е само в UTC и не знае за лятно/зимно часово време → workflow-ът пуска два cron-а
  (04:00 и 05:00 UTC), а този скрипт пуска реалната работа само ако в Europe/Sofia часът е в прозореца
  [run_hour_local, run_hour_local + run_window_hours) и още не е правено днес. GitHub може да забави
  scheduled run с 5-60 мин — затова има прозорец, а не точна минута.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import (  # noqa: E402
    DATA_DIR, REPO_ROOT, QuotaBudget, YouTubeClient,
    call_ai_all_json, get_oauth_access_token, load_json, log, retry, save_json,
)

CONFIG_PATH = DATA_DIR / "top100-config.json"
STATE_PATH = DATA_DIR / "top100-state.json"
LOG_PATH = DATA_DIR / "top100-log.json"
PREVIEW_PATH = DATA_DIR / "top100-dry-run-preview.json"
CATALOG_PATH = DATA_DIR / "catalog.json"
ROOT_CONFIG_PATH = REPO_ROOT / "config.json"
MAX_LOG_RUNS = 60

DEFAULTS = {
    "enabled": True,
    "playlist_id": None,                  # ако вече имаш такъв плейлист — сложи ID-то му тук
    "playlist_title": "Топ 100 кючеци",
    "playlist_description": (
        "Класация на най-гледаните и най-нови кючеци в YouTube. Обновява се автоматично всеки ден в 07:00 ч. "
        "Подредба: гледания и дата на качване."
    ),
    "privacy": "public",
    "size": 100,
    "timezone": "Europe/Sofia",
    "run_hour_local": 7,
    "run_window_hours": 3,
    # кандидати
    "max_age_days": 365,                  # външни видеа по-стари от това не участват (моите — по избор, виж долу)
    "own_ignore_max_age": True,           # мои песни участват независимо от възрастта (конкурират се по score)
    "min_views": 1000,
    "min_duration_seconds": 120,
    "max_duration_seconds": 600,
    "include_own": True,
    "own_keywords": ["кючек", "кючеци", "kuchek", "kyuchek", "kiuchek"],
    # класиране
    "score": {"views_weight": 0.6, "freshness_weight": 0.4, "freshness_half_life_days": 60},
    # търсене
    "seed_queries": ["кючек", "кючек 2026", "нов кючек", "кючеци хитове", "kuchek", "кючек оркестър",
                     "кючек official", "кючек instrumental"],
    "seed_queries_per_run": 3,
    "ai_queries_per_agent": 4,
    "ai_queries_used_per_run": 3,
    "recent_window_days": 21,             # прозорец за заявките "по дата" (хваща нови, още без много гледания)
    "search_results_per_query": 50,
    # AI гласуване
    "ai_vote": {"enabled": True, "min_yes_ratio": 0.6, "batch_size": 40, "include_pollinations": False},
    "block_patterns": [r"\bmix\b", r"compilation", r"сборка", r"\bтоп\s*\d+", r"\btop\s*\d+", r"караоке", r"karaoke",
                       r"\b\d+\s*(hours?|час(а|ове)?)\b", r"nonstop", r"нон\s*стоп", r"reaction", r"tutorial",
                       r"type beat", r"#shorts", r"\bshorts?\b", r"nightcore", r"playlist", r"плейлист"],
    # квота
    "daily_quota_units": 3000,
    "max_ops_per_run": 80,
    "pool_max_size": 1500,
    "max_insert_failures": 2,
}


# ---------------------------------------------------------------------------
# КОНФИГ / ВРЕМЕ
# ---------------------------------------------------------------------------

def merged_config(user):
    cfg = {**DEFAULTS, **(user or {})}
    for k in ("score", "ai_vote"):
        cfg[k] = {**DEFAULTS[k], **((user or {}).get(k) or {})}
    return cfg


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def local_now(now_utc, tz_name):
    return now_utc.astimezone(ZoneInfo(tz_name))


def should_run(now_utc, cfg, last_done_local_date, force=False):
    """(bool, причина). force (ръчно пускане) винаги минава. Иначе: часът в Europe/Sofia трябва да е в
    прозореца и още да не е успешно обновено днес (локална дата)."""
    if force:
        return True, "ръчно пускане"
    loc = local_now(now_utc, cfg["timezone"])
    start = int(cfg["run_hour_local"])
    end = start + int(cfg["run_window_hours"])
    if not (start <= loc.hour < end):
        return False, f"локалният час е {loc:%H:%M} ({cfg['timezone']}), очакван прозорец {start:02d}:00–{end:02d}:00"
    if last_done_local_date == loc.date().isoformat():
        return False, f"днес ({loc.date().isoformat()}) вече е обновено"
    return True, f"{loc:%Y-%m-%d %H:%M} {cfg['timezone']}"


# ---------------------------------------------------------------------------
# КЛАСИРАНЕ
# ---------------------------------------------------------------------------

def parse_duration_seconds(iso):
    m = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", iso or "")
    if not m or not any(m.groups()):
        return None
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def age_days(published_at, now):
    dt = _parse_iso(published_at)
    return max(0.0, (now - dt).total_seconds() / 86400) if dt else None


def freshness(age, half_life_days):
    """1.0 за днешно видео, 0.5 след half_life дни, ... Неизвестна възраст → 0.3 (неутрално-ниско)."""
    if age is None:
        return 0.3
    return 0.5 ** (age / max(1.0, float(half_life_days)))


def rank_candidates(cands, cfg, now):
    """cands: [{video_id, views, published_at, ...}] → същите, подредени, с rank и score.
    views_score = логаритмично нормализирани гледания (0..1) спрямо най-ниския/най-високия в набора."""
    if not cands:
        return []
    w = cfg["score"]
    logs = [math.log10(c.get("views", 0) + 1) for c in cands]
    lo, hi = min(logs), max(logs)
    span = hi - lo
    out = []
    for c, lg in zip(cands, logs):
        v = 1.0 if span == 0 else (lg - lo) / span
        f = freshness(age_days(c.get("published_at"), now), w["freshness_half_life_days"])
        out.append({**c, "score": round(w["views_weight"] * v + w["freshness_weight"] * f, 6)})
    out.sort(key=lambda c: (-c["score"], -c.get("views", 0), c.get("published_at") or "", c["video_id"]))
    for i, c in enumerate(out, 1):
        c["rank"] = i
    return out


# ---------------------------------------------------------------------------
# ФИЛТРИ
# ---------------------------------------------------------------------------

def _norm_title(title):
    t = re.sub(r"#\S+", " ", title or "")
    t = t.split(" | ")[0]
    return re.sub(r"[\W_]+", " ", t.lower(), flags=re.UNICODE).strip()


def title_blocked(title, cfg):
    low = (title or "").lower()
    return any(re.search(p, low) for p in cfg["block_patterns"])


def passes_rules(c, cfg, now, is_own=False):
    """Правила за ВСЕКИ кандидат (и мои, и външни). Връща (bool, причина)."""
    d = c.get("duration_seconds")
    if d is not None and (d < cfg["min_duration_seconds"] or d > cfg["max_duration_seconds"]):
        return False, "дължина"
    if c.get("views", 0) < cfg["min_views"]:
        return False, "гледания"
    if title_blocked(c.get("title"), cfg) and not c.get("distribution") == "distrokid":
        return False, "заглавие"
    age = age_days(c.get("published_at"), now)
    if age is not None and age > cfg["max_age_days"] and not (is_own and cfg["own_ignore_max_age"]):
        return False, "възраст"
    return True, ""


def title_has_keyword(title, cfg):
    low = (title or "").lower()
    return any(k.lower() in low for k in cfg["own_keywords"])


# ---------------------------------------------------------------------------
# AI: ЗАЯВКИ + ГЛАСУВАНЕ (всички агенти)
# ---------------------------------------------------------------------------

QUERY_SYSTEM = (
    "Ти си експерт по българска и балканска музика и по YouTube търсене. Върни САМО валиден JSON."
)


def merge_queries(per_agent_lists, limit):
    """Обединява заявки от всички агенти: нормализира, маха дубликати, подрежда по брой агенти, които са
    я предложили (консенсусът първи), после по реда на поява."""
    counts, order = {}, []
    for lst in per_agent_lists:
        seen_here = set()
        for q in lst:
            n = re.sub(r"\s+", " ", str(q)).strip().lower()
            if not n or len(n) > 80 or n in seen_here:
                continue
            seen_here.add(n)
            if n not in counts:
                counts[n] = 0
                order.append(n)
            counts[n] += 1
    order.sort(key=lambda q: -counts[q])   # sort е стабилен → при равенство остава реда на поява
    return order[:limit]


def ai_generate_queries(cfg):
    n = int(cfg["ai_queries_per_agent"])
    user = (f"Дай {n} различни заявки за търсене в YouTube, с които да се намерят НАЙ-ГЛЕДАНИТЕ и НАЙ-НОВИТЕ "
            "български кючеци (кючек, кючек оркестър, балкански кючек, поп-фолк кючек). Смесвай кирилица и "
            "латиница (kuchek/kyuchek), годината 2026, имена на популярни изпълнители/оркестри, ако ги знаеш. "
            'Формат: {"queries": ["...", "..."]}. Не измисляй несъществуващи изпълнители.')
    results = call_ai_all_json(QUERY_SYSTEM, user, 400, cfg["ai_vote"]["include_pollinations"])
    lists, agents = [], []
    for name, res in results:
        qs = res.get("queries") if isinstance(res, dict) else res if isinstance(res, list) else None
        if isinstance(qs, list) and qs:
            lists.append([q for q in qs if isinstance(q, str)])
            agents.append(name)
    return merge_queries(lists, int(cfg["ai_queries_used_per_run"])), agents


def rotate_seed_queries(cfg, today):
    seeds = cfg["seed_queries"]
    n = max(1, min(int(cfg["seed_queries_per_run"]), len(seeds)))
    start = (today.timetuple().tm_yday * n) % len(seeds)
    return [seeds[(start + i) % len(seeds)] for i in range(n)]


VOTE_SYSTEM = (
    "Ти си строг експерт по българска музика. Отговаряш САМО с валиден JSON, без обяснения."
)


def build_vote_prompt(batch):
    lines = [f'{i}. "{c["title"]}" — канал: {c.get("channel", "?")} — {c.get("duration_seconds", "?")}s'
             for i, c in enumerate(batch)]
    return (
        "По-долу са YouTube видеа. Върни индексите на тези, които са ЕДНА истинска песен/инструментал в стил "
        "КЮЧЕК (български/балкански кючек, вкл. поп-фолк и оркестрови кючеци).\n"
        "НЕ приемай: компилации, MIX-ове, сборки, плейлисти, караоке, уроци, реакции, Shorts/откъси, DJ сетове, "
        "бийтове без песен, други жанрове (рап, поп, реге и др.), видеа, които не са музика.\n"
        'Формат: {"yes": [индекси]}. Ако нито едно не е подходящо: {"yes": []}.\n\n' + "\n".join(lines)
    )


def parse_vote(res, n):
    """Извлича множество валидни индекси от отговора на агента; None ако формата е негоден."""
    if isinstance(res, dict):
        res = res.get("yes", res.get("indices", res.get("accepted")))
    if not isinstance(res, list):
        return None
    out = set()
    for x in res:
        try:
            i = int(x)
        except (TypeError, ValueError):
            continue
        if 0 <= i < n:
            out.add(i)
    return out


def consensus(yes_count, total_voters, min_ratio):
    """Мнозинство от отговорилите агенти. Без нито един глас → None (извикващият ползва резерва)."""
    if total_voters <= 0:
        return None
    return yes_count / total_voters >= min_ratio


def ai_vote_batch(batch, cfg):
    """→ ([(yes_count, total_voters)] по индекс, [имена на агентите, отговорили])."""
    prompt = build_vote_prompt(batch)
    results = call_ai_all_json(VOTE_SYSTEM, prompt, 600, cfg["ai_vote"]["include_pollinations"])
    yes = [0] * len(batch)
    voters = []
    for name, res in results:
        picked = parse_vote(res, len(batch))
        if picked is None:
            log(f"  ⚪ {name}: невалиден формат на гласа — игнориран.")
            continue
        voters.append(name)
        for i in picked:
            yes[i] += 1
    return [(y, len(voters)) for y in yes], voters


# ---------------------------------------------------------------------------
# ПЛЕЙЛИСТ ДИФ (минимален брой операции)
# ---------------------------------------------------------------------------

def lis_indices(seq):
    """Индекси на най-дългата строго нарастваща подредица (O(n log n)). Те остават на мястото си."""
    if not seq:
        return set()
    import bisect
    tails, tails_idx, prev = [], [], [-1] * len(seq)
    for i, v in enumerate(seq):
        pos = bisect.bisect_left(tails, v)
        if pos == len(tails):
            tails.append(v)
            tails_idx.append(i)
        else:
            tails[pos] = v
            tails_idx[pos] = i
        prev[i] = tails_idx[pos - 1] if pos > 0 else -1
    out, k = set(), tails_idx[-1]
    while k != -1:
        out.add(k)
        k = prev[k]
    return out


def plan_playlist_ops(current, target_ids):
    """current: [{"video_id", "item_id"}] в реалния ред; target_ids: желаният ред.
    Връща ops в ред на прилагане: първо delete, после insert/move във възходящ target ред.
    Всяка позиция е валидна при последователно прилагане (симулираме списъка)."""
    target_set = set(target_ids)
    ops = []
    sim = []
    for it in current:
        if it["video_id"] in target_set:
            sim.append(it)
        else:
            ops.append({"action": "delete", "video_id": it["video_id"], "item_id": it.get("item_id")})
    rank = {v: i for i, v in enumerate(target_ids)}
    # дубликати на едно и също видео в плейлиста: пазим първото, останалите се трият
    seen, dedup = set(), []
    for it in sim:
        if it["video_id"] in seen:
            ops.append({"action": "delete", "video_id": it["video_id"], "item_id": it.get("item_id")})
        else:
            seen.add(it["video_id"])
            dedup.append(it)
    sim = dedup
    stable_pos = lis_indices([rank[it["video_id"]] for it in sim])
    stable_ids = {sim[i]["video_id"] for i in stable_pos}
    sim_ids = [it["video_id"] for it in sim]
    items = {it["video_id"]: it for it in sim}
    for i, vid in enumerate(target_ids):
        if vid in stable_ids:
            continue
        if vid in items:   # съществува, но е на грешно място → move
            sim_ids.remove(vid)
            pos = 0 if i == 0 else sim_ids.index(target_ids[i - 1]) + 1
            sim_ids.insert(pos, vid)
            ops.append({"action": "move", "video_id": vid, "item_id": items[vid].get("item_id"), "position": pos})
        else:              # нов → insert
            pos = 0 if i == 0 else sim_ids.index(target_ids[i - 1]) + 1
            sim_ids.insert(pos, vid)
            ops.append({"action": "insert", "video_id": vid, "position": pos})
    return ops


def simulate_ops(current_ids, ops):
    """Прилага ops върху списък от video_id (за тестове/проверка)."""
    ids = list(current_ids)
    for op in ops:
        if op["action"] == "delete":
            ids.remove(op["video_id"])
        elif op["action"] == "move":
            ids.remove(op["video_id"])
            ids.insert(op["position"], op["video_id"])
        elif op["action"] == "insert":
            ids.insert(op["position"], op["video_id"])
    return ids


def cap_ops(ops, max_ops, budget_units, cost_per_op=50):
    """Ограничава операциите по брой и по оставащата квота. Редът е важен: първо delete, после най-горните
    места — прекъсване по средата оставя валиден плейлист с най-високо класираните най-напред."""
    afford = max(0, int(budget_units // cost_per_op))
    limit = min(max_ops, afford)
    return ops[:limit], max(0, len(ops) - limit)


# ---------------------------------------------------------------------------
# YOUTUBE ПОМОЩНИ
# ---------------------------------------------------------------------------

def video_to_cand(v):
    sn, st = v.get("snippet", {}), v.get("statistics", {})
    return {
        "video_id": v["id"], "title": sn.get("title", ""), "channel": sn.get("channelTitle", ""),
        "channel_id": sn.get("channelId", ""), "published_at": sn.get("publishedAt", ""),
        "views": int(st.get("viewCount", 0) or 0),
        "duration_seconds": parse_duration_seconds(v.get("contentDetails", {}).get("duration")),
    }


def fetch_videos(ids, yt):
    """videos.list на порции по 50 (1 unit на порция). Липсващите в отговора (изтрити/private) не се връщат."""
    out = {}
    ids = list(dict.fromkeys(ids))
    for i in range(0, len(ids), 50):
        data = retry(lambda b=ids[i:i + 50]: yt.get(
            "videos", {"part": "snippet,statistics,contentDetails", "id": ",".join(b)}, "videos.list"),
            label="videos.list")
        for v in data.get("items", []):
            out[v["id"]] = video_to_cand(v)
    return out


def search_ids(query, yt, order, published_after, max_results):
    params = {"part": "id", "type": "video", "videoCategoryId": "10", "order": order, "q": query,
              "maxResults": max_results, "regionCode": "BG", "relevanceLanguage": "bg"}
    if published_after:
        params["publishedAfter"] = published_after
    data = retry(lambda: yt.get("search", params, "search.list"), label=f"search.list('{query}')")
    return [i["id"]["videoId"] for i in data.get("items", []) if i.get("id", {}).get("videoId")]


def fetch_playlist_items(playlist_id, yt):
    items, token = [], None
    while True:
        params = {"part": "snippet", "playlistId": playlist_id, "maxResults": 50}
        if token:
            params["pageToken"] = token
        data = retry(lambda p=params: yt.get("playlistItems", p, "playlistItems.list"), label="playlistItems.list")
        for it in data.get("items", []):
            vid = it.get("snippet", {}).get("resourceId", {}).get("videoId")
            if vid:
                items.append({"video_id": vid, "item_id": it["id"]})
        token = data.get("nextPageToken")
        if not token:
            return items


# ---------------------------------------------------------------------------
# МОИ ПЕСНИ
# ---------------------------------------------------------------------------

def own_kyuchek_ids(catalog_tracks, cfg):
    """Мои песни от каталога, разпознати като кючек (заглавие/тагове/subgenre) → {video_id: distribution}."""
    out = {}
    for t in catalog_tracks:
        hay = " ".join([str(t.get("title") or ""), str(t.get("subgenre") or ""), str(t.get("genre") or ""),
                        " ".join(str(x) for x in (t.get("style_tags") or []))]).lower()
        if any(k.lower() in hay for k in cfg["own_keywords"]):
            out[t["youtube_video_id"]] = t.get("distribution")
    return out


def dedupe_own(cands):
    """Един и същ релийз и ъплоуд (еднакво нормализирано заглавие) — остава този с повече гледания."""
    best = {}
    for c in cands:
        k = _norm_title(c["title"])
        if k not in best or c.get("views", 0) > best[k].get("views", 0):
            best[k] = c
    return list(best.values())


# ---------------------------------------------------------------------------
# ГЛАВЕН ПОТОК
# ---------------------------------------------------------------------------

def select_target(pool, own_ids, cfg, now):
    """Построява класирания списък от пула: приети външни + мои, всички през общите правила."""
    external, own = [], []
    for vid, e in pool.items():
        if e.get("gone") or e.get("insert_failures", 0) >= cfg["max_insert_failures"]:
            continue
        is_own = vid in own_ids or bool(e.get("is_mine"))
        if is_own and not cfg["include_own"]:
            continue
        if not is_own and not e.get("accepted"):
            continue
        ok, _ = passes_rules({**e, "distribution": own_ids.get(vid)}, cfg, now, is_own=is_own)
        if not ok:
            continue
        item = {"video_id": vid, "title": e["title"], "channel": e.get("channel", ""),
                "views": e.get("views", 0), "published_at": e.get("published_at", ""), "is_mine": is_own}
        (own if is_own else external).append(item)
    ranked = rank_candidates(dedupe_own(own) + external, cfg, now)
    return ranked[: int(cfg["size"])], len(ranked)


def run(cfg, dry_run, force):
    now = _now()
    run_log = {"run_id": str(uuid.uuid4())[:8], "started_at": _iso(now), "dry_run": dry_run, "status": "running",
               "searches": 0, "new_candidates": 0, "ai_agents": [], "added": 0, "removed": 0, "moved": 0,
               "deferred_ops": 0, "playlist_size": 0, "errors": [], "warnings": [], "quota_spent_units": 0}

    if not cfg.get("enabled", True):
        log("⏸️ Топ 100 кючеци е изключен (top100-config.json → enabled=false).")
        return 0

    state = load_json(STATE_PATH, {"schema_version": 1, "playlist_id": None, "pool": {}, "ranking": [],
                                   "last_done_local_date": None, "queries_history": []})
    state.setdefault("pool", {})
    ok, why = should_run(now, cfg, state.get("last_done_local_date"), force)
    if not ok:
        log(f"⏭️ Пропускам: {why}.")
        return 0
    log(f"▶️ Топ 100 кючеци — {why}{' [DRY RUN]' if dry_run else ''}")

    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        log("::error::Липсва YOUTUBE_API_KEY.")
        return 1
    token = None if dry_run else get_oauth_access_token()
    if not dry_run and not token:
        log("::error::Няма валиден OAuth access token (YOUTUBE_OAUTH_* secrets липсват/изтекли) — не мога да "
            "пиша в плейлист. Нищо не е изразходвано. Поднови refresh token-а (README → OAuth setup).")
        run_log["status"] = "error"
        run_log["errors"].append("READ-ONLY: няма валиден OAuth token — нищо не е записано в YouTube.")
        _append_log(run_log)
        return 1

    quota = QuotaBudget(int(cfg["daily_quota_units"]))
    yt = YouTubeClient(api_key, token, quota)
    root = load_json(ROOT_CONFIG_PATH, {})
    own_channel = root.get("youtube_channel_id") or root.get("CHANNEL_ID")
    catalog = load_json(CATALOG_PATH, {"tracks": []})
    own_ids = own_kyuchek_ids(catalog.get("tracks", []), cfg) if cfg["include_own"] else {}
    pool = state["pool"]

    # ---- 1) заявки ----
    queries = rotate_seed_queries(cfg, now.date())
    ai_q, q_agents = ai_generate_queries(cfg)
    queries = list(dict.fromkeys(queries + ai_q))
    run_log["ai_agents"] = q_agents
    log(f"  🔎 Заявки ({len(queries)}): {queries}  [AI агенти за заявки: {q_agents or 'няма — само фиксирани'}]")
    if not q_agents:
        run_log["warnings"].append("Никой AI агент не предложи заявки — използвани са само фиксираните.")

    # ---- 2) търсене (по гледания + по дата) ----
    found = []
    after_year = _iso(now - timedelta(days=int(cfg["max_age_days"])))
    after_recent = _iso(now - timedelta(days=int(cfg["recent_window_days"])))
    for q in queries:
        for order, after in (("viewCount", after_year), ("date", after_recent)):
            try:
                found += search_ids(q, yt, order, after, int(cfg["search_results_per_query"]))
                run_log["searches"] += 1
            except RuntimeError as e:
                log(f"  ⚠ Търсене '{q}' ({order}) неуспешно: {e}")
                run_log["warnings"].append(f"search '{q}' ({order}): {str(e)[:120]}")
                if "Quota" in str(e) or "quota" in str(e):
                    break
    found = list(dict.fromkeys(found))
    new_ids = [v for v in found if v not in pool]
    log(f"  📥 Намерени {len(found)} видеа, {len(new_ids)} нови за пула.")

    # ---- 3) детайли + правила за новите (+ мои песни, които още не са в пула) ----
    own_missing = [v for v in own_ids if v not in pool and v not in new_ids]
    details = fetch_videos(new_ids + own_missing, yt)
    to_vote, ext_new = [], []
    for vid in new_ids + own_missing:
        c = details.get(vid)
        if not c:
            continue
        is_own = vid in own_ids or (own_channel and c["channel_id"] == own_channel)
        ok_rules, reason = passes_rules({**c, "distribution": own_ids.get(vid)}, cfg, now, is_own=bool(is_own))
        entry = {**c, "first_seen": _iso(now), "last_seen": _iso(now), "is_mine": bool(is_own),
                 "accepted": bool(is_own) and ok_rules, "insert_failures": 0}
        if is_own:
            entry["votes"] = {"yes": None, "total": None, "agents": ["own"]}
        elif not ok_rules:
            entry["accepted"] = False
            entry["votes"] = {"yes": 0, "total": 0, "agents": [], "rejected_by_rule": reason}
        else:
            to_vote.append(entry)
            continue
        pool[vid] = entry
        ext_new.append(vid)

    # ---- 4) AI гласуване на външните кандидати ----
    voters_all = set()
    if to_vote:
        if cfg["ai_vote"]["enabled"]:
            bs = max(5, int(cfg["ai_vote"]["batch_size"]))
            for i in range(0, len(to_vote), bs):
                batch = to_vote[i:i + bs]
                tallies, voters = ai_vote_batch(batch, cfg)
                voters_all.update(voters)
                for e, (y, tot) in zip(batch, tallies):
                    verdict = consensus(y, tot, cfg["ai_vote"]["min_yes_ratio"])
                    if verdict is None:   # нито един агент не отговори → резерва: ключова дума в заглавието
                        verdict = title_has_keyword(e["title"], cfg)
                        e["votes"] = {"yes": None, "total": 0, "agents": [], "fallback": "keyword"}
                    else:
                        e["votes"] = {"yes": y, "total": tot, "agents": sorted(voters)}
                    e["accepted"] = bool(verdict)
                    pool[e["video_id"]] = e
                    ext_new.append(e["video_id"])
            if not voters_all:
                run_log["warnings"].append("Нито един AI агент не гласува — приети са само заглавия с ключова дума.")
        else:
            for e in to_vote:
                e["accepted"] = title_has_keyword(e["title"], cfg)
                e["votes"] = {"yes": None, "total": 0, "agents": [], "fallback": "keyword"}
                pool[e["video_id"]] = e
                ext_new.append(e["video_id"])
    run_log["new_candidates"] = len(ext_new)
    run_log["ai_agents"] = sorted(set(run_log["ai_agents"]) | voters_all)
    log(f"  🗳️ Нови кандидати: {len(ext_new)}; приети: {sum(1 for v in ext_new if pool[v].get('accepted'))}; "
        f"гласували агенти: {sorted(voters_all) or 'няма'}")

    # ---- 5) опресняване на гледанията на целия пул (евтино: 1 unit на 50 видеа) ----
    refresh_ids = [v for v, e in pool.items() if v not in details and not e.get("gone") and e.get("accepted")]
    fresh = fetch_videos(refresh_ids, yt)
    for vid in refresh_ids:
        e = pool[vid]
        if vid in fresh:
            e.update({k: fresh[vid][k] for k in ("title", "views", "duration_seconds", "published_at")})
            e["last_seen"] = _iso(now)
        else:
            e["gone"] = True   # изтрито/private/недостъпно
            log(f"  🧹 Вече недостъпно: {e.get('title', vid)[:60]}")
    _prune_pool(pool, int(cfg["pool_max_size"]))

    # ---- 6) класиране ----
    target, eligible_total = select_target(pool, own_ids, cfg, now)
    target_ids = [c["video_id"] for c in target]
    prev_rank = {c["video_id"]: c["rank"] for c in state.get("ranking", [])}
    for c in target:
        c["prev_rank"] = prev_rank.get(c["video_id"])
    log(f"  🏆 Допустими кандидати: {eligible_total}; в класацията: {len(target)}/{cfg['size']} "
        f"(мои: {sum(1 for c in target if c['is_mine'])}).")
    if len(target) < int(cfg["size"]):
        run_log["warnings"].append(
            f"Само {len(target)} допустими видеа за {cfg['size']} места — намали min_views/удължи max_age_days "
            "или изчакай няколко дни да се напълни пулът.")

    # ---- 7) плейлист ----
    playlist_id = cfg.get("playlist_id") or state.get("playlist_id")
    if not playlist_id:
        if dry_run:
            playlist_id = "DRY_RUN_PENDING"
            log(f"  🧪 [DRY RUN] Бих създал плейлист '{cfg['playlist_title']}'.")
        else:
            res = retry(lambda: yt.write(
                "playlists", {"part": "snippet,status"},
                {"snippet": {"title": cfg["playlist_title"], "description": cfg["playlist_description"]},
                 "status": {"privacyStatus": cfg["privacy"]}}, "playlists.insert"), label="създаване на плейлист")
            playlist_id = res["id"]
            state["playlist_id"] = playlist_id
            log(f"  ✅ Създаден плейлист '{cfg['playlist_title']}' ({playlist_id}).")
    current = [] if playlist_id == "DRY_RUN_PENDING" else fetch_playlist_items(playlist_id, yt)

    ops = plan_playlist_ops(current, target_ids)
    titles = {c["video_id"]: c["title"] for c in target}
    titles.update({v: e.get("title", v) for v, e in pool.items()})
    remaining_budget = quota.budget - quota.spent
    reserve = 3 * quota.COSTS["playlistItems.list"]   # финална проверка
    applied_ops, deferred = cap_ops(ops, int(cfg["max_ops_per_run"]), remaining_budget - reserve)
    run_log["deferred_ops"] = deferred
    log(f"  🛠️ Операции: {len(ops)} общо; този run: {len(applied_ops)}; отложени: {deferred} "
        f"(бюджет {remaining_budget} ед.).")
    if deferred:
        run_log["warnings"].append(f"{deferred} операции са отложени за следващия ден (дневен бюджет на квотата).")

    failed_ids = []
    for op in applied_ops:
        label = f"{op['action']} → {titles.get(op['video_id'], op['video_id'])[:60]}"
        if dry_run:
            log(f"    🧪 [DRY RUN] {label}" + (f" @ {op['position']}" if "position" in op else ""))
            continue
        try:
            if op["action"] == "insert":
                body = {"snippet": {"playlistId": playlist_id, "position": op["position"],
                                    "resourceId": {"kind": "youtube#video", "videoId": op["video_id"]}}}
                retry(lambda b=body: yt.write("playlistItems", {"part": "snippet"}, b, "playlistItems.insert"), label=label)
                run_log["added"] += 1
            elif op["action"] == "delete":
                if not op.get("item_id"):
                    continue
                retry(lambda i=op["item_id"]: yt.delete("playlistItems", {"id": i}, "playlistItems.delete"), label=label)
                run_log["removed"] += 1
            elif op["action"] == "move":
                if not op.get("item_id"):
                    continue
                body = {"id": op["item_id"], "snippet": {"playlistId": playlist_id, "position": op["position"],
                        "resourceId": {"kind": "youtube#video", "videoId": op["video_id"]}}}
                retry(lambda b=body: yt.write("playlistItems", {"part": "snippet"}, b, "playlistItems.update",
                                              method="PUT"), label=label)
                run_log["moved"] += 1
        except RuntimeError as e:
            log(f"    ❌ {label}: {e}")
            run_log["errors"].append({"op": op["action"], "video_id": op["video_id"], "error": str(e)[:200]})
            if op["action"] == "insert":
                failed_ids.append(op["video_id"])
            if "Quota" in str(e):
                break
    for vid in failed_ids:   # видео, което не може да се добави, не бива да блокира място завинаги
        if vid in pool:
            pool[vid]["insert_failures"] = pool[vid].get("insert_failures", 0) + 1

    # ---- 8) проверка + запис ----
    verify_mismatch = None
    if not dry_run and playlist_id and quota.can_afford("playlistItems.list"):
        try:
            live_ids = [it["video_id"] for it in fetch_playlist_items(playlist_id, yt)]
            expected = target_ids if not deferred and not run_log["errors"] else None
            if expected is not None:
                verify_mismatch = sum(1 for a, b in zip(live_ids, expected) if a != b) + abs(len(live_ids) - len(expected))
                if verify_mismatch:
                    run_log["warnings"].append(f"След обновяването плейлистът се различава от класацията на {verify_mismatch} места.")
        except RuntimeError as e:
            run_log["warnings"].append(f"Финалната проверка неуспешна: {str(e)[:120]}")

    run_log["playlist_size"] = len(target)
    run_log["quota_spent_units"] = quota.spent
    run_log["status"] = "dry_run" if dry_run else ("partial_failure" if run_log["errors"] else "ok")
    loc_date = local_now(now, cfg["timezone"]).date().isoformat()
    snapshot = {
        "schema_version": 1, "playlist_id": playlist_id if playlist_id != "DRY_RUN_PENDING" else None,
        "playlist_url": f"https://www.youtube.com/playlist?list={playlist_id}" if playlist_id not in (None, "DRY_RUN_PENDING") else None,
        "title": cfg["playlist_title"], "last_run": run_log["started_at"], "last_done_local_date": loc_date,
        "eligible_total": eligible_total, "deferred_ops": deferred, "ai_agents": run_log["ai_agents"],
        "ranking": target, "pool": pool,
        "queries_history": (state.get("queries_history", []) + [{"date": loc_date, "queries": queries}])[-30:],
    }
    if dry_run:
        save_json(PREVIEW_PATH, {**{k: v for k, v in snapshot.items() if k != "pool"}, "planned_ops": applied_ops})
    else:
        save_json(STATE_PATH, snapshot)
    _append_log(run_log)
    log(f"\n✅ Run {run_log['run_id']}: +{run_log['added']} / -{run_log['removed']} / ~{run_log['moved']} · "
        f"отложени {deferred} · quota ~{quota.spent} ед.{' · DRY RUN' if dry_run else ''}")
    return 0


def _prune_pool(pool, max_size):
    """Държи пула ограничен: първо изчезналите, после отхвърлените (най-старите), никога приетите."""
    if len(pool) <= max_size:
        return
    droppable = sorted((v for v, e in pool.items() if e.get("gone") or not e.get("accepted")),
                       key=lambda v: (not pool[v].get("gone"), pool[v].get("last_seen", "")))
    for v in droppable[: len(pool) - max_size]:
        pool.pop(v, None)


def _append_log(run_log):
    data = load_json(LOG_PATH, {"schema_version": 1, "runs": []})
    data.setdefault("runs", []).append(run_log)
    data["runs"] = data["runs"][-MAX_LOG_RUNS:]
    save_json(LOG_PATH, data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="игнорира часовия прозорец и 'вече обновено днес'")
    args = ap.parse_args()
    cfg = merged_config(load_json(CONFIG_PATH, {}))
    force = args.force or os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
    sys.exit(run(cfg, args.dry_run, force))


if __name__ == "__main__":
    main()
