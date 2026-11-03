#!/usr/bin/env python3
"""Kinetic text video renderer — без приложения (само Python + ffmpeg).

Папка на job-а (kinetic-jobs/<име>/): scenario.json + снимки + аудио.
  python scripts/kinetic_render.py --job kinetic-jobs/demo --out out/demo.mp4

scenario.json:
{ "style": "slam_red", "font": "russoone", "max_seconds": 30, "audio_start": 0,
  "scenes": [ {"text": "NEW OPUS", "image": "1.jpg"},
              {"text": "ARE YOU KIDDING", "image": "2.jpg", "effect": "glitch"} ] }
Ефекти: slam, glitch, stretch, zoom, slide. Стилове: slam_red, glitch, stretch, zoom_punch, clean.
Сцена без снимка = плътен цвят (като в примерното видео). Резките смени се лепят на бийтовете.
"""
import argparse, glob, json, os, random, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import find_peaks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = {"russoone": "RussoOne.ttf", "oswald": "Oswald.ttf", "montserrat": "Montserrat.ttf",
         "unbounded": "Unbounded.ttf"}
STYLES = {
    "slam_red":   dict(effect="slam",    accent="#ff1e2d", flash=.35, shake=16, zoom=.10, dim=.45, solids=["#e10600", "#0b0b0b", "#f2f2f2"]),
    "glitch":     dict(effect="glitch",  accent="#00f0ff", flash=.20, shake=10, zoom=.08, dim=.50, solids=["#0b0b0b", "#141432", "#f2f2f2"]),
    "stretch":    dict(effect="stretch", accent="#ffd400", flash=.25, shake=6,  zoom=.06, dim=.45, solids=["#111111", "#ffd400", "#f2f2f2"]),
    "zoom_punch": dict(effect="zoom",    accent="#ff3df0", flash=.30, shake=12, zoom=.14, dim=.40, solids=["#1a0033", "#0b0b0b", "#f2f2f2"]),
    "clean":      dict(effect="slide",   accent="#ffffff", flash=0,   shake=0,  zoom=.05, dim=.30, solids=["#101010", "#f2f2f2", "#101010"]),
}


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def log(*a):
    print(*a, flush=True)


# ───────────── аудио: бийтове ─────────────
def load_audio(path, sr=22050):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32), sr


def detect_beats(y, sr, bpm_hint=None):
    hop, n = 512, 1024
    frames = 1 + (len(y) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(y[idx] * np.hanning(n), axis=1))[:, :180]  # до ~4 kHz
    flux = np.concatenate([[0], np.maximum(np.diff(spec, axis=0), 0).sum(1)])
    flux = (flux - flux.mean()) / (flux.std() + 1e-9)
    fr = sr / hop
    peaks, _ = find_peaks(flux, height=0.9, distance=max(1, int(fr * .2)))
    times, strength = peaks / fr, flux[peaks]
    if len(times) < 4 and bpm_hint:  # няма ясни удари → решетка по BPM
        times = np.arange(0, len(y) / sr, 60.0 / bpm_hint)
        strength = np.ones_like(times)
    return times, strength


def plan_cuts(n_scenes, dur, beats):
    """N-1 точки на рязане, залепени за най-близкия бийт (±40% от дължината на сцена)."""
    L = dur / n_scenes
    cuts = [0.0]
    for k in range(1, n_scenes):
        want = k * L
        c = want
        if len(beats):
            j = int(np.argmin(np.abs(beats - want)))
            if abs(beats[j] - want) < L * .4 and beats[j] > cuts[-1] + .3:
                c = float(beats[j])
        cuts.append(max(c, cuts[-1] + .3))
    return cuts + [dur]


# ───────────── визия ─────────────
def ease_out_back(x):
    x = min(max(x, 0), 1); c = 1.70158
    return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2


def cover(img, W, H, scale):
    w, h = img.size
    s = max(W / w, H / h) * scale
    return img.resize((int(w * s) + 1, int(h * s) + 1), Image.LANCZOS)


