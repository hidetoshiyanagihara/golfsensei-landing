"""その日の投稿からYouTubeショート用の縦長動画（1080x1920 MP4）を作る。

AXION SALES の2人（アポくん・つながりちゃん）が会話する構成。
話している方が明るく跳ね、聞いている方は少し暗くなる。吹き出しに文字が1文字ずつ出る。
最後はアポくんが無料リストを案内する。
axion-autopost/bgm.mp3 があればBGMとして小さめの音量で流す（なければ無音）。
"""
import math
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from .characters import COLORS, NAMES, glow, sprite
from .image_card import ACCENT, BG, SUBTEXT, _font

W, H = 1080, 1920
FPS = 30
MARGIN = 100
# ショートの再生画面は右側（ボタン）と下側（タイトル・説明）が重なるので、大事なものはその外に置く
SAFE_RIGHT = 180
SAFE_BOTTOM = H - 520
BGM = Path(__file__).resolve().parent.parent / "bgm.mp3"

TAGLINE = "つながる。ひろがる。新しいビジネスを。"
BUBBLE = (MARGIN - 20, 440, W - SAFE_RIGHT + 20, 830)
CHAR_CENTER_X = {"apo": 290, "tsunagari": 650}
BUBBLE_TEXT = (28, 32, 48)
CHARS_PER_SEC = 13
CTA = ("見込み客リスト20件、\n無料で作ります！", "DMで「リスト」と送ってね")


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
    d.text((MARGIN + 36, 192), "AXION SALES", font=_font("Bold", 42), fill=ACCENT)
    d.text((MARGIN + 36, 248), TAGLINE, font=_font("Regular", 28), fill=SUBTEXT)
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


def _scenes(post: dict) -> list[dict]:
    inner_w = BUBBLE[2] - BUBBLE[0] - 88
    scenes = []
    for item in dialogue_from_post(post):
        font, size, lines = _fit(item["line"], inner_w, BUBBLE[3] - BUBBLE[1] - 120)
        n = sum(len(ln) for ln in lines)
        scenes.append({"who": item["speaker"], "lines": lines, "font": font, "size": size, "chars": n,
                       "sec": max(2.2, n / CHARS_PER_SEC + 1.3)})
    font, size, lines = _fit(CTA[0], inner_w, BUBBLE[3] - BUBBLE[1] - 200, sizes=(62, 56, 50))
    scenes.append({"who": "apo", "lines": lines, "font": font, "size": size, "chars": sum(map(len, lines)),
                   "sec": 4.0, "sub": CTA[1], "cta": True})
    return scenes


def _frame(base: Image.Image, scene: dict, t: float) -> Image.Image:
    img = base.copy()
    d = ImageDraw.Draw(img)
    shown = min(scene["chars"], int(t * CHARS_PER_SEC) + 1)
    typing = shown < scene["chars"]
    speaker_top = H
    for who in CHAR_CENTER_X:
        if who == scene["who"] or scene.get("cta"):
            g = glow(who)
            img.paste(g, (CHAR_CENTER_X[who] - g.width // 2, SAFE_BOTTOM - g.height + 40), g)
    for who in CHAR_CENTER_X:
        active = who == scene["who"] or bool(scene.get("cta"))
        spr = sprite(who, active)
        hop = int(abs(math.sin(t * math.pi * 2.2)) * 18) if active and (typing or scene.get("cta")) else 0
        x, y = _char_pos(who, spr, hop)
        img.paste(spr, (x, y), spr)
        if who == scene["who"]:
            speaker_top = y
    _bubble(d, scene["who"], scene["lines"], scene["font"], scene["size"], shown, tail_y=speaker_top - 10,
            sub="" if typing else scene.get("sub", ""), border=ACCENT if scene.get("cta") else None)
    return img


# ---------------------------------------------------------------- 書き出し
def make_short(post: dict, out_path: str, bgm: Path = BGM) -> float:
    """動画を書き出して、長さ（秒）を返す"""
    import imageio_ffmpeg

    scenes = _scenes(post)
    total = sum(s["sec"] for s in scenes)
    theme = post.get("theme") or post["image_title"]
    base = _background(theme.split("：", 1)[-1])  # 「誤解に答える：〜」の曜日ラベルは外す

    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    if bgm.exists():
        cmd += ["-stream_loop", "-1", "-i", str(bgm),
                "-af", f"volume=0.35,afade=t=out:st={max(0, total - 1.5):.2f}:d=1.5"]
    else:  # 音声トラックがないと扱いが不安定なサービスがあるので無音を入れる
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    cmd += ["-map", "0:v", "-map", "1:a", "-t", f"{total:.2f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out_path]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for scene in scenes:
        for f in range(int(scene["sec"] * FPS)):
            proc.stdin.write(_frame(base, scene, f / FPS).convert("RGB").tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("動画の書き出しに失敗しました（ffmpeg）")
    return total
