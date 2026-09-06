#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_short_ffmpeg.py — Сървърен FFmpeg Engine за 60 FPS 9:16 Shorts
(виж .github/workflows/render-pro-short.yml)

Оркестрира целия pipeline за ЕДНА песен:
  1) сваля audio_url + cover_url (requests, стриймвано на диск)
  2) вика ai_visualizer_director.analyze() → тема/цветове/hook/метаданни
     (fallback вграден в самия модул — виж коментарите там)
  3) извлича реален bass-envelope от аудиото (numpy + scipy bandpass
     40-150Hz) → сценарий за beat-flash (sendcmd + eq=brightness, виж
     "ЗАЩО sendcmd+eq" по-долу)
  4) вика whisper_subtitles.transcribe_and_build() → .ass word-by-word
     субтитри, оцветени с primary_color на избраната тема
  5) генерира еднократни (не per-frame!) PNG помощни asset-и с Pillow —
     стъклена карта / кръгла маска / пулсиращо ветрило (halo) — според
     избраната тема (виж THEME_BUILDERS)
  6) сглобява финалния `ffmpeg -filter_complex` граф (Слой 1-5 от
     спецификацията) и рендира 1080x1920 @ 60fps, -crf 17, libx264,
     320kbps AAC
  7) обновява data/distrokid-library.json с генерирания short (за да
     знае dashboard-ът кое парче вече си има Shorts)

ЗАЩО sendcmd+eq ЗА BEAT-FLASH (не envelope-video/blend):
`eq` филтърът поддържа runtime commands (виж `ffmpeg -filters` → флаг "C"
до eq) — sendcmd може директно да сменя brightness на точните секунди на
бас удара, извлечени от реалния аудио сигнал. По-просто, по-евтино
(без допълнителен generated video track за blend) и по-точно от
envelope-blend подход.

