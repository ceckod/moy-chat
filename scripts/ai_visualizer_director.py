#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ai_visualizer_director.py — Gemini AI Анализатор & Режисьор
(виж .github/workflows/render-pro-short.yml)

Вход:  --audio  път до MP3 файл (сваления preview/пълен трак)
Изход: JSON конфигурация (stdout по подразбиране, или --output файл),
       консумирана от scripts/render_short_ffmpeg.py:

{
  "title": "...",
  "description": "...",
  "hook_text": "...",
  "hashtags": ["#...", "#..."],
  "theme": "neon_particles",
  "primary_color": "#RRGGBB",
  "secondary_color": "#RRGGBB",
  "blur_amount": 20,
  "brightness": -0.15,
  "genre": "...",
  "tempo_bpm": 128,
  "mood": "..."
}

ПРИНЦИП (същия като останалата част от repo-то, виж master_engine.py):
никога не чупи pipeline-а. Ако GEMINI_API_KEY липсва, HTTP извикването се
провали, JSON-ът на Gemini е невалиден, или темата не е в познатия ни
списък от 8 — falbback() поема, пише СТРУКТУРНО ВАЛИДЕН JSON (детерминиран,
базиран само на файлово име/подадени аргументи) на stdout/файл, и скриптът
излиза с код 0. render_short_ffmpeg.py винаги получава използваем JSON.
Причината за грешката отива на stderr (вижда се в GitHub Actions лога),
никога не влиза в самия JSON изход.

Модел: gemini-2.5-flash (мултимодален, приема audio/mpeg inlineـdata) —
същият endpoint формат като gemini.js/agent-roster.js в останалата част
на проекта (v1beta/models/{model}:generateContent?key=...), само че тук
викан от Python (server-side, GitHub Actions), не от браузъра.
"""

import argparse
import base64
import json
import os
import re
import sys

import requests

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
)

# Библиотеката от 8 визуални стила — вижте render_short_ffmpeg.py THEME_BUILDERS
# за реалната имплементация на всеки. Списъкът тук е single source of truth за
# валидация — ако Gemini върне тема извън този списък, отиваме на fallback.
VALID_THEMES = [
    "neon_particles",
    "circular_glow",
    "particle_field_3d",
    "synthwave_wave",
    "minimal_monochromatic",
    "frosted_glass_ui",
    "vertical_lyrics",
    "glitch_aesthetics",
]

HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

PROMPT_TEMPLATE = """Ти си AI режисьор за вертикални (9:16) YouTube Shorts / TikTok видеа.
Ще чуеш аудио откъс от песен на български изпълнител "{artist}" със заглавие
"{song}". Анализирай жанра, темпото (BPM), енергията и емоцията на песента.

