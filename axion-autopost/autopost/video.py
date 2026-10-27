"""その日の投稿からYouTubeショート用の縦長動画（1080x1920 MP4）を作る。

AXION SALES の2人（アポくん・つながりちゃん）が会話する構成。
話している方が明るく跳ね、聞いている方は少し暗くなる。吹き出しに文字が1文字ずつ出る。
最後はアポくんが無料リストを案内し、AXION SALES のロゴと「営業代行」を見せて、つながりちゃんが社名を言って締める。
上部には常に「営業代行」と出し、何の会社か一目でわかるようにする。
VOICEVOX が動いていればセリフを読み上げ、文字と動きを声の長さに合わせる（voice.py）。
BGMは毎回オリジナル曲を作曲して流す（bgm.py）。axion-autopost/bgm.mp3 を置けば、そちらを優先する。
"""
import math
import re
import subprocess
import tempfile
import wave
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .characters import COLORS, NAMES, glow, sprite
from .image_card import ACCENT, BG, _font
from . import bgm as music
from . import voice

W, H = 1080, 1920
FPS = 30
MARGIN = 100
# ショートの再生画面は右側（ボタン）と下側（タイトル・説明）が重なるので、大事なものはその外に置く
SAFE_RIGHT = 180
SAFE_BOTTOM = H - 520
BGM = Path(__file__).resolve().parent.parent / "bgm.mp3"

SERVICE = "名古屋の建設・不動産専門 営業代行"
LOGO = Path(__file__).resolve().parent.parent / "assets" / "logo.png"  # 公式ロゴ（ユーザー提供のステッカー画像から切り出し）
BUBBLE = (MARGIN - 20, 440, W - SAFE_RIGHT + 20, 830)
CHAR_CENTER_X = {"apo": 290, "tsunagari": 650}
BUBBLE_TEXT = (28, 32, 48)
CHARS_PER_SEC = 13
# YouTube には DM がなく、ショートの説明欄のURLも押せないので、チャンネルページのリンクへ案内する
CTA = ("見込み客リスト20件、\n無料で作ります！", "チャンネルのリンクから申し込んでね")
# 締め：ロゴを出して、つながりちゃんが社名を言う
END_SAY = "営業代行の、アクシオンセールスでした！"
END_LINES = (SERVICE, "新規開拓・アポ獲得を代行します", "▶ チャンネルのリンクから無料リスト")


def dialogue_from_post(post: dict) -> list[dict]:
    """会話がない古い投稿は、見出しと X 本文から作る"""
    if post.get("short_dialogue"):
        return post["short_dialogue"]
    lines = [{"speaker": "tsunagari", "line": post["image_title"]}]
    for para in post["x"].split("\n\n"):
        para = para.strip().replace("\n", "")
        if para and "DM" not in para:
            lines.append({"speaker": "apo", "line": para})
    return lines


# ---------------------------------------------------------------- 文字
_TOKEN = re.compile(r"[A-Za-z0-9.,%]+|.")
_NO_LINE_START = "、。，．！？!?」』）)ー"


def _wrap(text: str, font, max_w: int) -> list[str]:
    """1文字ずつ折り返す。ただし英数字（20件の「20」など）は分けず、句読点は行頭に置かない"""
    lines, line = [], ""
    for tok in _TOKEN.findall(text):
        if not line or font.getlength(line + tok) <= max_w or tok in _NO_LINE_START:
            line += tok
        else:
            lines.append(line)
            line = tok
    return lines + [line] if line else lines


def _fit(text: str, max_w: int, max_h: int, sizes=(68, 62, 56, 50, 44)):
    for size in sizes:
        font = _font("Bold", size)
        lines = [ln for part in text.split("\n") for ln in _wrap(part, font, max_w)]
        if len(lines) * size * 1.4 <= max_h:
            break
    return font, size, lines


# ---------------------------------------------------------------- 1コマの描画
def _char_pos(who: str, img: Image.Image, hop: int = 0) -> tuple[int, int]:
    return CHAR_CENTER_X[who] - img.width // 2, SAFE_BOTTOM - img.height - hop


