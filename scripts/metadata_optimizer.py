#!/usr/bin/env python3
"""
CD-B Records — Metadata Optimizer.

Генерира AI-предложения за title/description/tags за конкретна песен от
каталога, за да подобри discoverability в YouTube search/suggested (т.45,
искане: "вдигни максимално гледанията"). НЕ пипа нищо на живо сам —
резултатите отиват в data/metadata-suggestions.json със статус "pending",
Dashboard-ът показва предложението и потребителят одобрява/отхвърля.
Реалната промяна в YouTube (videos.update) става само при explicit --apply
на вече одобрено предложение (или директно --apply-force за bypass).

Защо AI предложения, а не автоматично прилагане: смяна на заглавие/tags на
вече публикувано видео е рисковано за съществуващия SEO/ranking на самото
видео (YouTube частично "помни" сигнала от старото заглавие) — затова
винаги иска човешко одобрение, никога сляпо не пренаписва метаданни.

Употреба:
  python scripts/metadata_optimizer.py --generate VIDEO_ID
  python scripts/metadata_optimizer.py --apply VIDEO_ID

ENV: YOUTUBE_API_KEY (read), YOUTUBE_OAUTH_* (write, само за --apply),
     GROQ_API_KEY / MISTRAL_API_KEY / GITHUB_MODELS_TOKEN / CF_* / ANTHROPIC_API_KEY
     (поне един, за AI генерирането — виж call_ai_json).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from _youtube_common import (  # noqa: E402
    DATA_DIR, QuotaBudget, YouTubeClient,
    call_ai_json, get_oauth_access_token, load_json, log, save_json,
)

CATALOG_PATH = DATA_DIR / "catalog.json"
TRENDS_PATH = DATA_DIR / "trends-history.json"
SUGGESTIONS_PATH = DATA_DIR / "metadata-suggestions.json"

MAX_TITLE_LEN = 100          # YouTube хард лимит
MAX_DESCRIPTION_LEN = 5000   # YouTube хард лимит
MAX_TAGS_TOTAL_LEN = 400     # YouTube хард лимит (сума от всички tags)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _find_track(catalog, video_id):
    return next((t for t in catalog.get("tracks", []) if t.get("youtube_video_id") == video_id), None)


def _relevant_trend_signals(track, trends_data, limit=5):
    """Взима най-скорошния snapshot от trends-history.json и филтрира
    нишите, които звучат близки до жанр/subgenre/style_tags на песента —
    прост keyword overlap, не embedding similarity (държим го просто и
    прозрачно за AI промпта, не претендираме за прецизност тук)."""
    snapshots = trends_data.get("snapshots", [])
    if not snapshots:
        return []
    latest = snapshots[-1]
    keywords = {
        (track.get("genre") or "").lower(),
        (track.get("subgenre") or "").lower(),
        *[s.lower() for s in track.get("style_tags", [])],
    }
    keywords.discard("")
    scored = []
    for n in latest.get("niches", []):
        niche_low = n["niche"].lower()
        if any(kw in niche_low or niche_low in kw for kw in keywords):
            scored.append(n)
    return scored[:limit]


def generate_suggestion(video_id):
    catalog = load_json(CATALOG_PATH, {"tracks": []})
    track = _find_track(catalog, video_id)
    if not track:
        log(f"❌ {video_id} не е в data/catalog.json — не мога да генерирам предложение.")
        return None

    if track.get("distribution") == "distrokid":
        log(f"  ⚠ '{track.get('title')}' е дистрибутирана през DistroKid — видеото вероятно е "
            f"'claim-нато' в YouTube Content ID/CMS системата при доставката, а не обикновен "
            f"ъплоуд през твоя акаунт. YouTube ЧЕСТО отказва videos.update (title/description/tags) "
            f"за такова съдържание, дори с валиден OAuth — метаданните може да се управляват само "
            f"през самия дистрибутор (DistroKid), не през YouTube API директно. Продължавам да "
            f"генерирам предложение, но 'Приложи' може да гръмне с 403 — това ще го покаже ясно.")

    trends_data = load_json(TRENDS_PATH, {"snapshots": []})
    signals = _relevant_trend_signals(track, trends_data)
    signals_txt = "\n".join(
        f"- {s['niche']}: {s['reason']}" for s in signals
    ) if signals else "(няма близки данни в data/trends-history.json за тази ниша в момента)"

    # т.17.08.2026 бъгфикс: track["language"] (ISO 639-1, класифициран от
    # catalog_bootstrap.py) се подаваше в промпта само като ИНФОРМАЦИЯ, не
    # като изрична инструкция — AI моделът нямаше причина да не генерира
    # описанието на български (езика на самия промпт), дори за English/
    # френска песен. Сега description-ът изрично трябва да е на езика на
    # песента; при "unknown" пада на английски (най-широка YouTube
    # аудитория) вместо да гадае.
    song_lang = (track.get("language") or "unknown").lower()
    _LANG_NAMES = {
        "en": "английски", "bg": "български", "fr": "френски", "es": "испански",
        "de": "немски", "it": "италиански", "pt": "португалски", "ru": "руски",
        "tr": "турски", "ar": "арабски", "ko": "корейски", "ja": "японски",
    }
    lang_instruction = (
        f"описанието ТРЯБВА да е на {_LANG_NAMES.get(song_lang, song_lang)} "
        f"(езикът на самата песен, ISO код '{song_lang}')"
        if song_lang != "unknown"
        else "езикът на песента не е установен — пиши описанието на английски (най-широка YouTube аудитория)"
    )

    system_prompt = (
        "Ти си YouTube SEO експерт за музикални канали. Задачата ти: генерирай "
        "оптимизирани title/description/tags за ВЕЧЕ публикувана песен, за да "
        "подобриш discoverability (search + suggested), БЕЗ да променяш "
        "идентичността на песента (жанр, изпълнител, оригинално заглавие на "
        "песента остава разпознаваемо). Връщай САМО валиден JSON, нищо друго."
    )
    user_prompt = f"""Песен: "{track.get('title')}"
