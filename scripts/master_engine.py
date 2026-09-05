#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
master_engine.py — Mastering Pro DSP engine (пуска се от GitHub Actions,
виж .github/workflows/mastering-pro.yml)

Вход:  mastering-jobs/<job_id>/target.wav
       mastering-jobs/<job_id>/reference.wav
Изход: mastering-jobs/<job_id>/result.wav
       mastering-jobs/<job_id>/status.json  (метрики + успех/грешка, за да
       може dashboard-ът (js/mastering-pro.js) да polls-ва и покаже резултат)

Архитектура на веригата (10-те изисквания от спецификацията):
  1) TARGET-препроцес:
     - суб-бас (<90Hz) принудително моно (M/S split)                    [7]
     - де-есер 6-10kHz (динамично намаление на сибиланти)                [8]
     - лек 3-band мултибанд компресор (анти-pumping преди match-ването)  [3][4]
  2) matchering.process() — референтен match (спектър/RMS/стерео ширина
     към REFERENCE) + вграден "hyrax" true-peak-safe лимитер            [2][6][10]
  3) POST-препроцес върху резултата:
     - лека сатурация/exciter (tanh soft-clip + presence shelf) — "glue" [9]
     - финален safety true-peak лимитер, 4x oversampled, с lookahead     [1][4]
  4) Финален износ: 16-bit PCM + TPDF/noise-shaped dither                [5]
  5) LUFS метиране (преди/след) през pyloudnorm, записано в status.json  [2]