def _background(theme: str) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([MARGIN, 190, MARGIN + 12, 242], fill=ACCENT)
    brand = _font("Bold", 42)
    d.text((MARGIN + 36, 192), "AXION SALES", font=brand, fill=ACCENT)
    # 社名の横に「営業代行」の札。何の会社か最初の1秒でわかるように
    bx = MARGIN + 36 + brand.getlength("AXION SALES") + 22
    badge = _font("Bold", 34)
    d.rounded_rectangle((bx, 192, bx + badge.getlength("営業代行") + 36, 246), radius=27, fill=ACCENT)
    d.text((bx + 18, 196), "営業代行", font=badge, fill=BG)
    d.text((MARGIN + 36, 248), "名古屋の建設・不動産の新規開拓・アポ獲得", font=_font("Bold", 30), fill=(255, 255, 255))
    font = _font("Bold", 42)
    for i, ln in enumerate(_wrap(theme, font, W - MARGIN - SAFE_RIGHT)[:2]):
        d.text((MARGIN, 312 + i * 56), ln, font=font, fill=(255, 255, 255))
    d.ellipse([70, SAFE_BOTTOM - 46, W - SAFE_RIGHT + 30, SAFE_BOTTOM + 40], fill=(24, 40, 68))   # 床
    nf = _font("Bold", 30)
    for who, cx in CHAR_CENTER_X.items():
        name = NAMES[who]
        d.text((cx - nf.getlength(name) / 2, SAFE_BOTTOM + 14), name, font=nf, fill=COLORS[who])
    return img


def _bubble(d: ImageDraw.ImageDraw, who: str, lines: list[str], font, size: int, shown: int,
            tail_y: int, sub: str = "", border=None):
    x0, y0, x1, y1 = BUBBLE
    d.rounded_rectangle(BUBBLE, radius=44, fill=(255, 255, 255), outline=border, width=8 if border else 0)
    tx = CHAR_CENTER_X[who]
    d.polygon([(tx - 30, y1 - 2), (tx + 30, y1 - 2), (tx, min(tail_y, y1 + 50))], fill=(255, 255, 255))
    d.text((x0 + 44, y0 + 28), NAMES[who], font=_font("Bold", 34), fill=COLORS[who])
    y, left = y0 + 88, shown
    for ln in lines:
        if left <= 0:
            break
        d.text((x0 + 44, y), ln[:left], font=font, fill=BUBBLE_TEXT)
        left -= len(ln)
        y += int(size * 1.4)
    if sub:
        d.text((x0 + 44, y1 - 74), sub, font=_font("Bold", 40), fill=COLORS["tsunagari"])


def _scenes(post: dict, speak=None) -> list[dict]:
    """場面ごとの文字・長さ・声。speak(セリフ, 話し手) があれば読み上げて、その長さに合わせる"""
    inner_w = BUBBLE[2] - BUBBLE[0] - 88
    items = [dict(d, max_h=BUBBLE[3] - BUBBLE[1] - 120) for d in dialogue_from_post(post)]
    items.append({"speaker": "apo", "line": CTA[0], "say": CTA[0].replace("\n", "") + CTA[1],
                  "sub": CTA[1], "cta": True, "max_h": BUBBLE[3] - BUBBLE[1] - 200})
    items.append({"speaker": "tsunagari", "line": "", "say": END_SAY, "end": True})
    scenes = []
    for item in items:
        font, size, lines = _fit(item["line"], inner_w, item.get("max_h", 200))
        n = sum(len(ln) for ln in lines)
        audio = speak(item.get("say", item["line"]), item["speaker"]) if speak else None
        talk = len(audio) / voice.RATE if audio is not None else n / CHARS_PER_SEC
        scenes.append({"who": item["speaker"], "lines": lines, "font": font, "size": size, "chars": n,
                       "talk": talk, "cps": n / max(talk, 0.6), "audio": audio,
                       "sec": max(4.0 if item.get("cta") else 3.0 if item.get("end") else 2.2,
                                  talk + (0.9 if audio is not None else 1.3)),
                       "sub": item.get("sub", ""), "cta": item.get("cta", False), "end": item.get("end", False)})
    return scenes


@lru_cache(maxsize=None)
def _logo(width: int) -> Image.Image:
    logo = Image.open(LOGO).convert("RGB")
    return logo.resize((width, round(logo.height * width / logo.width)), Image.LANCZOS)


def _end_card(img: Image.Image, d: ImageDraw.ImageDraw, t: float) -> None:
    """締めのカード：白地に公式ロゴと「営業代行」。少し下からふわっと出る"""
    rise = int(max(0.0, 1 - t / 0.35) * 40)
    x0, y0, x1, y1 = BUBBLE[0], BUBBLE[1] - 20 + rise, BUBBLE[2], BUBBLE[3] + 40 + rise
    d.rounded_rectangle((x0, y0, x1, y1), radius=44, fill=(255, 255, 255), outline=ACCENT, width=8)
    logo = _logo(x1 - x0 - 120)
    img.paste(logo, (x0 + 60, y0 + 36))
    y = y0 + 36 + logo.height + 28
    for i, (text, size, color) in enumerate(zip(END_LINES, (44, 34, 34), (BG, BUBBLE_TEXT, COLORS["tsunagari"]))):
        font = _font("Bold", size)
        d.text(((x0 + x1 - font.getlength(text)) / 2, y), text, font=font, fill=color)
        y += int(size * 1.55)


