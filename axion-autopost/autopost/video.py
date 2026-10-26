"""その日の投稿からYouTubeショート用の縦長動画（1080x1920 MP4）を作る。

AXION SALES の2人（ゲンちゃん・アクシー）が会話する構成。
話している方が跳ねて口が動き、吹き出しに文字が1文字ずつ出る。最後はアクシーが無料リストを案内する。
axion-autopost/bgm.mp3 があればBGMとして小さめの音量で流す（なければ無音）。
"""
import math
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from .characters import NAMES, SPRITE_H, SPRITE_W, sprite
from .image_card import ACCENT, BG, SUBTEXT, _font

W, H = 1080, 1920
FPS = 30
MARGIN = 100
# ショートの再生画面は右側（ボタン）と下側（タイトル・説明）が重なるので、大事なものはその外に置く
SAFE_RIGHT = 180
SAFE_BOTTOM = H - 520
BGM = Path(__file__).resolve().parent.parent / "bgm.mp3"

BUBBLE = (MARGIN - 20, 500, W - SAFE_RIGHT + 20, 900)
CHAR_TOP = SAFE_BOTTOM - SPRITE_H
CHAR_X = {"gen": 310 - SPRITE_W // 2, "axie": 670 - SPRITE_W // 2}
NAME_COLOR = {"gen": (226, 120, 40), "axie": (36, 56, 100)}
BUBBLE_TEXT = (28, 32, 48)
CHARS_PER_SEC = 13
CTA = ("見込み客リスト20件、\n無料で作ります！", "DMで「リスト」と送ってね")


def dialogue_from_post(post: dict) -> list[dict]:
    """会話がない古い投稿は、見出しと X 本文から作る"""
    if post.get("short_dialogue"):
        return post["short_dialogue"]
    lines = [{"speaker": "gen", "line": post["image_title"]}]
    for para in post["x"].split("\n\n"):
        para = para.strip().replace("\n", "")
        if para and "DM" not in para:
            lines.append({"speaker": "axie", "line": para})
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
def _background(theme: str) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([MARGIN, 200, MARGIN + 12, 252], fill=ACCENT)
    d.text((MARGIN + 36, 202), "AXION SALES", font=_font("Bold", 42), fill=ACCENT)
    font = _font("Bold", 44)
    for i, ln in enumerate(_wrap(theme, font, W - MARGIN - SAFE_RIGHT)[:2]):
        d.text((MARGIN, 300 + i * 62), ln, font=font, fill=(255, 255, 255))
    floor_y = SAFE_BOTTOM - 30
    d.ellipse([60, floor_y - 40, W - SAFE_RIGHT + 40, floor_y + 70], fill=(24, 40, 68))   # 床
    nf = _font("Regular", 30)
    for who, x in CHAR_X.items():
        name = NAMES[who]
        d.text((x + SPRITE_W // 2 - nf.getlength(name) / 2, SAFE_BOTTOM + 14), name, font=nf, fill=SUBTEXT)
    return img


def _bubble(d: ImageDraw.ImageDraw, who: str, lines: list[str], font, size: int, shown: int,
            sub: str = "", border=None):
    x0, y0, x1, y1 = BUBBLE
    d.rounded_rectangle(BUBBLE, radius=44, fill=(255, 255, 255), outline=border, width=8 if border else 0)
    tail_x = CHAR_X[who] + SPRITE_W // 2
    d.polygon([(tail_x - 34, y1 - 2), (tail_x + 34, y1 - 2), (tail_x, y1 + 56)], fill=(255, 255, 255))
    d.text((x0 + 44, y0 + 30), NAMES[who], font=_font("Bold", 34), fill=NAME_COLOR[who])
    y, left = y0 + 92, shown
    for ln in lines:
        if left <= 0:
            break
        d.text((x0 + 44, y), ln[:left], font=font, fill=BUBBLE_TEXT)
        left -= len(ln)
        y += int(size * 1.4)
    if sub:
        d.text((x0 + 44, y1 - 76), sub, font=_font("Bold", 40), fill=NAME_COLOR["gen"])


def _scenes(post: dict) -> list[dict]:
    inner_w = BUBBLE[2] - BUBBLE[0] - 88
    scenes = []
    for item in dialogue_from_post(post):
        font, size, lines = _fit(item["line"], inner_w, BUBBLE[3] - BUBBLE[1] - 130)
        n = sum(len(ln) for ln in lines)
        scenes.append({"who": item["speaker"], "lines": lines, "font": font, "size": size, "chars": n,
                       "sec": max(2.2, n / CHARS_PER_SEC + 1.3)})
    font, size, lines = _fit(CTA[0], inner_w, BUBBLE[3] - BUBBLE[1] - 210, sizes=(62, 56, 50))
    scenes.append({"who": "axie", "lines": lines, "font": font, "size": size, "chars": sum(map(len, lines)),
                   "sec": 4.0, "sub": CTA[1], "cta": True})
    return scenes


def _frame(base: Image.Image, scene: dict, t: float) -> Image.Image:
    img = base.copy()
    d = ImageDraw.Draw(img)
    shown = min(scene["chars"], int(t * CHARS_PER_SEC) + 1)
    typing = shown < scene["chars"]
    _bubble(d, scene["who"], scene["lines"], scene["font"], scene["size"], shown,
            sub="" if typing else scene.get("sub", ""), border=ACCENT if scene.get("cta") else None)
    for who, x in CHAR_X.items():
        talking = who == scene["who"] or scene.get("cta")
        hop = int(abs(math.sin(t * math.pi * 2.2)) * 16) if talking and (typing or scene.get("cta")) else 0
        mouth = talking and typing and int(t * 8) % 2 == 0
        spr = sprite(who, mouth)
        img.paste(spr, (x, CHAR_TOP - hop), spr)
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
            proc.stdin.write(_frame(base, scene, f / FPS).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("動画の書き出しに失敗しました（ffmpeg）")
    return total