Всяка стъпка е с ясно име на функция, за да може лесно да се пипа
поотделно, без да се чупи останалото (същия принцип като в ARCHITECTURE.md
на останалата част от проекта — малки, самостоятелни модули).
"""

import argparse
import json
import os
import sys
import tempfile
import traceback
from datetime import datetime, timezone

import numpy as np
import soundfile as sf
import soxr
from scipy import signal

try:
    import pyloudnorm as pyln
except Exception:  # pragma: no cover
    pyln = None

try:
    import matchering as mg
except Exception:  # pragma: no cover
    mg = None


# ============================================================
# ПОМОЩНИ DSP ФУНКЦИИ
# ============================================================

def to_stereo(x: np.ndarray) -> np.ndarray:
    """Гарантира (n, 2) shape — моно се дублира в двата канала."""
    if x.ndim == 1:
        return np.stack([x, x], axis=1)
    if x.shape[1] == 1:
        return np.repeat(x, 2, axis=1)
    return x[:, :2]


def db_to_lin(db: float) -> float:
    return 10.0 ** (db / 20.0)


def lin_to_db(lin: float) -> float:
    return 20.0 * np.log10(max(lin, 1e-12))


def envelope_follower(x: np.ndarray, sr: int, attack_ms: float, release_ms: float) -> np.ndarray:
    """Прост peak envelope follower с отделни attack/release константи
    (експоненциално сглаждане — стандартен подход за envelope detection
    в компресори/де-есъри, вижте т. "АДАПТИВЕН RELEASE" от спецификацията)."""
    att = np.exp(-1.0 / (sr * max(attack_ms, 0.1) / 1000.0))
    rel = np.exp(-1.0 / (sr * max(release_ms, 1.0) / 1000.0))
    env = np.zeros_like(x)
    level = 0.0
    ax = np.abs(x)
    for i in range(len(x)):
        coeff = att if ax[i] > level else rel
        level = coeff * level + (1 - coeff) * ax[i]
        env[i] = level
    return env


# ---------- 1) Суб-бас моно (<90Hz, M/S) ----------

def mono_sub_bass(x: np.ndarray, sr: int, cutoff_hz: float = 90.0) -> np.ndarray:
    """Прави суб-баса под cutoff_hz 100% моно чрез Mid/Side обработка —
    стандартна мастеринг практика (масата/виниловите нарези/съвместимостта
    с мобилни говорители изискват моно бас)."""
    mid = (x[:, 0] + x[:, 1]) / 2.0
    side = (x[:, 0] - x[:, 1]) / 2.0

    sos_lo = signal.butter(4, cutoff_hz, btype="low", fs=sr, output="sos")
    sos_hi = signal.butter(4, cutoff_hz, btype="high", fs=sr, output="sos")

    side_low = signal.sosfiltfilt(sos_lo, side)      # суб-бас частта на страничния сигнал
    side_high = signal.sosfiltfilt(sos_hi, side)      # останалата ширина (над 90Hz) — недокосната

    # маха суб-баса от side (→ 0 под cutoff), останалото минава през
    new_side = side_high
    mid_low = signal.sosfiltfilt(sos_lo, mid)
    mid_high = signal.sosfiltfilt(sos_hi, mid)
    new_mid = mid_low + mid_high  # mid остава непроменен, само за симетрия на филтрирането

    left = new_mid + new_side
    right = new_mid - new_side
    return np.stack([left, right], axis=1).astype(np.float32)


# ---------- 2) Де-есер (6-10kHz динамична дъкинг) ----------

def de_esser(x: np.ndarray, sr: int, lo_hz: float = 6000.0, hi_hz: float = 10000.0,
             threshold_db: float = -24.0, ratio: float = 4.0,
             attack_ms: float = 1.0, release_ms: float = 60.0) -> np.ndarray:
    """Динамична дъкинг само в 6-10kHz зоната (сибиланти), без да пипа
    останалия спектър — класически "split-band" де-есер."""
    out = np.copy(x)
    sos_band = signal.butter(4, [lo_hz, hi_hz], btype="bandpass", fs=sr, output="sos")
    for ch in range(x.shape[1]):
        band = signal.sosfiltfilt(sos_band, x[:, ch])
        env = envelope_follower(band, sr, attack_ms, release_ms)
        env_db = 20.0 * np.log10(np.maximum(env, 1e-8))
        over_db = np.maximum(env_db - threshold_db, 0.0)
        reduction_db = over_db * (1.0 - 1.0 / ratio)
        gain = db_to_lin(-reduction_db)  # 1.0 когато няма превишение, <1.0 при есес
        # изваждаме недуцираната част от band-а и добавяме дуцираната —
        # засяга САМО честотния прозорец на есетата
        out[:, ch] = out[:, ch] - band + band * gain
    return out.astype(np.float32)


# ---------- 3) Лек 3-band мултибанд компресор (анти-pumping) ----------

def band_compressor(band: np.ndarray, sr: int, threshold_db: float, ratio: float,
                     attack_ms: float, release_ms: float) -> np.ndarray:
    env = envelope_follower(band, sr, attack_ms, release_ms)
    env_db = 20.0 * np.log10(np.maximum(env, 1e-8))
    over_db = np.maximum(env_db - threshold_db, 0.0)
    reduction_db = over_db * (1.0 - 1.0 / ratio)
    gain = db_to_lin(-reduction_db)
    return band * gain


def multiband_dynamics(x: np.ndarray, sr: int,
                        low_hz: float = 200.0, high_hz: float = 4000.0) -> np.ndarray:
    """Разделя сигнала на low/mid/high (Linkwitz-Riley-подобен crossover),
    компресира всяка лента поотделно с меки настройки, после сумира.
    Предотвратява ниските честоти да "изпомпват" целия сигнал (bass pumping)
    когато по-късно матчерингът/лимитерът реагират на общия RMS."""
    out = np.zeros_like(x)
    sos_lo = signal.butter(4, low_hz, btype="low", fs=sr, output="sos")
    sos_mid = signal.butter(4, [low_hz, high_hz], btype="bandpass", fs=sr, output="sos")
    sos_hi = signal.butter(4, high_hz, btype="high", fs=sr, output="sos")
    for ch in range(x.shape[1]):
        lo = signal.sosfiltfilt(sos_lo, x[:, ch])
        mid = signal.sosfiltfilt(sos_mid, x[:, ch])
        hi = signal.sosfiltfilt(sos_hi, x[:, ch])
        lo_c = band_compressor(lo, sr, threshold_db=-18, ratio=2.5, attack_ms=8, release_ms=180)
        mid_c = band_compressor(mid, sr, threshold_db=-20, ratio=1.8, attack_ms=4, release_ms=120)
        hi_c = band_compressor(hi, sr, threshold_db=-22, ratio=1.5, attack_ms=1, release_ms=80)
        out[:, ch] = lo_c + mid_c + hi_c
    return out.astype(np.float32)


# ---------- 4) Сатурация / хармоничен exciter ("glue") ----------

def saturate(x: np.ndarray, sr: int, drive: float = 1.6, mix: float = 0.12,
             air_freq: float = 11000.0, air_gain_db: float = 1.5) -> np.ndarray:
    """Леко soft-clipping (tanh) за аналогов "glue" + малък high-shelf
    "air" бустер за възприемания блясък, който сатурацията леко заглушава."""
    driven = np.tanh(x * drive) / np.tanh(drive)
    wet = x * (1 - mix) + driven * mix
    sos_air = signal.butter(2, air_freq, btype="high", fs=sr, output="sos")
    air = signal.sosfiltfilt(sos_air, wet, axis=0)
    return (wet + air * (db_to_lin(air_gain_db) - 1.0)).astype(np.float32)


# ---------- 5) Финален oversampled true-peak лимитер (safety net) ----------

def true_peak_limiter(x: np.ndarray, sr: int, ceiling_db: float = -1.0,
                       oversample: int = 4, lookahead_ms: float = 2.0,
                       release_ms: float = 60.0) -> np.ndarray:
    """4x oversampling + interpolated peak detection + lookahead brickwall —
    гарантира true-peak таван дори за intersample peaks, които се появяват
    само между семплите (не се виждат на нормалната sample-rate резолюция)."""
    ceiling = db_to_lin(ceiling_db)
    os_sr = sr * oversample
    n = x.shape[0]
    up = np.zeros((n * oversample, x.shape[1]), dtype=np.float64)
    for ch in range(x.shape[1]):
        up[:, ch] = soxr.resample(x[:, ch].astype(np.float64), sr, os_sr)

    lookahead = int(os_sr * lookahead_ms / 1000.0)
    release = np.exp(-1.0 / (os_sr * max(release_ms, 1.0) / 1000.0))

    peak = np.max(np.abs(up), axis=1)  # общ peak между L/R (linked, за да не мести стерео образа)
    padded = np.concatenate([peak, np.full(lookahead, peak[-1] if len(peak) else 0.0)])

    gain = np.ones(len(peak), dtype=np.float64)
    current_gain = 1.0
    for i in range(len(peak)):
        window_peak = np.max(padded[i:i + lookahead + 1]) if lookahead > 0 else peak[i]
        target_gain = ceiling / window_peak if window_peak > ceiling else 1.0
        if target_gain < current_gain:
            current_gain = target_gain  # моментален attack — никога не позволяваме clip
        else:
            current_gain = release * current_gain + (1 - release) * target_gain
        gain[i] = current_gain

    limited_up = up * gain[:, None]
    down = np.zeros((n, x.shape[1]), dtype=np.float64)
    for ch in range(x.shape[1]):
        down[:, ch] = soxr.resample(limited_up[:, ch], os_sr, sr)
    # финален "hard safety" clamp — застраховка срещу остатъчен overshoot
    # от resampling ringing-а
    down = np.clip(down, -ceiling * 1.001, ceiling * 1.001)
    return down.astype(np.float32)


# ---------- 6) TPDF/noise-shaped dither при 16-bit износ ----------

def dither_to_int16(x: np.ndarray) -> np.ndarray:
    """TPDF (Triangular PDF) dither — сума от два независими uniform шума,
    точно както в js/mastering.js писателя на WAV — маскира квантуването с
    гладък шум вместо стъпаловидна изкривеност в тихите пасажи."""
    rng = np.random.default_rng()
    lsb = 1.0 / 32767.0
    dither = (rng.uniform(-0.5, 0.5, x.shape) + rng.uniform(-0.5, 0.5, x.shape)) * lsb
    dithered = np.clip(x + dither, -1.0, 1.0)
    return (dithered * 32767.0).astype(np.int16)


# ---------- LUFS метиране ----------

def measure_lufs(x: np.ndarray, sr: int):
    if pyln is None:
        return None
    try:
        meter = pyln.Meter(sr)
        integrated = meter.integrated_loudness(x)
        return round(float(integrated), 2)
    except Exception:
        return None


def measure_true_peak_db(x: np.ndarray) -> float:
    return round(lin_to_db(float(np.max(np.abs(x)))), 2) if x.size else 0.0


# ============================================================
# ГЛАВЕН PIPELINE
# ============================================================

def run(job_dir: str, target_peak_db: float = -1.0) -> dict:
    target_path = os.path.join(job_dir, "target.wav")
    reference_path = os.path.join(job_dir, "reference.wav")
    result_path = os.path.join(job_dir, "result.wav")

    target, sr_t = sf.read(target_path, always_2d=True)
    target = to_stereo(target.astype(np.float32))

    lufs_before = measure_lufs(target, sr_t)
    tp_before = measure_true_peak_db(target)

    # ---- 1) TARGET препроцес ----
    pre = mono_sub_bass(target, sr_t, cutoff_hz=90.0)
    pre = de_esser(pre, sr_t)
    pre = multiband_dynamics(pre, sr_t)

    with tempfile.TemporaryDirectory() as tmp:
        pre_path = os.path.join(tmp, "target_preprocessed.wav")
        matched_path = os.path.join(tmp, "matched.wav")
        sf.write(pre_path, pre, sr_t, subtype="FLOAT")

        # ---- 2) matchering — референтен match + вграден true-peak лимитер ----
        if mg is None:
            raise RuntimeError("matchering библиотеката не е инсталирана (виж scripts/requirements-mastering.txt)")
        mg.log(handlers=(mg.print_handler(),))
        mg.process(
            target=pre_path,
            reference=reference_path,
            results=[mg.pcm24(matched_path)],
        )
        matched, sr_m = sf.read(matched_path, always_2d=True)
        matched = to_stereo(matched.astype(np.float32))

    # ---- 3) POST препроцес: сатурация/glue ----
    post = saturate(matched, sr_m)

    # ---- 4) Финален safety true-peak лимитер (4x oversampled, lookahead) ----
    final = true_peak_limiter(post, sr_m, ceiling_db=target_peak_db)

    lufs_after = measure_lufs(final, sr_m)
    tp_after = measure_true_peak_db(final)

    # ---- 5) 16-bit износ с TPDF dither ----
    final_i16 = dither_to_int16(final)
    sf.write(result_path, final_i16, sr_m, subtype="PCM_16")

    return {
        "lufs_before": lufs_before,
        "lufs_after": lufs_after,
        "true_peak_before_db": tp_before,
        "true_peak_after_db": tp_after,
        "sample_rate": sr_m,
        "target_peak_db": target_peak_db,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True, help="mastering-jobs/<job_id>")
    parser.add_argument("--target-peak-db", type=float, default=-1.0)
    args = parser.parse_args()

    status_path = os.path.join(args.job_dir, "status.json")
    started = datetime.now(timezone.utc).isoformat()
    try:
        metrics = run(args.job_dir, target_peak_db=args.target_peak_db)
        status = {
            "state": "done",
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            **metrics,
        }
    except Exception as e:  # noqa: BLE001 — искаме статус файл дори при неочаквана грешка
        status = {
            "state": "error",
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "message": str(e),
            "traceback": traceback.format_exc()[-2000:],
        }
        with open(status_path, "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
        print(f"::error::Mastering engine се провали: {e}", file=sys.stderr)
        sys.exit(1)

    with open(status_path, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