def get_font(name, size):
    p = os.path.join(ROOT, "assets", "fonts", FONTS.get(name, "RussoOne.ttf"))
    try:
        f = ImageFont.truetype(p, size)
        if name in ("oswald", "montserrat"):
            try: f.set_variation_by_name("Bold")
            except Exception: pass
        return f
    except Exception:
        return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size)


def word_tile(word, font, color, stroke=0):
    d = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    l, t, r, b = d.textbbox((0, 0), word, font=font, stroke_width=stroke)
    pad = 24
    tile = Image.new("RGBA", (r - l + 2 * pad, b - t + 2 * pad), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((pad - l, pad - t), word, font=font, fill=color + (255,),
                              stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
    return tile


def hblur(tile, px):
    if px < 1.5: return tile
    a = np.asarray(tile, dtype=np.float32)
    k = max(2, int(px / 3))
    acc = np.zeros_like(a)
    for s in np.linspace(-px / 2, px / 2, k):
        acc += np.roll(a, int(s), axis=1)
    return Image.fromarray((acc / k).clip(0, 255).astype(np.uint8), "RGBA")


def draw_text(frame, words, lt, pulse, st, effect, font_name, W, H, rng, accent, fg=(255, 255, 255)):
    n = len(words)
    size = min(int(W * .30), int(H * .55 / n))
    font = get_font(font_name, size)
    widest = max(font.getlength(w) for w in words)
    if widest > W * .82:
        font = get_font(font_name, int(size * W * .82 / widest))
    lh = font.size * 1.05
    y0 = H * .5 - lh * n / 2 + lh / 2
    for i, w in enumerate(words):
        t = lt - i * .12
        if t < 0: continue
        col = hex_rgb(accent) if (i == n - 1 and n > 1) else fg
        tile = word_tile(w.upper(), font, col, stroke=max(2, font.size // 28))
        p = min(t / .28, 1.0)
        sx = sy = 1.0; ox = oy = 0.0; blur = 0; alpha = 1.0
        if effect == "slam":    sx = sy = 1 + 1.4 * (1 - ease_out_back(p)); alpha = min(p * 4, 1)
        elif effect == "stretch": sx = 1 + 2.5 * (1 - p) ** 2; blur = W * .12 * (1 - p); alpha = min(p * 5, 1)
        elif effect == "zoom":  sx = sy = .55 + .45 * ease_out_back(p); alpha = min(p * 5, 1)
        elif effect == "slide": oy = (1 - p) ** 2 * H * .08; alpha = p
        elif effect == "glitch": alpha = 1 if p > .15 else 0
        amp = st["shake"] * pulse
        ox += rng.uniform(-amp, amp); oy += rng.uniform(-amp, amp)
        k = 1 + .05 * pulse
        tw, th = int(tile.width * sx * k), int(tile.height * sy * k)
        if tw < 4 or th < 4: continue
        tile = hblur(tile.resize((tw, th), Image.BILINEAR), blur)
        if alpha < 1:
            tile.putalpha(tile.getchannel("A").point(lambda v: int(v * alpha)))
        cx, cy = int(W / 2 + ox - tw / 2), int(y0 + i * lh + oy - th / 2)
        if effect == "glitch" and (pulse > .45 or p < 1):  # RGB split + срязване
            off = int(14 * max(pulse, 1 - p) + 2)
            r, g, b, a = tile.split()
            for chan, dx, dc in ((r, -off, 0), (b, off, 2)):
                layer = Image.merge("RGB", [chan if j == dc else Image.new("L", tile.size, 0) for j in range(3)])
                frame.paste(layer, (cx + dx, cy), a)
            frame.paste(tile, (cx, cy + rng.randint(-3, 3)), tile)
        else:
            frame.paste(tile, (cx, cy), tile)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--size", default="1080x1920"); ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--max-seconds", type=float, default=None)
    a = ap.parse_args()
    W, H = map(int, a.size.lower().split("x"))
    sc = json.load(open(os.path.join(a.job, "scenario.json"), encoding="utf-8"))
    style = STYLES.get(sc.get("style", "slam_red"), STYLES["slam_red"])
    font_name = sc.get("font", "russoone")
    audio = os.path.join(a.job, sc["audio"]) if sc.get("audio") else next(
        iter(sorted(sum((glob.glob(os.path.join(a.job, "*." + e)) for e in ("mp3", "wav", "m4a", "ogg", "aac", "flac", "opus")), []))), None)
    if not audio: sys.exit("❌ Няма аудио файл в папката на job-а")
    y, sr = load_audio(audio)
    start = float(sc.get("audio_start", 0))
    y = y[int(start * sr):]
    dur = min(len(y) / sr, a.max_seconds or sc.get("max_seconds", 30))
    beats, strength = detect_beats(y, sr, sc.get("bpm"))
    beats = beats[beats < dur]
    scenes = sc["scenes"]
    cuts = plan_cuts(len(scenes), dur, beats)
    log(f"🎵 {dur:.1f}s, {len(beats)} бийта, {len(scenes)} сцени")

    imgs = []
    for s in scenes:
        p = os.path.join(a.job, s.get("image", "")) if s.get("image") else None
        if p and os.path.exists(p): imgs.append(Image.open(p).convert("RGB"))
        else: imgs.append(None); log(f"⚠ няма снимка за '{s['text']}' → плътен цвят")
    cache = {}
    vign = Image.fromarray((np.clip(1.15 - np.hypot(*np.meshgrid(np.linspace(-1, 1, W), np.linspace(-1, 1, H))) * .55, .35, 1) * 255).astype(np.uint8))
    black = Image.new("RGB", (W, H), (0, 0, 0)); white = Image.new("RGB", (W, H), (255, 255, 255))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(a.fps), "-i", "-", "-ss", str(start), "-i", audio, "-t", f"{dur:.3f}",
                           "-map", "0:v", "-map", "1:a", "-af", f"afade=t=out:st={max(dur-.6,0):.2f}:d=0.6",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                           "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", a.out],
                          stdin=subprocess.PIPE)
    rng = random.Random(7)
    total = int(dur * a.fps)
    for f in range(total):
        t = f / a.fps
        i = max(0, min(len(scenes) - 1, int(np.searchsorted(cuts, t, side="right") - 1)))
        s = scenes[i]; lt = t - cuts[i]; seg = max(cuts[i + 1] - cuts[i], .1)
        j = int(np.searchsorted(beats, t, side="right") - 1)
        pulse = float(np.exp(-(t - beats[j]) * 9)) if j >= 0 else 0.0
        pulse = max(pulse, float(np.exp(-lt * 9)))  # удар и в началото на сцената
        if imgs[i] is not None:
            z = 1 + style["zoom"] * (lt / seg) + .05 * pulse
            if i not in cache: cache = {i: cover(imgs[i], W, H, 1.3)}
            big = cache[i]; bw, bh = big.size
            cw, ch = W * 1.3 / z, H * 1.3 / z
            x0, y0 = (bw - cw) / 2, (bh - ch) / 2
            frame = big.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))
            frame = Image.blend(frame, black, style["dim"])
            frame = Image.composite(frame, black, vign)
        else:
            frame = Image.new("RGB", (W, H), hex_rgb(style["solids"][i % len(style["solids"])]))
        if style["flash"] and pulse > .02:
            frame = Image.blend(frame, white, min(style["flash"] * pulse, .6))
        words = s["text"].split()[:3]
        acc, fg = s.get("accent") or style["accent"], (255, 255, 255)
        if imgs[i] is None:  # плътен фон: контрастен текст
            bg = hex_rgb(style["solids"][i % len(style["solids"])])
            lum = (.299 * bg[0] + .587 * bg[1] + .114 * bg[2]) / 255
            fg = (10, 10, 10) if lum > .75 else (255, 255, 255)
            acc = "#0a0a0a" if (bg[0] > 180 and bg[1] < 80) else ("#e10600" if lum > .75 else acc)
        draw_text(frame, words, lt, pulse, style, s.get("effect") or style["effect"], font_name, W, H, rng, acc, fg)
        ff.stdin.write(frame.tobytes())
        if f % 60 == 0: log(f"  кадър {f}/{total}")
    ff.stdin.close(); ff.wait()
    log(f"✅ {a.out}")


if __name__ == "__main__":
    main()