ЗАЩО РЕАЛНИТЕ PNG ASSET-И СА ЕДНОКРАТНИ:
Pillow рисува стъклената карта/halo/маската ВЕДНЪЖ (статични изображения),
после ffmpeg ги overlay-ва като нормален видео слой. Per-frame Python
рендиране на цяло 60fps видео би било жестоко бавно на безплатен GitHub
Actions runner — затова всичко "динамично" (waveform/спектър/beat-flash)
е ffmpeg-нативно (showwaves/showfreqs/sendcmd), не Python per-frame.
"""

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import uuid

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ai_visualizer_director as director  # noqa: E402
import whisper_subtitles  # noqa: E402

W, H = 1080, 1920
FPS = 60
LIBRARY_JSON = os.path.join("data", "distrokid-library.json")


# ───────────────────────── помощни общи функции ─────────────────────────

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def download(url: str, dest: str, timeout=120) -> str:
    r = requests.get(url, stream=True, timeout=timeout)
    r.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in r.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
    return dest


def run(cmd: list) -> None:
    log("$ " + " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log(proc.stderr[-4000:])
        raise RuntimeError(f"команда се провали (код {proc.returncode}): {cmd[0]}")


def hex_to_rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def ffmpeg_escape_path(p: str) -> str:
    """Пътища подадени вътре в -filter_complex (ass=..., за Windows-style
    двоеточия) трябва да се ескейпват — тук достатъчно е да escape-нем
    евентуални ':' и обратни наклонени черти (Linux runner, но по-безопасно)."""
    return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


# ───────────────────────── 1) beat-envelope извличане ─────────────────────────

def extract_beat_flash_cmds(audio_path: str, out_cmds_path: str, *, intensity=0.32,
                             flash_ms=90, min_gap=0.22, threshold_pct=82) -> int:
    """Реален bass-envelope от аудиото (не placeholder): декодира на 4kHz моно,
    band-pass 40-150Hz (scipy Butterworth), RMS envelope на 50ms прозорци,
    засича пикове над threshold_pct персентил с минимална дистанция min_gap.
    Пише sendcmd-съвместим текстов файл: "T eq brightness I; T+flash eq brightness 0;"
    Връща брой засечени удара (за лог)."""
    from scipy import signal

    sr = 4000
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", audio_path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    sig = np.frombuffer(proc.stdout, dtype=np.float32)
    if sig.size < sr:  # твърде кратко/празно аудио — без удари, но не гърми
        open(out_cmds_path, "w").close()
        return 0

    sos = signal.butter(4, [40, 150], btype="bandpass", fs=sr, output="sos")
    bass = signal.sosfilt(sos, sig)

    frame = int(sr * 0.05)  # 50ms
    n_frames = len(bass) // frame
    if n_frames < 2:
        open(out_cmds_path, "w").close()
        return 0
    env = np.sqrt(np.mean(bass[: n_frames * frame].reshape(n_frames, frame) ** 2, axis=1))
    env = env / (env.max() + 1e-9)

    thresh = np.percentile(env, threshold_pct)
    thresh = max(thresh, 0.15)  # тих/инструментален пасаж → не флашвай на шум

    lines = []
    last_t = -10.0
    flash_s = flash_ms / 1000.0
    for i, v in enumerate(env):
        t = i * 0.05
        if v >= thresh and (t - last_t) >= min_gap:
            lines.append(f"{t:.3f} eq brightness {intensity:.3f};")
            lines.append(f"{t + flash_s:.3f} eq brightness 0;")
            last_t = t

    with open(out_cmds_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    return len(lines) // 2


# ───────────────────────── 2) еднократни PNG asset-и (Pillow) ─────────────────────────

def make_rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def make_circle_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def load_cover_square(cover_path: str, size: int) -> Image.Image:
    im = Image.open(cover_path).convert("RGB")
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    return im.resize((size, size), Image.LANCZOS)


def build_glass_card(cover_path: str, out_path: str, size=760, radius=56) -> None:
    """frosted_glass_ui: обложката, силно замъглена и изсветлена под матиран
    бял слой, изрязана в заоблен правоъгълник + тънка полу-прозрачна рамка."""
    cover = load_cover_square(cover_path, size).convert("RGBA")
    frosted = cover.filter(ImageFilter.GaussianBlur(radius=6))
    white_overlay = Image.new("RGBA", (size, size), (255, 255, 255, 60))
    frosted = Image.alpha_composite(frosted, white_overlay)
    # По-остра, неразмазана мини-версия на обложката по средата (реалистичен "UI card" вид)
    sharp = load_cover_square(cover_path, int(size * 0.62)).convert("RGBA")
    frosted.alpha_composite(sharp, ((size - sharp.width) // 2, (size - sharp.height) // 2))
    mask = make_rounded_mask(size, radius)
    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    card.paste(frosted, (0, 0), mask)
    d = ImageDraw.Draw(card)
    d.rounded_rectangle([1, 1, size - 2, size - 2], radius=radius, outline=(255, 255, 255, 140), width=3)
    card.save(out_path)


def build_circle_cover(cover_path: str, out_path: str, size=700) -> None:
    cover = load_cover_square(cover_path, size).convert("RGBA")
    mask = make_circle_mask(size)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(cover, (0, 0), mask)
    out.save(out_path)


def build_square_card(cover_path: str, out_path: str, size: int, border_rgb=None) -> None:
    cover = load_cover_square(cover_path, size).convert("RGBA")
    if border_rgb:
        d = ImageDraw.Draw(cover)
        d.rectangle([0, 0, size - 1, size - 1], outline=border_rgb + (255,), width=6)
    cover.save(out_path)


def build_halo(out_path: str, primary_hex: str, secondary_hex: str, size=900) -> None:
    """circular_glow: мек радиален градиент (halo), overlay-нат ЗАД обложката,
    после самò той минава през beat-flash sendcmd → изглежда като пулсиращ
    кръгов ореол в ритъма на баса."""
    pr = np.array(hex_to_rgb(primary_hex), dtype=np.float32)
    sc = np.array(hex_to_rgb(secondary_hex), dtype=np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    cx = cy = size / 2
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (size / 2)
    dist = np.clip(dist, 0, 1)
    t = dist[..., None]
    rgb = pr[None, None, :] * (1 - t) + sc[None, None, :] * t
    alpha = np.clip(255 * (1 - dist) ** 1.6, 0, 255)
    alpha[dist > 1] = 0
    arr = np.dstack([rgb, alpha]).astype(np.uint8)
    Image.fromarray(arr, mode="RGBA").save(out_path)


def build_particle_dots(out_path: str, color_hex: str, size=(1080, 260)) -> None:
    """Статичен фон-слой за particle_field_3d — леки полу-прозрачни точки
    в мрежа; реалното "движение" идва от showfreqs overlay-нат отгоре му
    (виж THEME_BUILDERS['particle_field_3d'])."""
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    rgb = hex_to_rgb(color_hex)
    step = 40
    for y in range(0, size[1], step):
        for x in range(0, size[0], step):
            r = 2 + (2 if (x // step + y // step) % 2 == 0 else 0)
            d.ellipse([x - r, y - r, x + r, y + r], fill=rgb + (70,))
    im.save(out_path)


# ───────────────────────── 3) 8-те визуални теми ─────────────────────────
# Всяка builder функция получава ctx (dict) и връща filter_complex ФРАГМЕНТ
# (низ), който очаква вход [bg] (замъгления/затъмнен фон, вече наличен по-
# горе в графа) и трябва да завърши с изходен label [themed]. Може да
# добавя допълнителни -i входове през ctx["add_input"](path).


def theme_neon_particles(ctx):
    size = 640
    card = os.path.join(ctx["tmp"], "card.png")
    build_square_card(ctx["cover"], card, size, border_rgb=hex_to_rgb(ctx["primary"]))
    i_card = ctx["add_input"](card, loop=True)
    colors = f"{ctx['primary']}|{ctx['secondary']}"
    # ВАЖНО: [nc_freq_a] се ползва като вход за ДВА различни филтъра (gblur
    # за glow-копието + директно за overlay) — ffmpeg изисква изричен
    # `split`, за да разреши един label да "захранва" повече от един filter
    # надолу по графа (потвърдено с минимален repro: без split връща
    # "Invalid stream specifier" / "matches no streams").
    return f"""
