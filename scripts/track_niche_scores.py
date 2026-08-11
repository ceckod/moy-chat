#!/usr/bin/env python3
"""
CD-B Records — Profit Niche Scanner (Profit Niche Score, автоматичен).

Пуска се от .github/workflows/niche-scores.yml (планирано за следваща сесия
— виж AUDIT_PROGRESS.md). За разлика от track_trends.py (YouTube-само,
за общи жанрове) и от браузърните js/niche-scoring.js + js/niche-toolkit.js
(ръчен клик, 1 ниша наведнъж), този скрипт:
  - върви автоматично по график (седмично)
  - анализира ВСИЧКИ ниши от config.json наведнъж
  - комбинира НЯКОЛКО независими, безключови източника за по-надежден резултат

БЕЗ Spotify изобщо (потвърдено решение — виж AUDIT_PROGRESS.md) и БЕЗ
API ключове за никой източник по-долу. Само вградени Python модули
(urllib) — същия принцип като track_trends.py/track_stats.py, за да няма
нужда от "pip install" стъпка в GitHub Actions.

── Дизайн: източници, групирани по КАКВО измерват (не поравно тегло) ──

  Demand (пазар/търсене) — комбинирани, за да се компенсират взаимно:
    1. Deezer API      (api.deezer.com)        — основен
    2. iTunes Search    (itunes.apple.com)       — кръстосана проверка
    3. MusicBrainz       (musicbrainz.org)        — кръстосана проверка
    4. kworb.net (HTML)                          — САМО ако горните 3 паднат

  Momentum (тренд/интерес във времето):
    5. Wikipedia Pageviews (wikimedia.org)        — независим от музикалните
                                                     платформи, истински тренд

  Community (дълбочина на фен общността, различен ъгъл от стрийминг):
    6. Reddit public JSON (reddit.com/r/.../about.json)

  Opportunity (HHI концентрация) — смята се от Demand дела, не отделен fetch.
  Monetization / Feasibility     — ръчни числа от config.json (placeholder).

Всяка fetch_* функция НИКОГА не хвърля грешка нагоре — връща None/{} при
провал, точно както js/niche-data-sources.js прави в браузъра. Един
счупен източник никога не спира целия анализ, само намалява броя
сигнали, участвали в средното.

Следваща сесия (съзнателно НЕ е добавено сега, за да остане това тествано
и стабилно): Discogs (release count), ListenBrainz (community listens),
YouTube RSS (channel activity) — same fetch_* pattern, лесно се добавят.
"""

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SCHEMA_VERSION = 1
USER_AGENT = "CDB-NicheScanner/1.0 (+https://github.com/; contact: repo-owner)"

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config.json")
DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "niche-scores-history.json")
DISCOVERED_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "discovered-niches.json")

DEFAULT_WEIGHTS = {
    "demand": 0.25,
    "momentum": 0.20,
    "opportunity": 0.20,
    "community": 0.15,
    "monetization": 0.10,
    "feasibility": 0.10,
}


# ───────────────────────── общи helper-и ─────────────────────────

