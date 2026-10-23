"""Instagram用の画像（1080x1350 JPEG）を文字だけで作る。InstagramのAPIはPNGを受け付けない。"""
import glob

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1350
BG = (14, 27, 48)          # 濃紺
ACCENT = (232, 176, 58)    # ゴールド
TEXT = (255, 255, 255)
SUBTEXT = (190, 200, 215)
MARGIN = 96


def _font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    patterns = [
        f"/usr/share/fonts/opentype/noto/NotoSansCJK-{weight}.ttc",
        f"/usr/share/fonts/**/NotoSansCJK*{weight}*.tt[cf]",
        "/usr/share/fonts/**/NotoSansCJK*.tt[cf]",
    ]
    for p in patterns:
        hits = sorted(glob.glob(p, recursive=True))
        if hits:
            return ImageFont.truetype(hits[0], size, index=0)  # index 0 = 日本語(JP)
    raise RuntimeError("日本語フォントが見つかりません（fonts-noto-cjk をインストールしてください）")


def _wrap(text: str, font, max_width: int) -> list[str]:
    """日本語は単語区切りがないので1文字ずつ測って折り返す。行頭の句読点は前の行へ。"""
    lines, line = [], ""
    for ch in text.replace("\n", ""):
        if font.getlength(line + ch) <= max_width or (ch in "、。，．！？」』）" and line):
            line += ch
        else:
            lines.append(line)
            line = ch
    if line:
        lines.append(line)
    return lines


def make_card(title: str, sub: str, out_path: str) -> str:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 上部：ブランド名
    brand_font = _font("Bold", 40)
    d.rectangle([MARGIN, 120, MARGIN + 12, 172], fill=ACCENT)
    d.text((MARGIN + 36, 122), "AXION SALES", font=brand_font, fill=ACCENT)

    # 中央：見出し（長さに応じて文字サイズを下げる）
    max_w = W - MARGIN * 2
    for size in (96, 86, 76, 68, 60):
        title_font = _font("Bold", size)
        title_lines = _wrap(title, title_font, max_w)
        if len(title_lines) <= 4:
            break
    sub_font = _font("Regular", 42)
    sub_lines = _wrap(sub, sub_font, max_w)

    title_lh, sub_lh = int(size * 1.4), 64
    block_h = len(title_lines) * title_lh + 70 + len(sub_lines) * sub_lh
    y = (H - block_h) // 2
    for ln in title_lines:
        d.text((MARGIN, y), ln, font=title_font, fill=TEXT)
        y += title_lh
    y += 40
    d.rectangle([MARGIN, y, MARGIN + 120, y + 8], fill=ACCENT)
    y += 50
    for ln in sub_lines:
        d.text((MARGIN, y), ln, font=sub_font, fill=SUBTEXT)
        y += sub_lh

    # 下部
    foot_font = _font("Regular", 34)
    d.line([MARGIN, H - 190, W - MARGIN, H - 190], fill=(60, 78, 105), width=2)
    d.text((MARGIN, H - 150), "名古屋の営業代行｜AXION SALES", font=foot_font, fill=SUBTEXT)

    img.save(out_path, "JPEG", quality=92, optimize=True)
    return out_path