def _frame(base: Image.Image, scene: dict, t: float) -> Image.Image:
    img = base.copy()
    d = ImageDraw.Draw(img)
    shown = min(scene["chars"], int(t * scene["cps"]) + 1)
    talking = t < scene["talk"]
    speaker_top = H
    together = scene["cta"] or scene["end"]  # 案内と締めは2人いっしょに
    for who in CHAR_CENTER_X:
        if who == scene["who"] or together:
            g = glow(who)
            img.paste(g, (CHAR_CENTER_X[who] - g.width // 2, SAFE_BOTTOM - g.height + 40), g)
    for who in CHAR_CENTER_X:
        active = who == scene["who"] or together
        spr = sprite(who, active)
        hop = int(abs(math.sin(t * math.pi * 2.2)) * 18) if active and (talking or together) else 0
        x, y = _char_pos(who, spr, hop)
        img.paste(spr, (x, y), spr)
        if who == scene["who"]:
            speaker_top = y
    if scene["end"]:
        _end_card(img, d, t)
        return img
    _bubble(d, scene["who"], scene["lines"], scene["font"], scene["size"], shown, tail_y=speaker_top - 10,
            sub=scene["sub"] if shown >= scene["chars"] else "", border=ACCENT if scene["cta"] else None)
    return img


# ---------------------------------------------------------------- 書き出し
def _voice_track(scenes: list[dict], path: str) -> None:
    """各場面の声を、場面の始まり（少し間をあけて）に置いた1本の音声にする"""
    starts, t = [], 0
    for sc in scenes:
        starts.append(t)
        t += int(sc["sec"] * FPS)
    track = np.zeros(int(t / FPS * voice.RATE) + voice.RATE, dtype=np.int16)
    for start, sc in zip(starts, scenes):
        if sc["audio"] is not None:
            i = int(start / FPS * voice.RATE)
            track[i:i + len(sc["audio"])] = sc["audio"][: len(track) - i]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(voice.RATE)
        w.writeframes(track.tobytes())


def make_short(post: dict, out_path: str, bgm: Path = BGM, speak="auto") -> tuple[float, list[str]]:
    """動画を書き出して、長さ（秒）と説明欄に入れるクレジットを返す。
    speak="auto" なら VOICEVOX が動いていれば読み上げる。None なら声なし"""
    import imageio_ffmpeg

    credits = []
    if speak == "auto":
        speak = voice.synth if voice.available() else None
        credits = voice.credits() if speak else []
    scenes = _scenes(post, speak)
    total = sum(int(s["sec"] * FPS) for s in scenes) / FPS
    theme = post.get("theme") or post["image_title"]
    base = _background(theme.split("：", 1)[-1])  # 「誤解に答える：〜」の曜日ラベルは外す

    with tempfile.TemporaryDirectory() as tmp:
        cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
        inputs = []
        if speak:
            _voice_track(scenes, f"{tmp}/voice.wav")
            cmd += ["-i", f"{tmp}/voice.wav"]
            inputs.append("[1:a]aresample=44100,volume=1.6[v]")
        if not bgm.exists():  # 曲を置いていなければ、その日の投稿から決まるオリジナル曲を作る
            bgm = Path(f"{tmp}/bgm.wav")
            music.make_bgm(total + 1, str(bgm), music.seed_for(post.get("theme", "") + post["x"]))
        cmd += ["-stream_loop", "-1", "-i", str(bgm)]
        fade = f"afade=t=out:st={max(0, total - 1.5):.2f}:d=1.5"
        inputs.append(f"[{len(inputs) + 1}:a]aresample=44100,volume={0.2 if speak else 0.5},{fade}[b]")
        labels = "".join(f"[{x[-2]}]" for x in inputs)
        mix = f"{labels}amix=inputs={len(inputs)}:duration=longest:normalize=0[a]" if len(inputs) > 1 \
            else f"{labels}anull[a]"
        audio = ["-filter_complex", ";".join(inputs + [mix]), "-map", "[a]"]
        cmd += ["-map", "0:v", *audio, "-t", f"{total:.2f}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20",
                "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", out_path]

        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for scene in scenes:
            for f in range(int(scene["sec"] * FPS)):
                proc.stdin.write(_frame(base, scene, f / FPS).convert("RGB").tobytes())
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("動画の書き出しに失敗しました（ffmpeg）")
    return total, credits