def _http_get_json(url, headers=None, timeout=15):
    """GET → парснат JSON, или None при какъвто и да е провал. Никога не хвърля."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw)
    except Exception as e:  # мрежа, timeout, невалиден JSON, HTTP грешка — всичко
        print(f"    ⚠ fetch fail ({url[:70]}...): {e}")
        return None


def _http_get_text(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"    ⚠ fetch fail ({url[:70]}...): {e}")
        return None


def _deep_find(obj, key, depth=0):
    """Търси ключ на произволна дълбочина в JSON — не се чупи при
    преподреждане на структурата от страна на източника."""
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


# ───────────────────────── Demand: Deezer ─────────────────────────

def fetch_deezer_demand(keyword):
    """Връща (market_top20, artist_count) от Deezer artist search."""
    url = f"https://api.deezer.com/search/artist?q={urllib.parse.quote(keyword)}&limit=50"
    data = _http_get_json(url)
    if not data or "data" not in data or not data["data"]:
        return None
    artists = data["data"][:50]
    fans = sorted([a.get("nb_fan", 0) for a in artists if a.get("nb_fan", 0) > 0], reverse=True)
    if not fans:
        return None
    top20 = fans[:20]
    return {"market": sum(top20), "shares": top20, "artist_count": len(artists), "source": "deezer"}


# ───────────────────────── Demand: iTunes ─────────────────────────

def fetch_itunes_demand(keyword):
    """iTunes Search API няма 'fans' число — ползваме брой резултати +
    trackCount на топ артисти като прокси сигнал за размера на нишата."""
    url = (
        "https://itunes.apple.com/search?"
        f"term={urllib.parse.quote(keyword)}&entity=musicArtist&limit=50"
    )
    data = _http_get_json(url)
    if not data or not data.get("results"):
        return None
    count = data.get("resultCount", len(data["results"]))
    # iTunes не дава fenove — нормализираме грубо: 200 резултата ≈ "голяма" ниша.
    proxy_market = min(count / 50 * 1_000_000, 20_000_000)
    return {"market": proxy_market, "artist_count": count, "source": "itunes"}


# ───────────────────────── Demand: MusicBrainz ─────────────────────

def fetch_musicbrainz_demand(keyword):
    """Брой артисти/издания, тагнати с жанра — прокси за каталожен мащаб."""
    url = (
        "https://musicbrainz.org/ws/2/artist?"
        f"query=tag:{urllib.parse.quote(keyword)}&fmt=json&limit=25"
    )
    data = _http_get_json(url)
    if not data or "count" not in data:
        return None
    count = data.get("count", 0)
    proxy_market = min(count / 100 * 1_000_000, 20_000_000)
    return {"market": proxy_market, "artist_count": count, "source": "musicbrainz"}


# ───────────────────────── Demand fallback: kworb ───────────────────

def fetch_kworb_demand(keyword):
    """Последна резерва — HTML парснат по заглавие на колона, не по позиция."""
    slug = keyword.replace(" ", "+")
    url = f"https://kworb.net/spotify/artists/{slug}.html"
    html = _http_get_text(url)
    if not html:
        return None
    rows = re.findall(r"<tr>(.*?)</tr>", html, re.DOTALL)
    listeners = []
    for row in rows[:20]:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        nums = [
            int(re.sub(r"[^\d]", "", re.sub(r"<[^>]+>", "", c)))
            for c in cells
            if re.sub(r"<[^>]+>", "", c).strip().replace(",", "").isdigit()
        ]
        if nums:
            listeners.append(nums[0])
    if not listeners:
        return None
    return {"market": sum(listeners), "shares": listeners, "source": "kworb"}


# ───────────────────────── Momentum: Wikipedia Pageviews ────────────

def fetch_wikipedia_momentum(keyword):
    """Намира статията за жанра, после тегли последните 60 дни pageviews.
    Momentum = ръст на последните 30 дни спрямо предходните 30."""
    search_url = (
        "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json"
        f"&srsearch={urllib.parse.quote(keyword + ' music genre')}&srlimit=1"
    )
    search = _http_get_json(search_url)
    title = _deep_find(search, "title")
    if not title:
        return None
    article = urllib.parse.quote(title.replace(" ", "_"))
    from datetime import timedelta
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=60)
    pv_url = (
        "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
        f"en.wikipedia/all-access/user/{article}/daily/"
        f"{start.strftime('%Y%m%d')}/{end.strftime('%Y%m%d')}"
    )
    pv = _http_get_json(pv_url, headers={"Accept": "application/json"})
    items = pv.get("items") if pv else None
    if not items or len(items) < 10:
        return None
    views = [it["views"] for it in items]
    mid = len(views) // 2
    recent, earlier = sum(views[mid:]), sum(views[:mid]) or 1
    growth_pct = (recent - earlier) / earlier * 100
    momentum_score = max(0, min(100, 50 + growth_pct * 2))
    return {"momentum_score": round(momentum_score, 1), "article": title, "source": "wikipedia"}


# ───────────────────────── Community: Reddit ─────────────────────────

def fetch_reddit_community(keyword):
    """Пробва subreddit с точното име на нишата (slug); ако не съществува,
    връща None — без грешка нагоре."""
    slug = re.sub(r"[^a-z0-9]", "", keyword.lower())
    if not slug:
        return None
    url = f"https://www.reddit.com/r/{slug}/about.json"
    data = _http_get_json(url, headers={"Accept": "application/json"})
    subs = _deep_find(data, "subscribers")
    if subs is None:
        return None
    return {"subscribers": subs, "source": "reddit"}


# ───────────────────────── Скоринг ─────────────────────────

def compute_hhi(shares):
    total = sum(shares) or 1
    return sum((s / total) ** 2 for s in shares)


def score_niche(niche_cfg, prev_snapshot=None):
    name = niche_cfg["name"]
    keyword = niche_cfg.get("keyword", name)
    print(f"  → {name} ...")

    # --- Demand: комбинирай Deezer + iTunes + MusicBrainz (медиана) ---
    demand_sources = []
    d = fetch_deezer_demand(keyword)
    if d:
        demand_sources.append(d)
    time.sleep(0.3)
    it = fetch_itunes_demand(keyword)
    if it:
        demand_sources.append(it)
    time.sleep(0.3)
    mb = fetch_musicbrainz_demand(keyword)
    if mb:
        demand_sources.append(mb)
    time.sleep(0.3)

    if not demand_sources:
        kw = fetch_kworb_demand(keyword)
        if kw:
            demand_sources.append(kw)

    demand_confidence = "LOW"
    if demand_sources:
        markets = [s["market"] for s in demand_sources]
        market_estimate = statistics.median(markets)
        demand_confidence = (
            "HIGH" if len(demand_sources) >= 3 else "MEDIUM" if len(demand_sources) == 2 else "LOW"
        )
        shares_source = next((s for s in demand_sources if "shares" in s), None)
        hhi = compute_hhi(shares_source["shares"]) if shares_source else 0.15  # neutral guess
    elif prev_snapshot:
        market_estimate = prev_snapshot.get("market_estimate", 0)
        hhi = prev_snapshot.get("hhi", 0.15)
        demand_confidence = "ARCHIVE"
    else:
        market_estimate = 0
        hhi = 0.15

    demand_score = min(market_estimate / 10_000_000 * 100, 100)
    opportunity_score = max(0, (1 - hhi) * 100)

    # --- Momentum: Wikipedia ---
    wiki = fetch_wikipedia_momentum(keyword)
    time.sleep(0.3)
    if wiki:
        momentum_score = wiki["momentum_score"]
    elif prev_snapshot:
        momentum_score = prev_snapshot.get("momentum_score", 50)
    else:
        momentum_score = 50  # неутрално, не измислено високо/ниско

    # --- Community: Reddit ---
    reddit = fetch_reddit_community(keyword)
    time.sleep(0.3)
    if reddit:
        community_score = min(reddit["subscribers"] / 200_000 * 100, 100)
    elif prev_snapshot:
        community_score = prev_snapshot.get("community_score", 30)
    else:
        community_score = 30  # консервативно неутрално при липса на subreddit

    # --- Monetization / Feasibility: ръчни, от config ---
    monetization_score = niche_cfg.get("monetization_score", 50)
    feasibility_score = niche_cfg.get("feasibility_score", 60)

    w = DEFAULT_WEIGHTS
    pns = (
        w["demand"] * demand_score
        + w["momentum"] * momentum_score
        + w["opportunity"] * opportunity_score
        + w["community"] * community_score
        + w["monetization"] * monetization_score
        + w["feasibility"] * feasibility_score
    )

    return {
        "niche": name,
        "keyword": keyword,
        "discovered": niche_cfg.get("discovered", False),
        "discovery_confidence": niche_cfg.get("discovery_confidence"),
        "demand_score": round(demand_score, 1),
        "demand_confidence": demand_confidence,
        "demand_sources_used": [s["source"] for s in demand_sources] or ["archive/none"],
        "momentum_score": round(momentum_score, 1),
        "opportunity_score": round(opportunity_score, 1),
        "hhi": round(hhi, 3),
        "community_score": round(community_score, 1),
        "monetization_score": monetization_score,
        "feasibility_score": feasibility_score,
        "market_estimate": round(market_estimate),
        "PNS": round(pns, 1),
    }


# ───────────────────────── config / история I/O ─────────────────────────

def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    # niche_scan_niches е ново поле (добавя се следваща сесия) — ако липсва,
    # fallback към trend_niches с default feasibility/monetization, за да
    # скриптът да е тестваем ВЕДНАГА без чакане на config edit.
    if "niche_scan_niches" in cfg:
        base = list(cfg["niche_scan_niches"])
    else:
        base = [{"name": n, "keyword": n} for n in cfg.get("trend_niches", [])]

    # Автоматично откритите кандидати (discover_niches.py, върви ПРЕДИ този
    # скрипт в workflow-а) — добавят се ВЪРХУ base списъка, не го заменят.
    # Потребителят изрично не иска ръчна база/одобрение — потвърдените
    # кандидати влизат директно в скена.
    known_names = {n["name"] for n in base}
    if os.path.exists(DISCOVERED_PATH):
        try:
            with open(DISCOVERED_PATH, encoding="utf-8") as f:
                disc = json.load(f)
            for c in disc.get("discovered", []):
                name = c["term"].title()
                if name not in known_names:
                    base.append({
                        "name": name,
                        "keyword": c["term"],
                        "discovered": True,
                        "discovery_confidence": c.get("confidence", "LOW"),
                    })
                    known_names.add(name)
            print(f"  + {len(disc.get('discovered', []))} автоматично открити кандидата добавени към скена.")
        except Exception as e:
            print(f"  ⚠ discovered-niches.json не можа да се прочете ({e}) — продължавам само с base списъка.")

    return base


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


def last_snapshot_for(history, niche_name):
    for snap in reversed(history["snapshots"]):
        for row in snap.get("niches", []):
            if row["niche"] == niche_name:
                return row
    return None


# ───────────────────────── main ─────────────────────────

def main():
    niches = load_config()
    if not niches:
        print("❌ Няма ниши в config.json (нито niche_scan_niches, нито trend_niches) — спиране.")
        return

    history = load_history()
    results = []
    for niche_cfg in niches:
        prev = last_snapshot_for(history, niche_cfg["name"])
        row = score_niche(niche_cfg, prev_snapshot=prev)
        results.append(row)

    results.sort(key=lambda r: r["PNS"], reverse=True)

    snapshot = {
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "niches": results,
    }
    history["snapshots"].append(snapshot)
    save_history(history)

    print("\n═══════════════════════════════════════")
    print("   PROFIT NICHE SCORE — класация")
    print("═══════════════════════════════════════")
    for r in results:
        mark = "🔥" if r["PNS"] >= 70 else "⭐" if r["PNS"] >= 50 else "⚠"
        print(
            f"  {mark} {r['niche']:24s} {r['PNS']:5.1f}/100  "
            f"(demand={r['demand_score']:.0f}[{r['demand_confidence']}], "
            f"momentum={r['momentum_score']:.0f}, opp={r['opportunity_score']:.0f}, "
            f"community={r['community_score']:.0f})"
        )
    print("═══════════════════════════════════════\n")
    print(f"Записано в {DATA_PATH}")


if __name__ == "__main__":
    main()