[{i_card}:v]format=rgba[nc_card];
[bg][nc_card]overlay=(W-w)/2:340[nc_c1];
[1:a]showfreqs=s=1000x260:mode=dot:ascale=cbrt:colors={colors},format=rgba,
     colorkey=0x000000:0.25:0.08[nc_freq_a];
[nc_freq_a]split=2[nc_freq_a1][nc_freq_a2];
[nc_freq_a1]gblur=sigma=6[nc_freq_glow];
[nc_c1][nc_freq_glow]overlay=(W-w)/2:1420:format=auto[nc_c2];
[nc_c2][nc_freq_a2]overlay=(W-w)/2:1420:format=auto[themed]
""".strip()


def theme_circular_glow(ctx):
    size = 620
    halo_size = 900
    circle = os.path.join(ctx["tmp"], "circle.png")
    halo = os.path.join(ctx["tmp"], "halo.png")
    build_circle_cover(ctx["cover"], circle, size)
    build_halo(halo, ctx["primary"], ctx["secondary"], halo_size)
    i_halo = ctx["add_input"](halo, loop=True)
    i_circle = ctx["add_input"](circle, loop=True)
    return f"""
[{i_halo}:v]format=rgba,sendcmd=f={ctx['cmds_esc']},eq=brightness=0[cg_halo];
[bg][cg_halo]overlay=(W-w)/2:(H-h)/2-260[cg_1];
[{i_circle}:v]format=rgba[cg_circle];
[cg_1][cg_circle]overlay=(W-w)/2:(H-h)/2-260[themed]
""".strip()


def theme_particle_field_3d(ctx):
    size = 620
    card = os.path.join(ctx["tmp"], "card.png")
    dots = os.path.join(ctx["tmp"], "dots.png")
    build_square_card(ctx["cover"], card, size)
    build_particle_dots(dots, ctx["secondary"])
    i_card = ctx["add_input"](card, loop=True)
    i_dots = ctx["add_input"](dots, loop=True)
    colors = f"{ctx['primary']}|{ctx['secondary']}"
    return f"""
[{i_dots}:v]format=rgba[pf_dots];
[bg][pf_dots]overlay=0:280[pf_0];
[1:a]showfreqs=s=1080x220:mode=line:ascale=cbrt:win_size=1024:colors={colors},
     format=rgba,colorkey=0x000000:0.25:0.08[pf_wave1];
[1:a]showfreqs=s=1080x220:mode=dot:ascale=cbrt:win_size=4096:colors={ctx['secondary']},
     format=rgba,colorkey=0x000000:0.25:0.08[pf_wave2];
