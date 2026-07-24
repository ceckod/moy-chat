#!/usr/bin/env python3
"""
CD-B Records — Daily music-niche trend tracker.

Пуска се от .github/workflows/daily-trends.yml всеки ден. За разлика от
track_stats.py (който следи ТВОЯ канал), този скрипт следи ОБЩИ трендове
за жанрове/ниши от config.json → "trend_niches", за да прецени кои
набират инерция СЕГА.

Две отделни, БЕЗПЛАТНИ проверки, БЕЗ Gemini (никаква grounding квота):
  1. Google Trends (през неофициалната библиотека pytrends) — расте ли
     интересът към нишата през последните 2 седмици спрямо предходните.
  2. YouTube Data API (същия YOUTUBE_API_KEY secret като track_stats.py) —
     колко наситена/конкурентна е нишата в момента (последните 30 дни).

Резултатът (search_signal + competition_signal + score 0-100) се пише в
data/trends-history.json — версионирана история, същата схема като
stats-history.json. Dashboard-ът само чете готовия файл, никакви ключове
или заявки от браузъра.

Забележка: pytrends е НЕОФИЦИАЛНА библиотека (reverse-engineered достъп
до Google Trends). Google понякога временно я блокира/лимитира — затова
скриптът продължава и записва частичен резултат, вместо да гръмне
изцяло, ако Trends заявка се провали за конкретен batch.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from pytrends.request import TrendReq
except ImportError:
    print("::error::Липсва pytrends. Добави 'pip install pytrends' в workflow-а.", file=sys.stderr)
    sys.exit(1)

YT_API_BASE = "https://www.googleapis.com/youtube/v3"
SCHEMA_VERSION = 1
ANCHOR_KEYWORD = "music"  # включен във всеки batch, за да сравняваме различните batch-ове помежду им
BATCH_SIZE = 4            # + anchor = 5, лимитът на Google Trends за заявка

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


def chunk(items, size):
    return [items[i:i + size] for i in range(0, len(items), size)]


def fetch_trend_growth(niches):
    """Връща {niche: growth_ratio} — последни 7 дни спрямо предходните 7,
    нормализирано спрямо ANCHOR_KEYWORD (за да са сравними различните batch-ове).
    При грешка за даден batch, тези ниши просто липсват в резултата (не гърми всичко)."""
    pytrends = TrendReq(hl="en-US", tz=0)
    growth = {}

    for batch in chunk(niches, BATCH_SIZE):
        kw_list = [ANCHOR_KEYWORD] + batch
        try:
            pytrends.build_payload(kw_list, timeframe="today 3-m")
            df = pytrends.interest_over_time()
            if df.empty:
                print(f"  ⚠️ Празни Trends данни за batch: {batch}")
                continue

            recent = df.tail(7)
            previous = df.iloc[-14:-7] if len(df) >= 14 else df.head(max(len(df) - 7, 1))

            for niche in batch:
                anchor_recent = recent[ANCHOR_KEYWORD].mean()
                anchor_prev = previous[ANCHOR_KEYWORD].mean()
                if anchor_recent <= 0 or anchor_prev <= 0:
                    continue
                norm_recent = recent[niche].mean() / anchor_recent
                norm_prev = previous[niche].mean() / anchor_prev
                if norm_prev <= 0:
                    growth[niche] = 1.0 if norm_recent > 0 else 0.0
                else:
                    growth[niche] = (norm_recent - norm_prev) / norm_prev

        except Exception as e:  # pytrends хвърля различни грешки (429, JSON decode и др.)
            print(f"  ⚠️ Trends грешка за batch {batch}: {e}", file=sys.stderr)

        time.sleep(2)  # учтива пауза между batch заявките, за да не удряме rate limit

    return growth


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


def fetch_competition(api_key, niche):
    """Проста конкурентна оценка: totalResults (наситеност) + средни views
    на топ 10 видеа от последните 30 дни (колко силно вече се качва в нишата)."""
    published_after = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = yt_api_get("search", {
        "part": "snippet",
        "q": f"{niche} music",
        "type": "video",
        "order": "viewCount",
        "publishedAfter": published_after,
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

    print(f"→ Тегля Google Trends растеж за {len(niches)} ниши...")
    growth = fetch_trend_growth(niches)
    print(f"  Получени данни за {len(growth)}/{len(niches)} ниши.")

    print("→ Тегля YouTube конкурентни данни за всяка ниша...")
    competition_raw = {}
    for niche in niches:
        comp = fetch_competition(api_key, niche)
        if comp:
            competition_raw[niche] = comp
            print(f"  {niche}: {comp['total_results']} видеа, ~{comp['avg_top10_views_30d']} avg views")
        time.sleep(0.3)

    growth_scores = normalize(growth)
    competition_scores = normalize(
        {n: c["total_results"] for n, c in competition_raw.items()}, invert=True
    )

    results = []
    for niche in niches:
        g = growth.get(niche)
        gs = growth_scores.get(niche)
        cs = competition_scores.get(niche)
        if gs is None or cs is None:
            continue  # непълни данни за тази ниша (Trends или YouTube грешка) — пропускаме
        score = round(0.6 * gs + 0.4 * cs, 1)
        comp = competition_raw[niche]
        results.append({
            "niche": niche,
            "score": score,
            "reason": f"{'Растящ' if g >= 0.05 else 'Спадащ' if g <= -0.05 else 'Стабилен'} интерес "
                      f"({g * 100:+.0f}% за 7 дни), ~{comp['total_results']} видеа конкуренция (30 дни).",
            "search_signal": f"{'расте' if g >= 0.05 else 'спада' if g <= -0.05 else 'стабилно'} ({g * 100:+.0f}% за 7 дни)",
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
