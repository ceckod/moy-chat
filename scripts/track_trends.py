#!/usr/bin/env python3
"""
CD-B Records — Daily music-niche trend tracker.

Пуска се от .github/workflows/daily-trends.yml всеки ден. За разлика от
track_stats.py (който следи ТВОЯ канал), този скрипт следи ОБЩИ трендове
за жанрове/ниши от config.json → "trend_niches", за да прецени кои
набират инерция СЕГА.

Всичко минава през YouTube Data API (същия YOUTUBE_API_KEY secret като
track_stats.py) — БЕЗ Gemini (никаква grounding квота), БЕЗ Google Trends.

  1. Growth сигнал: брой нови видеа в нишата последните 14 дни спрямо
     предходните 14 дни (расте ли темпото на публикуване = расте интересът).
  2. Competition сигнал: колко наситена е нишата в момента (общ брой видеа
     + средни views на топ 10 от последните 30 дни).

ЗАБЕЛЕЖКА (история): по-рано growth се смяташе през Google Trends (библиотека
pytrends). Google блокира IP адресите на GitHub Actions runner-ите (429 на
всяка заявка, потвърдено в логовете) — известно, документирано ограничение
на pytrends в CI/cloud среди, не се оправя с retry. Затова growth сега идва
изцяло от YouTube, който вече доказано работи стабилно оттук.

Резултатът (score 0-100 + четими сигнали) се пише в data/trends-history.json
— версионирана история, същата схема като stats-history.json. Dashboard-ът
само чете готовия файл, никакви ключове или заявки от браузъра.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

YT_API_BASE = "https://www.googleapis.com/youtube/v3"
SCHEMA_VERSION = 1

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config.json")
DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "trends-history.json")


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_history():
    if not os.path.exists(DATA_PATH):
        return {"schema_version": SCHEMA_VERSION, "snapshots": []}
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("schema_version", SCHEMA_VERSION)
    data.setdefault("snapshots", [])
    return data


def save_history(data):
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def yt_api_get(path, params):
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{YT_API_BASE}/{path}?{query}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  ⚠️ YouTube API грешка ({path}): {e.code} {body}", file=sys.stderr)
        return None


def video_count_in_window(api_key, niche, published_after, published_before):
    """Приблизителен брой видеа, публикувани в нишата в дадения прозорец
    (YouTube's totalResults е оценка, но е достатъчно стабилна за сравнение
    между два прозореца от време — не за абсолютна точност)."""
    params = {
        "part": "id",
        "q": f"{niche} music",
        "type": "video",
        "publishedAfter": iso(published_after),
        "maxResults": 1,
        "key": api_key,
    }
    if published_before:
        params["publishedBefore"] = iso(published_before)
    data = yt_api_get("search", params)
    if not data:
        return None
    return data.get("pageInfo", {}).get("totalResults", 0)


def fetch_growth(api_key, niche):
    """growth_ratio: (видеа последните 14 дни - видеа предходните 14 дни) / предходните.
    Положително = ускоряващо се публикуване = растящ интерес."""
    now = datetime.now(timezone.utc)
    recent = video_count_in_window(api_key, niche, now - timedelta(days=14), None)
    time.sleep(0.2)
    previous = video_count_in_window(api_key, niche, now - timedelta(days=28), now - timedelta(days=14))
    if recent is None or previous is None:
        return None
    if previous <= 0:
        return 1.0 if recent > 0 else 0.0
    return (recent - previous) / previous


def fetch_competition(api_key, niche):
    """Наситеност: общ брой видеа + средни views на топ 10 от последните 30 дни."""
    published_after = datetime.now(timezone.utc) - timedelta(days=30)
    data = yt_api_get("search", {
        "part": "snippet",
        "q": f"{niche} music",
        "type": "video",
        "order": "viewCount",
        "publishedAfter": iso(published_after),
        "maxResults": 10,
        "key": api_key,
    })
    if not data:
        return None

    total_results = data.get("pageInfo", {}).get("totalResults", 0)
    video_ids = [item["id"]["videoId"] for item in data.get("items", []) if item.get("id", {}).get("videoId")]
    avg_views = 0
    if video_ids:
        stats_data = yt_api_get("videos", {"part": "statistics", "id": ",".join(video_ids), "key": api_key})
        if stats_data:
            views = [int(it.get("statistics", {}).get("viewCount", 0)) for it in stats_data.get("items", [])]
            avg_views = sum(views) / len(views) if views else 0

    return {"total_results": total_results, "avg_top10_views_30d": round(avg_views)}


def normalize(values, invert=False):
    """Min-max нормализация до 0-100. invert=True → по-ниска стойност = по-висок резултат
    (ползва се за конкуренция: по-малко конкуренти = по-добър score)."""
    if not values:
        return {}
    lo, hi = min(values.values()), max(values.values())
    span = hi - lo
    out = {}
    for k, v in values.items():
        n = 50.0 if span == 0 else (v - lo) / span * 100
        out[k] = 100 - n if invert else n
    return out


def main():
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        print("::error::Липсва YOUTUBE_API_KEY (GitHub Secret). Виж README.md за setup.", file=sys.stderr)
        sys.exit(1)

    config = load_config()
    niches = config.get("trend_niches", [])
    if not niches:
        print("::error::Липсва trend_niches в config.json.", file=sys.stderr)
        sys.exit(1)

    growth = {}
    competition_raw = {}
    print(f"→ Тегля YouTube данни (growth + конкуренция) за {len(niches)} ниши...")
    for niche in niches:
        g = fetch_growth(api_key, niche)
        time.sleep(0.2)
        comp = fetch_competition(api_key, niche)
        if g is not None:
            growth[niche] = g
        if comp:
            competition_raw[niche] = comp
        print(f"  {niche}: growth={g}, конкуренция={comp}")
        time.sleep(0.2)

    growth_scores = normalize(growth)
    competition_scores = normalize(
        {n: c["total_results"] for n, c in competition_raw.items()}, invert=True
    )

    results = []
    for niche in niches:
        g = growth.get(niche)
        gs = growth_scores.get(niche)
        cs = competition_scores.get(niche)
        comp = competition_raw.get(niche)
        if gs is None or cs is None or comp is None:
            continue  # непълни данни за тази ниша (YouTube грешка) — пропускаме
        score = round(0.6 * gs + 0.4 * cs, 1)
        results.append({
            "niche": niche,
            "score": score,
            "reason": f"{'Растящо' if g >= 0.1 else 'Спадащо' if g <= -0.1 else 'Стабилно'} темпо на публикуване "
                      f"({g * 100:+.0f}% за 14 дни), ~{comp['total_results']} видеа конкуренция (30 дни).",
            "search_signal": f"{'расте' if g >= 0.1 else 'спада' if g <= -0.1 else 'стабилно'} ({g * 100:+.0f}% за 14 дни)",
            "competition_signal": f"{comp['total_results']} видеа, ~{comp['avg_top10_views_30d']:,} avg views (30д)".replace(",", " "),
            "trend_growth_ratio": round(g, 3),
        })

    results.sort(key=lambda r: r["score"], reverse=True)

    now = datetime.now(timezone.utc)
    snapshot = {
        "date": now.strftime("%Y-%m-%d"),
        "timestamp": now.isoformat(),
        "niches": results,
    }

    history = load_history()
    history["snapshots"] = [s for s in history["snapshots"] if s.get("date") != snapshot["date"]]
    history["snapshots"].append(snapshot)

    save_history(history)
    print(f"✅ Записан trend snapshot за {snapshot['date']} — {len(results)} ниши с пълни данни.")


if __name__ == "__main__":
    main()