[pf_0][pf_wave1]overlay=0:300:format=auto[pf_1];
[pf_1][pf_wave2]overlay=0:1500:format=auto[pf_2];
[{i_card}:v]format=rgba[pf_card];
[pf_2][pf_card]overlay=(W-w)/2:340[themed]
""".strip()


def theme_synthwave_wave(ctx):
    size = 620
    card = os.path.join(ctx["tmp"], "card.png")
    build_square_card(ctx["cover"], card, size)
    i_card = ctx["add_input"](card, loop=True)
    colors = f"{ctx['primary']}|{ctx['secondary']}"
    return f"""
[bg]drawgrid=x=0:y=1300:w=90:h=90:c={ctx['secondary']}@0.35:t=2[sw_grid];
[1:a]showwaves=s=1080x300:mode=cline:colors={colors},format=rgba,
     colorkey=0x000000:0.25:0.08,gblur=sigma=2[sw_wave];
[sw_grid][sw_wave]overlay=0:1380:format=auto[sw_1];
[{i_card}:v]format=rgba[sw_card];
[sw_1][sw_card]overlay=(W-w)/2:300[themed]
""".strip()


def theme_minimal_monochromatic(ctx):
    size = 600
    card = os.path.join(ctx["tmp"], "card.png")
    build_square_card(ctx["cover"], card, size)
    i_card = ctx["add_input"](card, loop=True)
    return f"""
[1:a]showwaves=s=900x140:mode=line:colors=white,format=rgba,
     colorkey=0x000000:0.2:0.06[mm_wave];
[bg][mm_wave]overlay=(W-w)/2:1500:format=auto[mm_1];
[{i_card}:v]format=rgba[mm_card];
[mm_1][mm_card]overlay=(W-w)/2:400[themed]
""".strip()


def theme_frosted_glass_ui(ctx):
    size = 760
    card = os.path.join(ctx["tmp"], "glass_card.png")
    build_glass_card(ctx["cover"], card, size)
    i_card = ctx["add_input"](card, loop=True)
    return f"""
[{i_card}:v]format=rgba[fg_card];
[bg][fg_card]overlay=(W-w)/2:(H-h)/2-160[themed]
""".strip()


def theme_vertical_lyrics(ctx):
    size = 420  # малка миниатюра — фокусът е субтитрите (по-голям fontsize, виж caller)
    card = os.path.join(ctx["tmp"], "card.png")
    build_square_card(ctx["cover"], card, size, border_rgb=hex_to_rgb(ctx["primary"]))
    i_card = ctx["add_input"](card, loop=True)
    return f"""
[1:a]showwaves=s=700x90:mode=cline:colors={ctx['primary']},format=rgba,
     colorkey=0x000000:0.2:0.06[vl_wave];
[bg][vl_wave]overlay=(W-w)/2:1750:format=auto[vl_1];
[{i_card}:v]format=rgba[vl_card];
[vl_1][vl_card]overlay=(W-w)/2:220[themed]
""".strip()


def theme_glitch_aesthetics(ctx):
    size = 620
    card = os.path.join(ctx["tmp"], "card.png")
    build_square_card(ctx["cover"], card, size)
    i_card = ctx["add_input"](card, loop=True)
    glitch_cmds = os.path.join(ctx["tmp"], "glitch_cmds.txt")
    _build_glitch_cmds(ctx["beat_times"], glitch_cmds)
    glitch_cmds_esc = ffmpeg_escape_path(glitch_cmds)
    return f"""
