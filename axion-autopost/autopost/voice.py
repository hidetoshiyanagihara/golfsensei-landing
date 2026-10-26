"""VOICEVOX（無料の音声合成エンジン）でショートのセリフを読み上げる。

GitHub Actions では VOICEVOX ENGINE の Docker を起動して http://localhost:50021 で使う。
動いていなければ無音の動画になる（投稿は止めない）。
声は各キャラクターの利用規約に従い、YouTube の説明欄に「VOICEVOX:名前」を入れる。
"""
import io
import os
import wave

import numpy as np
import requests

URL = os.environ.get("VOICEVOX_URL") or "http://localhost:50021"
# 声（VOICEVOX のスタイルID）。アポくん＝白上虎太郎（ふつう）、つながりちゃん＝冥鳴ひまり（ノーマル）
VOICES = {"apo": int(os.environ.get("VOICE_APO") or 12), "tsunagari": int(os.environ.get("VOICE_TSUNAGARI") or 14)}
SPEED = {"apo": 1.15, "tsunagari": 1.08}
RATE = 24000
# 読み間違えやすい語の読み
READINGS = {"DM": "ディーエム"}


def available() -> bool:
    try:
        return requests.get(f"{URL}/version", timeout=3).ok
    except requests.RequestException:
        return False


def synth(text: str, who: str) -> np.ndarray:
    """セリフを読み上げた音声（モノラル16bit、RATE Hz）"""
    for word, reading in READINGS.items():
        text = text.replace(word, reading)
    speaker = VOICES[who]
    r = requests.post(f"{URL}/audio_query", params={"text": text, "speaker": speaker}, timeout=60)
    r.raise_for_status()
    query = r.json()
    query.update(speedScale=SPEED[who], outputSamplingRate=RATE, outputStereo=False)
    r = requests.post(f"{URL}/synthesis", params={"speaker": speaker}, json=query, timeout=120)
    r.raise_for_status()
    with wave.open(io.BytesIO(r.content)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def credits() -> list[str]:
    """説明欄に入れるクレジット（例：VOICEVOX:白上虎太郎）"""
    r = requests.get(f"{URL}/speakers", timeout=10)
    r.raise_for_status()
    names = {style["id"]: s["name"] for s in r.json() for style in s["styles"]}
    return [f"VOICEVOX:{names[v]}" for v in dict.fromkeys(VOICES.values()) if v in names]
