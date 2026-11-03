#!/usr/bin/env python3
"""
CD-B Records — Niche Discovery (нула ръчна база, виж AUDIT_PROGRESS.md
2026-08-11 за пълния договорен дизайн).

Пуска се ПРЕДИ track_niche_scores.py в .github/workflows/niche-scores.yml.
Целта: намери сам кои ниши са актуални точно сега, без потребителят да
въвежда каквато и да е отправна точка (изрично изискване — виж
AUDIT_PROGRESS.md, "не иска дори семенна база").

── Как работи (2 фази) ──────────────────────────────────────────────

ФАЗА 1 — Bootstrap (единственият източник, който НЕ се нуждае от seed):
  YouTube Trending Chart (chart=mostPopular, videoCategoryId=10 = Музика)
  за няколко региона наведнъж → заглавия + тагове на топ видеата точно
  сега → n-gram честотен анализ → кандидат-термини. Ползва YOUTUBE_API_KEY
  (вече съществуващ GitHub Secret, споделен с track_trends.py/track_stats.py
  — не е нов ключ).

ФАЗА 2 — Кръстосана проверка (всеки кандидат се проверява НЕЗАВИСИМО):
  - Wikipedia: съществува ли статия и расте ли интересът към нея?
  - MusicBrainz: тагван ли е този термин наскоро към нови издания?
  - Reddit: има ли активна общност (subreddit) около термина?

  Кандидат с ≥1 потвърждение от фаза 2 влиза в резултата с ниска/средна
  сигурност; с ≥2 потвърждения — висока сигурност. Честно казано (виж
  README "Идеи за следващо"): само YouTube фазата е истински "нула seed"
  bootstrap — другите 3 засега потвърждават кандидати, не генерират
  собствени независимо. Пълна 4-посочна независима генерация е бъдеща
  подобрение, не днешен обхват.

Резултатът се пише в data/discovered-niches.json (презаписва се всяка
седмица — това е "текущи кандидати", не история като niche-scores).
track_niche_scores.py го чете и добавя потвърдените кандидати към
scan списъка, върху вече съществуващите trend_niches (не ги заменя).
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

SCHEMA_VERSION = 1
USER_AGENT = "CDB-NicheDiscovery/1.0 (+https://github.com/; contact: repo-owner)"
YT_API_BASE = "https://www.googleapis.com/youtube/v3"

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "discovered-niches.json")

STOPWORDS = {
    "the", "and", "for", "with", "official", "video", "music", "audio",
    "lyrics", "lyric", "feat", "featuring", "remix", "full", "album",
    "song", "new", "best", "mix", "hd", "hq", "ft", "vs", "part", "live",
    "cover", "prod", "by", "of", "in", "on", "to", "a", "an",
}


def _http_get_json(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e:
        print(f"    ⚠ fetch fail ({url[:70]}...): {e}")
        return None


def _deep_find(obj, key, depth=0):
    if depth > 12 or obj is None:
        return None
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = _deep_find(v, key, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _deep_find(v, key, depth + 1)
            if r is not None:
                return r
    return None


# ───────────────────────── ФАЗА 1: YouTube Trending bootstrap ─────────────

def fetch_trending_candidates(api_key, regions=("US", "GB", "DE"), max_terms=15):
    """Без seed от потребителя — гледа какво Е в тренда точно сега,
    извлича 2-3-думни фрази от заглавия+тагове, връща най-честите."""
    if not api_key:
        print("  ⚠ YOUTUBE_API_KEY липсва — discovery bootstrap пропуснат.")
        return []

    phrase_counter = Counter()
    for region in regions:
        url = (
            f"{YT_API_BASE}/videos?part=snippet&chart=mostPopular"
            f"&videoCategoryId=10&regionCode={region}&maxResults=50&key={api_key}"
        )
        data = _http_get_json(url)
        items = data.get("items", []) if data else []
        for item in items:
            snippet = item.get("snippet", {})
            text_bits = [snippet.get("title", "")] + snippet.get("tags", [])
            for text in text_bits:
                words = re.findall(r"[a-zA-Z]+", text.lower())
                words = [w for w in words if w not in STOPWORDS and len(w) > 2]
                for n in (2, 3):
                    for i in range(len(words) - n + 1):
                        phrase = " ".join(words[i:i + n])
                        phrase_counter[phrase] += 1

    # само фрази, засечени поне 2 пъти (шум филтър), топ N по честота
    candidates = [p for p, c in phrase_counter.most_common(max_terms * 3) if c >= 2]
    return candidates[:max_terms]


# ───────────────────────── ФАЗА 2: кръстосана проверка ─────────────────────

def confirm_wikipedia(term):
    """Съществува статия + расте интересът последните 30 дни."""
    search_url = (
        "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json"
        f"&srsearch={urllib.parse.quote(term + ' music genre')}&srlimit=1"
    )
    search = _http_get_json(search_url)
    title = _deep_find(search, "title")
    if not title:
        return False
    article = urllib.parse.quote(title.replace(" ", "_"))
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=30)
    pv_url = (
        "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
        f"en.wikipedia/all-access/user/{article}/daily/"
        f"{start.strftime('%Y%m%d')}/{end.strftime('%Y%m%d')}"
    )
    pv = _http_get_json(pv_url, headers={"Accept": "application/json"})
    items = pv.get("items") if pv else None
    if not items or len(items) < 6:
        return False
    views = [it["views"] for it in items]
    mid = len(views) // 2
    recent, earlier = sum(views[mid:]), sum(views[:mid]) or 1
    return (recent - earlier) / earlier > 0.15  # >15% ръст = потвърдено растящо


def confirm_musicbrainz(term):
    """Тагът се използва ли изобщо в MusicBrainz (наличие на съвпадения)."""
    url = (
        "https://musicbrainz.org/ws/2/artist?"
        f"query=tag:{urllib.parse.quote(term)}&fmt=json&limit=1"
    )
    data = _http_get_json(url)
    return bool(data and data.get("count", 0) > 0)


def confirm_reddit(term):
    """Има ли активен subreddit с що-годе жива общност."""
    slug = re.sub(r"[^a-z0-9]", "", term.lower())
    if not slug:
        return False
    url = f"https://www.reddit.com/r/{slug}/about.json"
    data = _http_get_json(url, headers={"Accept": "application/json"})
    subs = _deep_find(data, "subscribers")
    return bool(subs and subs > 100)


# ───────────────────────── main ─────────────────────────

def main():
    api_key = os.environ.get("YOUTUBE_API_KEY", "")
    print("Фаза 1 — YouTube Trending bootstrap (без seed от потребителя)...")
    candidates = fetch_trending_candidates(api_key)
    print(f"  {len(candidates)} кандидат-термина извлечени.")

    confirmed = []
    for term in candidates:
        print(f"  → проверявам '{term}' ...")
        sources = []
        if confirm_wikipedia(term):
            sources.append("wikipedia")
        if confirm_musicbrainz(term):
            sources.append("musicbrainz")
        if confirm_reddit(term):
            sources.append("reddit")

        if sources:
            confidence = "HIGH" if len(sources) >= 2 else "LOW"
            confirmed.append({
                "term": term,
                "confirmed_by": sources,
                "confidence": confidence,
            })
            print(f"      ✅ потвърдено от {sources} → {confidence}")

    result = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bootstrap_source": "youtube_trending",
        "candidates_scanned": len(candidates),
        "discovered": confirmed,
    }

    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n{len(confirmed)}/{len(candidates)} кандидата потвърдени → {DATA_PATH}")


if __name__ == "__main__":
    main()