Жанр: {track.get('genre')} / {track.get('subgenre')}
Mood: {track.get('mood')}, Energy: {track.get('energy')}, Език: {track.get('language')}
Style tags: {', '.join(track.get('style_tags', [])) or '(няма)'}

Близки trending ниши точно сега (YouTube growth/competition сигнали):
{signals_txt}

Генерирай JSON с точно тази структура:
{{
  "titles": ["вариант 1", "вариант 2", "вариант 3"],
  "description": "описание (първите 2 реда трябва да съдържат най-важните ключови думи, преди 'Show more' прекъсването)",
  "tags": ["tag1", "tag2", ...]
}}

Правила:
- titles: до {MAX_TITLE_LEN} символа всеки, запази оригиналното заглавие на песента разпознаваемо (не го изтривай напълно)
- ЕЗИК: {lang_instruction}. Titles могат да останат смесени (изпълнител/фийчъринг имена на латиница е нормално), но description-ът трябва изцяло да е на този език — не превеждай на български по подразбиране.
- description: до {MAX_DESCRIPTION_LEN} символа, включи жанр/mood/style keywords естествено, НЕ spam
- tags: 15-25 тага, обща дължина под {MAX_TAGS_TOTAL_LEN} символа, смес от широки (жанр) и специфични (mood, style) термини — жанр tag-овете могат да останат на английски за по-добра международна discoverability, дори ако description-ът е на друг език
- Ако жанрът е специфично-български стил (чалга/кючек/поп-фолк), НЕ го превеждай — остави го както е"""

    result, provider = call_ai_json(system_prompt, user_prompt, max_tokens=1200)
    if result is None:
        log(f"❌ Никой AI provider не отговори за {video_id} — опитай пак по-късно.")
        return None

    titles = [t[:MAX_TITLE_LEN] for t in result.get("titles", []) if t][:3]
    description = (result.get("description") or "")[:MAX_DESCRIPTION_LEN]
    tags = result.get("tags", [])
    # твърд limit по обща дължина, за да не гръмне videos.update на YouTube страна
    total = 0
    trimmed_tags = []
    for t in tags:
        if total + len(t) + 1 > MAX_TAGS_TOTAL_LEN:
            break
        trimmed_tags.append(t)
        total += len(t) + 1

    if not titles or not description:
        log(f"⚠ AI отговорът за {video_id} е непълен (provider: {provider}) — прескачам.")
        return None

    suggestions = load_json(SUGGESTIONS_PATH, {"schema_version": 1, "items": {}})
    suggestions.setdefault("items", {})
    suggestions["items"][video_id] = {
        "video_id": video_id,
        "current_title": track.get("title"),
        "suggested_titles": titles,
        "suggested_description": description,
        "suggested_tags": trimmed_tags,
        "ai_provider": provider,
        "status": "pending",
        "generated_at": _now_iso(),
        "applied_at": None,
    }
    save_json(SUGGESTIONS_PATH, suggestions)
    log(f"✅ Генерирано предложение за '{track.get('title')}' (provider: {provider}) — "
        f"{len(titles)} заглавия, {len(trimmed_tags)} tags. Чака одобрение в Dashboard-а.")
    return suggestions["items"][video_id]


def apply_suggestion(video_id, chosen_title=None, force=False):
    """Прилага ВЕЧЕ одобрено предложение (status == 'approved', освен ако
    force=True) през videos.update. ВАЖНО: videos.update с part=snippet
    изисква ЦЕЛИЯ snippet обект — categoryId/defaultLanguage и т.н. трябва
    да се запазят от текущото видео, иначе YouTube ги трие мълчаливо."""
    suggestions = load_json(SUGGESTIONS_PATH, {"items": {}})
    item = suggestions.get("items", {}).get(video_id)
    if not item:
        log(f"❌ Няма предложение за {video_id} в data/metadata-suggestions.json.")
        return False
    if item["status"] != "approved" and not force:
        log(f"❌ Предложението за {video_id} е в статус '{item['status']}', не 'approved' — "
            f"одобри го от Dashboard-а първо (или --apply-force за bypass).")
        return False

    api_key = os.environ.get("YOUTUBE_API_KEY")
    access_token = get_oauth_access_token()  # разменя YOUTUBE_OAUTH_REFRESH_TOKEN (GitHub Secret) за краткотраен token
    if not access_token:
        log("❌ Липсва OAuth конфигурация (YOUTUBE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN secrets) — "
            "apply изисква write достъп, не само API key.")
        return False

    quota = QuotaBudget(budget_units=int(os.environ.get("YOUTUBE_QUOTA_BUDGET", "500")))
    yt = YouTubeClient(api_key=api_key, access_token=access_token, quota=quota)

    current = yt.get("videos", {"part": "snippet", "id": video_id}, "videos.list")
    items = current.get("items", [])
    if not items:
        log(f"❌ videos.list не намери {video_id} — изтрито/частно видео?")
        return False
    live_snippet = items[0]["snippet"]

    title = chosen_title or item["suggested_titles"][0]
    new_snippet = {
        **live_snippet,  # запазва categoryId, defaultLanguage, всичко останало
        "title": title,
        "description": item["suggested_description"],
        "tags": item["suggested_tags"],
    }
    try:
        yt.write("videos", {"part": "snippet"}, {"id": video_id, "snippet": new_snippet},
                 "videos.update", method="PUT")
    except RuntimeError as e:
        msg = str(e)
        if "HTTP 403" in msg:
            log(f"❌ YouTube отказа videos.update за {video_id} (HTTP 403). Това ТИПИЧНО значи "
                f"видеото е 'claim-нато' в Content ID/CMS системата на дистрибутор (DistroKid и "
                f"т.н.) при доставката — метаданните не се управляват през личен OAuth API, само "
                f"през самия дистрибутор (ако той изобщо предлага такава опция в неговия dashboard). "
                f"НЕ Е бъг в скрипта — YouTube буквално отказва достъп. Пълна грешка: {msg[:300]}")
        else:
            log(f"❌ videos.update неуспешен за {video_id}: {msg[:300]}")
        item["status"] = "failed"
        item["failed_reason"] = msg[:500]
        save_json(SUGGESTIONS_PATH, suggestions)
        return False

    item["status"] = "applied"
    item["applied_at"] = _now_iso()
    item["applied_title"] = title
    save_json(SUGGESTIONS_PATH, suggestions)
    log(f"✅ Приложено за {video_id}: '{title}'. Quota похарчена: {quota.spent} units.")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate", metavar="VIDEO_ID")
    parser.add_argument("--apply", metavar="VIDEO_ID")
    parser.add_argument("--apply-force", metavar="VIDEO_ID",
                         help="прилага дори ако статусът не е 'approved' (за ръчен CLI debug)")
    args = parser.parse_args()

    if args.generate:
        generate_suggestion(args.generate)
    elif args.apply:
        apply_suggestion(args.apply)
    elif args.apply_force:
        apply_suggestion(args.apply_force, force=True)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
