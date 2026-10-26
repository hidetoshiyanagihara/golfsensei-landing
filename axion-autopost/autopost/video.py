"""その日の投稿からYouTubeショート用の縦長動画（1080x1920 MP4）を文字スライドで作る。

スライド：見出し → X本文の段落ごと → 締め（DMで「リスト」）。
axion-autopost/bgm.mp3 があればBGMとして小さめの音量で流す（なければ無音）。
"""
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from .image_card import ACCENT, BG, SUBTEXT, TEXT, _font

W, H = 1080, 1920
FPS = 30
MARGIN = 100
# ショートの再生画面は右側（ボタン）と下側（タイトル・説明）が重なるので、文字はその外に置く
SAFE_RIGHT = 180
SAFE_TOP, SAFE_BOTTOM = 380, H - 520
FADE_SEC = 0.4
BGM = Path(__file__).resolve().parent.parent / "bgm.mp3"
CTA = ("見込み客リスト\n20件、\n無料で作ります", "DMで「リスト」と送ってください")


def slides_from_post(post: dict) -> list[tuple[str, str]]:
    """(大きい文字, 小さい文字) のスライドを並べる。X本文の締め（DMの案内）は共通の締めスライドに置き換える"""
    slides = [(post["image_title"], post["image_sub"])]
    for para in post["x"].split("\n\n"):
        para = para.strip()
        if para and "DM" not in para and "リスト" not in para:
            slides.append((para, ""))
    slides.append(CTA)
    return slides


def _duration(main: str, sub: str) -> float:
    """読み切れる長さ（1文字0.15秒、3〜7秒）"""
    return min(7.0, max(3.0, len(main + sub) * 0.15))


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


def _lines(text: str, font, max_w: int) -> list[str]:
    out = []
    for part in text.split("\n"):
        out += _wrap(part, font, max_w) if part else [""]
    return out


def render_slide(main: str, sub: str, index: int, total: int) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    max_w = W - MARGIN - SAFE_RIGHT

    # 上部：ブランドと進み具合
    d.rectangle([MARGIN, 200, MARGIN + 12, 252], fill=ACCENT)
    d.text((MARGIN + 36, 202), "AXION SALES", font=_font("Bold", 42), fill=ACCENT)
    d.text((MARGIN + 36, 262), "名古屋の営業代行", font=_font("Regular", 32), fill=SUBTEXT)
    for i in range(total):
        x = W - SAFE_RIGHT - (total - i) * 40
        d.ellipse([x, 222, x + 16, 238], fill=ACCENT if i == index else (60, 78, 105))

    for size in (100, 90, 80, 72, 64, 56):
        main_font = _font("Bold", size)
        main_lines = _lines(main, main_font, max_w)
        if len(main_lines) * size * 1.45 <= SAFE_BOTTOM - SAFE_TOP - 200:
            break
    sub_font = _font("Regular", 48)
    sub_lines = _lines(sub, sub_font, max_w) if sub else []

    main_lh, sub_lh = int(size * 1.45), 70
    block_h = len(main_lines) * main_lh + (110 + len(sub_lines) * sub_lh if sub_lines else 0)
    y = SAFE_TOP + max(0, (SAFE_BOTTOM - SAFE_TOP - block_h) // 2)
    for ln in main_lines:
        d.text((MARGIN, y), ln, font=main_font, fill=TEXT)
        y += main_lh
    if sub_lines:
        y += 40
        d.rectangle([MARGIN, y, MARGIN + 140, y + 10], fill=ACCENT)
        y += 70
        for ln in sub_lines:
            d.text((MARGIN, y), ln, font=sub_font, fill=SUBTEXT)
            y += sub_lh
    return img


def make_short(post: dict, out_path: str, bgm: Path = BGM) -> float:
    """動画を書き出して、長さ（秒）を返す"""
    import imageio_ffmpeg

    slides = slides_from_post(post)
    frames = [render_slide(m, s, i, len(slides)) for i, (m, s) in enumerate(slides)]
    durations = [_duration(m, s) for m, s in slides]
    total = sum(durations)

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

    fade = int(FADE_SEC * FPS)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i, (frame, sec) in enumerate(zip(frames, durations)):
        n = int(sec * FPS)
        raw = frame.tobytes()
        nxt = frames[i + 1] if i + 1 < len(frames) else None
        for f in range(n):
            if nxt is not None and f >= n - fade:  # 次のスライドへクロスフェード
                proc.stdin.write(Image.blend(frame, nxt, (f - (n - fade) + 1) / (fade + 1)).tobytes())
            else:
                proc.stdin.write(raw)
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("動画の書き出しに失敗しました（ffmpeg）")
    return total
