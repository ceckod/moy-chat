#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
whisper_subtitles.py — Word-by-Word Kinetic Subtitles Generator (Whisper AI)
(виж .github/workflows/render-pro-short.yml)

Вход:  --audio  MP3/WAV файл
Изход: --output  .ass файл, word-by-word "Alex Hormozi style":
       - ЕДНА активна дума на екрана в даден момент, точно на секундата
         на изпяване (word_timestamps=True)
       - Pop-in Zoom при поява (\\fscx120\\fscy120 → \\t(...)→100%)
       - Активна дума: ярък неонов цвят (подаден отвън, съобразен с темата
         на render_short_ffmpeg.py/ai_visualizer_director.py); дебел черен
         контур (Outline=6) за четимост върху всякакъв фон

Транскрипция на български: model.transcribe(..., language="bg",
word_timestamps=True).

ПРИНЦИП (виж master_engine.py / ai_visualizer_director.py — еднакъв за
целия pipeline): НИКОГА не чупи рендирането. Ако openai-whisper липсва
като пакет, аудиото няма реч (инструментал), или транскрипцията гръмне —
пишем ВАЛИДЕН, но празен .ass (само [Script Info]/[V4+ Styles] секции,
без [Events] редове) и излизаме с код 0. render_short_ffmpeg.py продължава
нормално — видеото излиза само без субтитри вместо изобщо да не излезе.
"""

import argparse
import sys

ASS_HEADER_TEMPLATE = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,{font},{fontsize},{active_color},&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,{outline},0,{alignment},60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _hex_to_ass_color(hex_color: str) -> str:
    """'#2be5c9' → ASS &HBBGGRR формат (ASS използва BGR, не RGB, и hex без #)."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        hex_color = "ffff00"  # неонов жълт fallback
    r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
    return f"&H00{b}{g}{r}".upper()


def _fmt_ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    cs = int(round((s - int(s)) * 100))
    return f"{h:d}:{m:02d}:{int(s):02d}.{cs:02d}"


def empty_ass(output_path: str, font="Arial", fontsize=84, active_color="#2be5c9",
              alignment=2, margin_v=280, outline=6) -> None:
    header = ASS_HEADER_TEMPLATE.format(
        font=font,
        fontsize=fontsize,
        active_color=_hex_to_ass_color(active_color),
        alignment=alignment,
        margin_v=margin_v,
        outline=outline,
    )
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(header)


def build_ass_from_words(words: list, output_path: str, *, font="Arial", fontsize=84,
                          active_color="#2be5c9", alignment=2, margin_v=280,
                          outline=6, pop_ms=140) -> int:
    """words: списък от {"word": str, "start": float, "end": float}.
    Връща броя записани реда (за лог/диагностика)."""
    header = ASS_HEADER_TEMPLATE.format(
        font=font,
        fontsize=fontsize,
        active_color=_hex_to_ass_color(active_color),
        alignment=alignment,
        margin_v=margin_v,
        outline=outline,
    )
    lines = []
    for w in words:
        text = str(w.get("word", "")).strip()
        if not text:
            continue
        start, end = float(w["start"]), float(w["end"])
        if end <= start:
            end = start + 0.25
        pop = min(pop_ms, int((end - start) * 1000 * 0.6))
        # Pop-in Zoom: тръгва от 120% и се отпуска до 100% за първите `pop` ms.
        tag = f"{{\\fscx120\\fscy120\\t(0,{pop},\\fscx100\\fscy100)}}"
        lines.append(
            f"Dialogue: 0,{_fmt_ts(start)},{_fmt_ts(end)},Word,,0,0,0,,{tag}{text}"
        )
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("\n".join(lines))
        if lines:
            f.write("\n")
    return len(lines)


def transcribe_and_build(audio_path: str, output_path: str, *, language="bg",
                          model_size="small", active_color="#2be5c9",
                          fontsize=84, alignment=2, margin_v=280) -> int:
    try:
        import whisper  # openai-whisper — тежка зависимост, само тук се импортва
    except ImportError as e:
        print(f"⚠ whisper_subtitles: openai-whisper не е инсталиран ({e}) — празни субтитри", file=sys.stderr)
        empty_ass(output_path, active_color=active_color, fontsize=fontsize, alignment=alignment, margin_v=margin_v)
        return 0

    try:
        model = whisper.load_model(model_size)
        result = model.transcribe(audio_path, language=language, word_timestamps=True, verbose=False)
        words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []) or []:
                words.append({"word": w.get("word", ""), "start": w.get("start", 0.0), "end": w.get("end", 0.0)})
        if not words:
            print("⚠ whisper_subtitles: Whisper не върна нито една дума (вероятно инструментал) — празни субтитри", file=sys.stderr)
            empty_ass(output_path, active_color=active_color, fontsize=fontsize, alignment=alignment, margin_v=margin_v)
            return 0
        n = build_ass_from_words(
            words, output_path,
            active_color=active_color, fontsize=fontsize, alignment=alignment, margin_v=margin_v,
        )
        print(f"✓ whisper_subtitles: {n} думи транскрибирани", file=sys.stderr)
        return n
    except Exception as e:  # noqa: BLE001 — транскрипцията никога не бива да чупи рендирането
        print(f"⚠ whisper_subtitles: транскрипцията се провали ({e}) — празни субтитри", file=sys.stderr)
        empty_ass(output_path, active_color=active_color, fontsize=fontsize, alignment=alignment, margin_v=margin_v)
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--output", required=True, help="изходен .ass файл")
    ap.add_argument("--language", default="bg")
    ap.add_argument("--model-size", default="small", choices=["tiny", "base", "small", "medium", "large"])
    ap.add_argument("--active-color", default="#2be5c9", help="hex цвят на активната дума (theme.primary_color)")
    ap.add_argument("--fontsize", type=int, default=84)
    ap.add_argument("--alignment", type=int, default=2, help="ASS alignment (2=долу center, 5=среда center)")
    ap.add_argument("--margin-v", type=int, default=280)
    args = ap.parse_args()

    transcribe_and_build(
        args.audio, args.output,
        language=args.language, model_size=args.model_size,
        active_color=args.active_color, fontsize=args.fontsize,
        alignment=args.alignment, margin_v=args.margin_v,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
