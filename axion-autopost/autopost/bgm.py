"""ショート動画のBGMをその場で作る（毎回作曲するオリジナル曲なので、著作権の申し立てが来ない）。

J-POPでよく使われるコード進行（王道進行・丸サ進行など）に、
ポップ／ダンス／チル（lo-fi）の3つのノリを日替わりで組み合わせる。
声の邪魔をしないよう、メロディは入れずにコードの刻みとリズムで明るさを出す。
"""
import wave
import zlib

import numpy as np

SR = 44100
CHORDS = {"maj7": (0, 4, 7, 11), "7": (0, 4, 7, 10), "m7": (0, 3, 7, 10)}
PROGRESSIONS = [
    [(5, "maj7"), (7, "7"), (4, "m7"), (9, "m7")],   # 王道進行 IV-V-iii-vi
    [(5, "maj7"), (4, "7"), (9, "m7"), (0, "7")],    # 丸サ進行 IV-III-vi-I
    [(9, "m7"), (5, "maj7"), (7, "7"), (0, "maj7")],  # 小室進行 vi-IV-V-I
    [(0, "maj7"), (9, "m7"), (5, "maj7"), (7, "7")],  # I-vi-IV-V
]
STYLES = {
    "pop": {"bpm": 112, "swing": 0.0},
    "dance": {"bpm": 124, "swing": 0.0},
    "chill": {"bpm": 88, "swing": 0.14},
}
KEYS = [0, 2, 3, 5, 7]  # C, D, E♭, F, G


def _hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def _t(sec):
    return np.arange(int(sec * SR)) / SR


def _saw(f, t):
    """やわらかいノコギリ波（倍音を少なめに足し合わせる）"""
    out = np.zeros_like(t)
    for k in range(1, 12):
        if k * f > 7000:
            break
        out += np.sin(2 * np.pi * k * f * t) / k ** 1.3
    return out


def _env(t, attack, sec):
    a = np.clip(t / attack, 0, 1)
    r = np.clip((sec - t) / 0.08, 0, 1)
    return a * r


class _Mix:
    def __init__(self, seconds):
        self.buf = np.zeros((int(seconds * SR) + SR, 2))

    def add(self, start, sig, pan=0.0):
        i = int(start * SR)
        if i >= len(self.buf):
            return
        sig = sig[: len(self.buf) - i]
        if sig.ndim == 1:
            sig = np.stack([sig * (1 - max(pan, 0)), sig * (1 + min(pan, 0))], axis=1)
        self.buf[i:i + len(sig)] += sig


def _pad(notes, sec):
    t = _t(sec)
    env = _env(t, 0.06, sec)
    left = sum(_saw(_hz(n) * 2 ** (-7 / 1200), t) for n in notes)
    right = sum(_saw(_hz(n) * 2 ** (7 / 1200), t) for n in notes)
    return np.stack([left, right], axis=1) * env[:, None] * 0.09


def _epiano(notes, sec):
    t = _t(sec)
    out = np.zeros_like(t)
    for n in notes:
        f = _hz(n)
        out += (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 1.6)
        out += 0.08 * np.sin(2 * np.pi * 7 * f * t) * np.exp(-t * 18)
    return out * _env(t, 0.01, sec) * (1 + 0.15 * np.sin(2 * np.pi * 4.5 * t)) * 0.13


def _pluck(n, sec=0.3):
    t = _t(sec)
    f = _hz(n)
    s = np.sin(2 * np.pi * f * t) + 0.4 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    return s * np.exp(-t * 10) * _env(t, 0.004, sec) * 0.17


def _bass(n, sec):
    t = _t(sec)
    f = _hz(n)
    # スマホのスピーカーでも聞こえるよう、倍音を多めに入れる
    s = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(4 * np.pi * f * t) + 0.3 * np.sin(6 * np.pi * f * t)
    return s * _env(t, 0.006, sec) * np.exp(-t * 1.2) * 0.14


def _kick():
    t = _t(0.35)
    f = 45 + 80 * np.exp(-t * 32)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 8) * 0.4


def _clap(rng):
    t = _t(0.22)
    noise = np.diff(rng.standard_normal(len(t) + 1))
    return (noise * 0.16 + np.sin(2 * np.pi * 190 * t) * 0.12) * np.exp(-t * 20)