Върни САМО валиден JSON обект (без markdown, без ```json блок, без никакъв
друг текст преди или след), с точно следните полета:

{{
  "title": "кратко, привличащо заглавие за Shorts (до 60 символа)",
  "description": "1-2 изречения описание за описанието на видеото",
  "hook_text": "текст-кука за първите 3 секунди на видеото (напр. 'Чуй баса на 0:15!')",
  "hashtags": ["до 8 хаштага, релевантни за жанра/настроението, с # отпред"],
  "theme": "точно едно от: {themes}",
  "primary_color": "#RRGGBB — основен неонов цвят, съобразен с жанра/енергията",
  "secondary_color": "#RRGGBB — вторичен/допълващ цвят за градиент",
  "blur_amount": число между 10 и 35 — колко силно да е замъглен фонът,
  "brightness": число между -0.35 и -0.05 — колко да е затъмнен фонът,
  "genre": "жанр на песента",
  "tempo_bpm": число — приблизителен BPM,
  "mood": "емоция/настроение с 1-2 думи"
}}

Избери theme според музиката: агресивен трап/клуб → neon_particles; спокойна/
елегантна балада → minimal_monochromatic или frosted_glass_ui; ретро/synth →
synthwave_wave; фокус върху текста/лириката → vertical_lyrics; експериментална/
глич звучене → glitch_aesthetics; всичко друго → circular_glow или
particle_field_3d по твоя преценка.
"""


def _extract_json(text: str) -> dict:
    """Gemini понякога обгражда JSON-а с ```json ... ``` въпреки инструкцията —
    сваляме fence-овете и парсваме първия {...} блок в текста."""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("няма { } блок в отговора на Gemini")
    return json.loads(cleaned[start : end + 1])


def _validate(cfg: dict) -> dict:
    """Хвърля ValueError при първото невалидно поле — вика се от main() в
    try/except, невалидност винаги води до fallback(), никога до частично
    невалиден JSON на изхода."""
    theme = cfg.get("theme")
    if theme not in VALID_THEMES:
        raise ValueError(f"невалидна тема от Gemini: {theme!r}")
    for key in ("primary_color", "secondary_color"):
        if not HEX_RE.match(str(cfg.get(key, ""))):
            raise ValueError(f"невалиден hex цвят за {key}: {cfg.get(key)!r}")
    cfg["blur_amount"] = max(10, min(35, float(cfg.get("blur_amount", 20))))
    cfg["brightness"] = max(-0.35, min(-0.05, float(cfg.get("brightness", -0.15))))
    cfg.setdefault("hashtags", [])
    if not isinstance(cfg["hashtags"], list):
        raise ValueError("hashtags не е списък")
    cfg["hashtags"] = [h if str(h).startswith("#") else f"#{h}" for h in cfg["hashtags"]][:8]
    cfg.setdefault("title", "")
    cfg.setdefault("description", "")
    cfg.setdefault("hook_text", "")
    cfg.setdefault("genre", "")
    cfg.setdefault("mood", "")
    try:
        cfg["tempo_bpm"] = int(float(cfg.get("tempo_bpm", 0))) or None
    except (TypeError, ValueError):
        cfg["tempo_bpm"] = None
    return cfg


def fallback(song: str, artist: str, reason: str) -> dict:
    """Детерминиран, винаги-валиден резултат — БЕЗ мрежа, БЕЗ Gemini. Темата се
    избира стабилно (hash на заглавието), за да не е винаги първата в списъка,
    ако fallback-ът се задейства за много песни подред."""
    print(f"⚠ ai_visualizer_director: fallback ({reason})", file=sys.stderr)
    theme = VALID_THEMES[abs(hash(song or artist)) % len(VALID_THEMES)]
    return {
        "title": f"{artist} — {song}" if artist and song else (song or artist or "Ново парче"),
        "description": f"Ново парче от {artist}." if artist else "Ново парче.",
        "hook_text": "Чуй това! 🔥",
        "hashtags": ["#music", "#newmusic", "#shorts", "#cdbrecords"],
        "theme": theme,
        "primary_color": "#2be5c9",
        "secondary_color": "#ff2ec4",
        "blur_amount": 20,
        "brightness": -0.15,
        "genre": "",
        "tempo_bpm": None,
        "mood": "",
    }


def analyze(audio_path: str, song: str, artist: str) -> dict:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return fallback(song, artist, "липсва GEMINI_API_KEY")

    try:
        with open(audio_path, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("ascii")
    except OSError as e:
        return fallback(song, artist, f"не мога да прочета аудио файла: {e}")

    prompt = PROMPT_TEMPLATE.format(artist=artist or "?", song=song or "?", themes=", ".join(VALID_THEMES))
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": "audio/mpeg", "data": audio_b64}},
                ]
            }
        ],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
    }

    try:
        resp = requests.post(
            f"{GEMINI_ENDPOINT}?key={api_key}",
            json=payload,
            timeout=90,
        )
        resp.raise_for_status()
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        cfg = _extract_json(text)
        cfg = _validate(cfg)
        return cfg
    except Exception as e:  # noqa: BLE001 — умишлено широко: НИЩО от Gemini не бива да чупи pipeline-а
        return fallback(song, artist, f"Gemini заявка/парсване се провали: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio", required=True, help="път до MP3 файл за анализ")
    ap.add_argument("--song", default="", help="заглавие на песента")
    ap.add_argument("--artist", default="", help="име на изпълнителя")
    ap.add_argument("--output", default="-", help="изходен JSON файл (по подразбиране stdout)")
    args = ap.parse_args()

    cfg = analyze(args.audio, args.song, args.artist)
    out = json.dumps(cfg, ensure_ascii=False, indent=2)

    if args.output == "-":
        print(out)
    else:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