[bg]noise=alls=14:allf=t[ga_noise];
[ga_noise]sendcmd=f={glitch_cmds_esc},rgbashift=rh=0:bh=0[ga_glitch];
[{i_card}:v]format=rgba[ga_card];
[ga_glitch][ga_card]overlay=(W-w)/2:340[themed]
""".strip()


def _build_glitch_cmds(beat_times, out_path):
    lines = []
    for t in beat_times:
        lines.append(f"{t:.3f} rgbashift rh 8;")
        lines.append(f"{t:.3f} rgbashift bh -8;")
        lines.append(f"{t + 0.07:.3f} rgbashift rh 0;")
        lines.append(f"{t + 0.07:.3f} rgbashift bh 0;")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


THEME_BUILDERS = {
    "neon_particles": theme_neon_particles,
    "circular_glow": theme_circular_glow,
    "particle_field_3d": theme_particle_field_3d,
    "synthwave_wave": theme_synthwave_wave,
    "minimal_monochromatic": theme_minimal_monochromatic,
    "frosted_glass_ui": theme_frosted_glass_ui,
    "vertical_lyrics": theme_vertical_lyrics,
    "glitch_aesthetics": theme_glitch_aesthetics,
}

# theme → (fontsize, alignment, margin_v) за whisper_subtitles.
# alignment: ASS 2 = долу center, 5 = среда center (vertical_lyrics — по-едро и по-нагоре).
THEME_SUBTITLE_STYLE = {
    "neon_particles": (78, 2, 250),
    "circular_glow": (78, 2, 260),
    "particle_field_3d": (72, 2, 320),
    "synthwave_wave": (76, 2, 300),
    "minimal_monochromatic": (64, 2, 220),
    "frosted_glass_ui": (74, 2, 240),
    "vertical_lyrics": (104, 5, 0),
    "glitch_aesthetics": (80, 2, 260),
}


# ───────────────────────── 4) главен рендер ─────────────────────────

def render(args) -> dict:
    tmp = tempfile.mkdtemp(prefix="cdb_short_")
    try:
        audio_path = os.path.join(tmp, "audio.mp3")
        cover_path = os.path.join(tmp, "cover.jpg")
        log(f"⏬ свалям аудио: {args.audio_url}")
        download(args.audio_url, audio_path)
        log(f"⏬ свалям обложка: {args.cover_url}")
        download(args.cover_url, cover_path)

        log("🤖 Gemini AI анализ...")
        cfg = director.analyze(audio_path, args.song_title, args.artist_name)
        theme = cfg["theme"]
        log(f"   тема: {theme} | цветове: {cfg['primary_color']} / {cfg['secondary_color']}")

        log("🥁 извличам bass-envelope за beat-flash...")
        cmds_path = os.path.join(tmp, "beat_flash_cmds.txt")
        n_beats = extract_beat_flash_cmds(audio_path, cmds_path)
        log(f"   {n_beats} бас удара засечени")
        beat_times = []
        if os.path.exists(cmds_path):
            with open(cmds_path, encoding="utf-8") as f:
                for line in f:
                    if " eq brightness " in line and not line.split()[2].startswith("0"):
                        beat_times.append(float(line.split()[0]))

        log("📝 Whisper транскрипция...")
        ass_path = os.path.join(tmp, "subtitles.ass")
        fontsize, alignment, margin_v = THEME_SUBTITLE_STYLE[theme]
        whisper_subtitles.transcribe_and_build(
            audio_path, ass_path,
            language="bg", model_size=args.whisper_model,
            active_color=cfg["primary_color"], fontsize=fontsize,
            alignment=alignment, margin_v=margin_v,
        )

        inputs = ["-loop", "1", "-i", cover_path, "-i", audio_path]
        input_specs = [("cover", False), ("audio", False)]

        def add_input(path, loop=False):
            idx = len(input_specs)
            if loop:
                inputs.extend(["-loop", "1", "-i", path])
            else:
                inputs.extend(["-i", path])
            input_specs.append((path, loop))
            return idx

        ctx = {
            "cover": cover_path,
            "tmp": tmp,
            "primary": cfg["primary_color"],
            "secondary": cfg["secondary_color"],
            "add_input": add_input,
            "cmds_esc": ffmpeg_escape_path(cmds_path),
            "beat_times": beat_times,
        }

        bg = (
            f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
            f"gblur=sigma={cfg['blur_amount']},eq=brightness={cfg['brightness']}[bg]"
        )
        theme_fragment = THEME_BUILDERS[theme](ctx)

        # circular_glow и glitch_aesthetics си карат собствен sendcmd/beat ефект
        # ВЪТРЕ в темата (halo pulse / rgbashift), затова НЕ прилагаме и общия
        # whole-frame beat-flash отгоре — би дублирало ефекта до претрупване.
        if theme in ("circular_glow", "glitch_aesthetics"):
            post_theme_label = "themed"
        else:
            theme_fragment += f";\n[themed]sendcmd=f={ctx['cmds_esc']},eq=brightness=0[flashed]"
            post_theme_label = "flashed"

        # Лого (ако assets/cdb_logo.png липсва в repo-то, слоят се прескача —
        # НЕ гърми рендирането, само лог предупреждение).
        logo_fragment = ""
        final_pre_ass = post_theme_label
        if args.logo and os.path.isfile(args.logo):
            i_logo = add_input(args.logo, loop=True)
            logo_fragment = (
                f";\n[{i_logo}:v]format=rgba,scale=220:-1,colorchannelmixer=aa=0.85[logo1]"
                f";\n[{post_theme_label}][logo1]overlay=W-w-30:50:format=auto[withlogo]"
            )
            final_pre_ass = "withlogo"
        else:
            log(f"⚠ лого не е намерено ({args.logo}) — пропускам брандинг слоя")

        # Auto-Hook Intro (първите 3 секунди), fade in/out.
        hook_text = cfg["hook_text"].replace("'", "\u2019").replace(":", "\uFF1A")
        hook_fragment = (
            f";\n[{final_pre_ass}]drawtext=text='{hook_text}':fontsize=64:"
            f"fontcolor={cfg['primary_color']}:borderw=4:bordercolor=black@0.8:"
            f"x=(w-text_w)/2:y=180:"
            f"alpha='if(lt(t,0.3),t/0.3,if(lt(t,2.6),1,if(lt(t,3),(3-t)/0.4,0)))'"
            f"[hooked]"
        )

        ass_esc = ffmpeg_escape_path(ass_path)
        subs_fragment = f";\n[hooked]ass='{ass_esc}'[vout]"

        filter_complex = "\n".join(
            [bg + ";", theme_fragment.rstrip(";") + logo_fragment + hook_fragment + subs_fragment]
        )

        out_path = args.output
        cmd = (
            ["ffmpeg", "-y"]
            + inputs
            + [
                "-filter_complex", filter_complex,
                "-map", "[vout]", "-map", "1:a",
                "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
                "-shortest", out_path,
            ]
        )
        log("🎬 рендирам финалното видео...")
        run(cmd)
        log(f"✅ готово: {out_path}")

        return {
            "output": out_path,
            "title": cfg["title"],
            "description": cfg["description"],
            "hashtags": cfg["hashtags"],
            "theme": theme,
            "primary_color": cfg["primary_color"],
            "secondary_color": cfg["secondary_color"],
            "beats_detected": n_beats,
        }
    finally:
        if not args.keep_tmp:
            shutil.rmtree(tmp, ignore_errors=True)


# ───────────────────────── 5) обновяване на distrokid-library.json ─────────────────────────

def update_library(song: str, artist: str, report: dict) -> bool:
    """Търси запис по (artist, song) в data/distrokid-library.json и добавя/
    обновява поле "shorts" (списък генерирани клипове). НЕ пипа нищо друго
    в JSON-а — запазва indent=2/ensure_ascii=False стила на останалия repo.
    Връща True ако е намерен и обновен запис (за лог в workflow-а)."""
    if not os.path.isfile(LIBRARY_JSON):
        log(f"⚠ {LIBRARY_JSON} не е намерен — пропускам обновяването")
        return False
    with open(LIBRARY_JSON, encoding="utf-8") as f:
        lib = json.load(f)

    found = False
    for entry in lib:
        if entry.get("artist") == artist and entry.get("song") == song:
            entry.setdefault("shorts", [])
            entry["shorts"].append(
                {
                    "id": uuid.uuid4().hex[:8],
                    "theme": report["theme"],
                    "title": report["title"],
                    "description": report["description"],
                    "hashtags": report["hashtags"],
                }
            )
            found = True
            break

    if not found:
        log(f"⚠ няма запис за artist={artist!r} song={song!r} в {LIBRARY_JSON} — пропускам")
        return False

    with open(LIBRARY_JSON, "w", encoding="utf-8") as f:
        json.dump(lib, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio-url", required=True)
    ap.add_argument("--cover-url", required=True)
    ap.add_argument("--song-title", required=True)
    ap.add_argument("--artist-name", required=True)
    ap.add_argument("--output", required=True, help="изходен .mp4 път")
    ap.add_argument("--logo", default="assets/cdb_logo.png")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--update-library", action="store_true",
                     help="обнови data/distrokid-library.json след успешен рендер")
    ap.add_argument("--report-json", default=None, help="запиши JSON отчет за workflow-а")
    ap.add_argument("--keep-tmp", action="store_true")
    args = ap.parse_args()

    report = render(args)

    if args.update_library:
        update_library(args.song_title, args.artist_name, report)

    if args.report_json:
        with open(args.report_json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