def _hat(rng, open_=False):
    t = _t(0.18 if open_ else 0.05)
    noise = np.diff(rng.standard_normal(len(t) + 2), n=2)
    return noise * np.exp(-t * (18 if open_ else 70)) * 0.035


def make_bgm(seconds: float, path: str, seed: int) -> str:
    """seconds 秒以上のBGMを path（WAV, 44.1kHz ステレオ）に書き出し、曲調の名前を返す"""
    rng = np.random.default_rng(seed)
    style = list(STYLES)[seed % len(STYLES)]
    prog = PROGRESSIONS[(seed // len(STYLES)) % len(PROGRESSIONS)]
    key = KEYS[(seed // 7) % len(KEYS)]
    bpm = STYLES[style]["bpm"]
    swing = STYLES[style]["swing"]
    beat = 60 / bpm
    bar = beat * 4
    bars = int(np.ceil(seconds / bar)) + 1
    mix = _Mix(bars * bar)
    duck = np.ones(len(mix.buf))  # キックに合わせて伴奏が「ふわっ」と揺れる（いまどきのポップの定番）

    for b in range(bars):
        root, kind = prog[b % len(prog)]
        notes = [60 + key + root + iv for iv in CHORDS[kind]]
        notes = [n - 12 if n > 72 else n for n in notes]
        start = b * bar
        bass_root = 36 + (key + root) % 12

        if style == "chill":
            mix.add(start, _epiano(notes, bar * 0.98))
        else:
            mix.add(start, _pad(notes, bar))

        # コードの刻み（8分音符のアルペジオ）
        order = [0, 1, 2, 3, 2, 1, 3, 2] if b % 2 else [0, 2, 1, 3, 2, 3, 1, 2]
        for i, idx in enumerate(order):
            if style == "chill" and i % 2:
                continue
            off = i * beat / 2 + (swing * beat if i % 2 else 0)
            mix.add(start + off, _pluck(notes[idx] + 12), pan=(-0.3 if i % 2 else 0.3))

        # ベース
        if style == "dance":
            for q in range(4):
                mix.add(start + q * beat + beat / 2, _bass(bass_root, beat / 2 * 0.9))
        else:
            mix.add(start, _bass(bass_root, beat * 1.5))
            mix.add(start + beat * 2.5, _bass(bass_root, beat * 1.2))

        # ドラム
        kicks = {"dance": [0, 1, 2, 3], "pop": [0, 1.5, 2, 2.75], "chill": [0, 1.75, 2.5]}[style]
        for k in kicks:
            mix.add(start + k * beat, _kick())
            i = int((start + k * beat) * SR)
            n = min(int(beat * SR), len(duck) - i)
            if n > 0 and style != "chill":
                duck[i:i + n] = np.minimum(duck[i:i + n], 1 - 0.55 * np.exp(-np.arange(n) / SR * 9))
        for c in (1, 3):
            mix.add(start + c * beat, _clap(rng))
        steps = 8 if style != "chill" else 16
        for s in range(steps):
            step = bar / steps
            off = s * step + (swing * beat if s % 2 else 0)
            open_ = style == "dance" and s % 2 == 1
            mix.add(start + off, _hat(rng, open_) * (1.0 if s % 2 else 0.6), pan=0.25)

    if style == "chill":  # レコードのノイズを少し
        crackle = np.zeros(len(mix.buf))
        idx = rng.integers(0, len(crackle), size=int(len(crackle) / SR * 25))
        crackle[idx] = rng.standard_normal(len(idx)) * 0.03
        mix.buf += crackle[:, None]

    out = mix.buf * duck[:, None]
    out = np.tanh(out * 1.2)
    out = out[: int(seconds * SR)]
    fade = int(0.4 * SR)
    out[:fade] *= np.linspace(0, 1, fade)[:, None]
    out *= 0.22 / max(np.sqrt(np.mean(out ** 2)), 1e-6)  # 毎回ほぼ同じ音量に揃える
    out = np.tanh(out / 0.9) * 0.9  # 割れないように頭を丸める
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((out * 32767).astype(np.int16).tobytes())
    return style


def seed_for(text: str) -> int:
    return zlib.crc32(text.encode("utf-8"))
