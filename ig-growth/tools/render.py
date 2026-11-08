"""画像を作る：カルーセル（1080x1350）・リール表紙（1080x1920）・ストーリーズ背景・アイコン・ハイライト表紙。

デザインのルールは docs/04_アカウント名・プロフィール・デザイン.md の 6 章。
文字は自動で縮めて枠に収める。最小サイズでも収まらないときは warnings に記録する（`check` で表示）。
"""
from __future__ import annotations

import re
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

from common import FONTS, OUTPUT, load_brand

FONT_URL = "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-{w}.otf"
FALLBACKS = ["/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
             "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", "C:/Windows/Fonts/meiryo.ttc"]
NO_START = set("”’、。，．・：；？！」』）】〉》ー…ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ%,.!?)]}〜")
NO_END = set("“‘「『（【〈《([{")
W, H_FEED, H_TALL = 1080, 1350, 1920
MARGIN = 90

warnings: list[str] = []
_font_cache: dict = {}
_font_path_cache: dict = {}


# ---------------------------------------------------------------- フォント
def font_path(weight: str) -> str:
    if weight in _font_path_cache:
        return _font_path_cache[weight]
    p = FONTS / f"NotoSansCJKjp-{weight}.otf"
    if not p.exists():
        try:
            FONTS.mkdir(parents=True, exist_ok=True)
            print(f"フォントをダウンロード中：Noto Sans CJK JP {weight}（初回のみ）")
            urllib.request.urlretrieve(FONT_URL.format(w=weight), p)
        except Exception as e:  # ネットがない環境ではOS内のフォントを使う
            p.unlink(missing_ok=True)
            for fb in FALLBACKS:
                if Path(fb).exists():
                    warnings.append(f"Noto フォントを取得できず {fb} を使用（{e}）")
                    _font_path_cache[weight] = fb
                    return fb
            raise RuntimeError("日本語フォントが見つかりません。fonts/ に NotoSansCJKjp-Bold.otf などを置いてください")
    _font_path_cache[weight] = str(p)
    return str(p)


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    key = (weight, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(font_path(weight), size)
    return _font_cache[key]


def hex2rgb(h: str) -> tuple:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ---------------------------------------------------------------- 文字組み
def parse_rich(text: str) -> list[tuple[str, str]]:
    """`**強調**`＝accent、`==マーカー==`＝marker。1 文字ずつ (文字, スタイル) にする。"""
    out = []
    for part in re.split(r"(\*\*.+?\*\*|==.+?==)", text, flags=re.S):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            out += [(c, "accent") for c in part[2:-2]]
        elif part.startswith("==") and part.endswith("=="):
            out += [(c, "marker") for c in part[2:-2]]
        else:
            out += [(c, "normal") for c in part]
    return out


def _units(chars):
    """英数字の連続は 1 単位（途中で改行しない）。"""
    units, buf = [], []
    for ch in chars:
        if re.match(r"[A-Za-z0-9#@_./:%\-+]", ch[0]):
            buf.append(ch)
        else:
            if buf:
                units.append(buf)
                buf = []
            units.append([ch])
    if buf:
        units.append(buf)
    return units


def wrap(text: str, fnt, max_w: int) -> list[list[tuple[str, str]]]:
    lines = []
    for para in text.split("\n"):
        chars = parse_rich(para)
        cur, cur_w = [], 0.0
        for unit in _units(chars):
            uw = sum(fnt.getlength(c) for c, _ in unit)
            if cur and cur_w + uw > max_w:
                if unit[0][0] in NO_START:          # 行頭禁則：前の行にぶら下げる
                    cur += unit
                    lines.append(cur)
                    cur, cur_w = [], 0.0
                    continue
                carry = []
                while cur and cur[-1][0] in NO_END:  # 行末禁則：次の行へ送る
                    carry.insert(0, cur.pop())
                lines.append(cur)
                cur = carry + unit
                cur_w = sum(fnt.getlength(c) for c, _ in cur)
            else:
                cur += unit
                cur_w += uw
        if cur or not chars:
            lines.append(cur)
    return lines


def line_width(line, fnt) -> float:
    return sum(fnt.getlength(c) for c, _ in line)


def fit(text: str, weight: str, max_size: int, min_size: int, max_w: int, max_h: int,
        spacing: float = 1.35, where: str = "", keep_lines: bool = False) -> tuple:
    """枠に収まる最大の文字サイズを探す。戻り値：(font, lines, line_height)。
    keep_lines=True（見出し用）：書いた改行どおりの行数に収まるまで縮める（変な位置で折り返さない）。"""
    size = max_size
    n_para = len(text.split("\n"))
    while True:
        fnt = font(weight, size)
        lines = wrap(text, fnt, max_w)
        lh = int(size * spacing)
        ok_lines = (not keep_lines) or len(lines) <= n_para
        # 段落の最後の行が1〜2文字だけになる（「い。」など）のを避ける
        orphan = any(len(pl) > 1 and len(pl[-1]) <= 2 for pl in (wrap(p, fnt, max_w) for p in text.split("\n")))
        if (len(lines) * lh <= max_h and ok_lines and not orphan) or size <= min_size:
            if len(lines) * lh > max_h:
                warnings.append(f"{where}：文字が多すぎて枠に収まりません（{text[:20]}…）")
            return fnt, lines, lh
        size -= 2


def draw_lines(d: ImageDraw.ImageDraw, lines, fnt, lh: int, x: int, y: int, colors: dict,
               align: str = "left", box_w: int = 0) -> int:
    """複数行を描き、描き終わった y を返す。"""
    asc, desc = fnt.getmetrics()
    for line in lines:
        lw = line_width(line, fnt)
        cx = x + (box_w - lw) / 2 if align == "center" else x
        # マーカー（文字の下半分に黄色の帯）を先に描く
        mx = cx
        for c, st in line:
            cw = fnt.getlength(c)
            if st == "marker":
                d.rectangle([mx, y + asc * 0.55, mx + cw, y + asc * 1.05], fill=colors["marker"])
            mx += cw
        # 同じスタイルの連続をまとめて描く
        run, run_st, rx = "", None, cx
        for c, st in line + [("", None)]:
            if st != run_st and run:
                col = colors["accent"] if run_st == "accent" else colors["text"]
                d.text((rx, y), run, font=fnt, fill=col)
                rx += fnt.getlength(run)
                run = ""
            run_st = st
            run += c
        y += lh
    return y


def text_block_height(lines, lh) -> int:
    return len(lines) * lh


def pill(d: ImageDraw.ImageDraw, x: int, y: int, text: str, fnt, bg, fg, pad_x: int = 26, pad_y: int = 12,
         anchor_right: bool = False) -> tuple:
    tw = fnt.getlength(text)
    asc, desc = fnt.getmetrics()
    w, h = int(tw + pad_x * 2), int(asc + desc + pad_y * 2)
    if anchor_right:
        x = x - w
    d.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=bg)
    d.text((x + pad_x, y + pad_y), text, font=fnt, fill=fg)
    return x, y, w, h


def bookmark_icon(d, x, y, s, color):
    d.polygon([(x, y), (x + s * 0.7, y), (x + s * 0.7, y + s), (x + s * 0.35, y + s * 0.72), (x, y + s)], fill=color)


# ---------------------------------------------------------------- カルーセル
class Carousel:
    def __init__(self, item_id: str, slides: list[dict], brand: dict):
        self.id = item_id
        self.slides = slides
        self.b = brand
        self.c = {k: hex2rgb(v) for k, v in brand["colors"].items()}

    def palette(self, dark: bool) -> dict:
        c = self.c
        return {"text": c["white"] if dark else c["ink"], "accent": c["orange"], "marker": c["marker"]}

    def base(self, dark: bool, h: int = H_FEED):
        img = Image.new("RGB", (W, h), self.c["ink"] if dark else self.c["cream"])
        return img, ImageDraw.Draw(img)

    def chrome(self, d, n: int, total: int, dark: bool):
        """ページ番号・アカウント名。"""
        col = self.c["cover_sub"] if dark else self.c["gray"]
        f = font("Medium", 28)
        txt = f"{n:02d} / {total:02d}"
        d.text((W - MARGIN - f.getlength(txt), 70), txt, font=f, fill=col)
        d.text((MARGIN, H_FEED - 90), self.b["handle"], font=font("Medium", 28), fill=col)

    def title_area(self, d, s: dict, y: int, where: str, max_size=70, dark=False, max_h=330) -> int:
        if s.get("label"):
            _, _, _, ph = pill(d, MARGIN, y, s["label"], font("Bold", 32), self.c["orange"], self.c["white"])
            y += ph + 30
        if s.get("title"):
            f, lines, lh = fit(s["title"], "Black", max_size, 46, W - MARGIN * 2, max_h, 1.32, where, keep_lines=True)
            y = draw_lines(d, lines, f, lh, MARGIN, y, self.palette(dark))
            y += 10
            d.rectangle([MARGIN, y + 14, MARGIN + 70, y + 20], fill=self.c["orange"])
            y += 60
        self._body_top = y
        return y

    def balance(self, img: Image.Image) -> Image.Image:
        """本文が上に寄りすぎないよう、見出しの下〜フッターの間で少し下げる（余白の35%）。"""
        top = getattr(self, "_body_top", None)
        bottom = H_FEED - 130
        if not top or top >= bottom:
            return img
        region = img.crop((0, top, W, bottom))
        bg = Image.new("RGB", region.size, self.c["cream"])
        bbox = ImageChops.difference(region, bg).getbbox()
        if not bbox:
            return img
        content_top, content_bottom = bbox[1], bbox[3]
        shift = int(((bottom - top) - content_bottom) * 0.35)
        if shift < 20:
            return img
        img.paste(Image.new("RGB", (W, bottom - top), self.c["cream"]), (0, top))
        img.paste(region.crop((0, 0, W, content_bottom)), (0, top + shift))
        return img

    # 種類ごとの描画 ------------------------------------------------
    def s_cover(self, s, n, total, where):
        img, d = self.base(True)
        y = 210
        if s.get("label"):
            _, _, _, ph = pill(d, MARGIN, y, s["label"], font("Bold", 36), self.c["orange"], self.c["white"])
            y += ph + 60
        f, lines, lh = fit(s.get("title", ""), "Black", 128, 72, W - MARGIN * 2, 560, 1.28, where, keep_lines=True)
        y = draw_lines(d, lines, f, lh, MARGIN, y, self.palette(True)) + 30
        if s.get("sub"):
            f2, l2, lh2 = fit(s["sub"], "Medium", 44, 32, W - MARGIN * 2, 200, 1.5, where, keep_lines=True)
            draw_lines(d, l2, f2, lh2, MARGIN, y, {"text": self.c["cover_sub"], "accent": self.c["orange"],
                                                   "marker": self.c["marker"]})
        bookmark_icon(d, MARGIN, H_FEED - 230, 44, self.c["orange"])
        d.text((MARGIN + 50, H_FEED - 232), "保存して使ってください", font=font("Bold", 34), fill=self.c["white"])
        d.text((MARGIN, H_FEED - 120), self.b["handle"], font=font("Medium", 30), fill=self.c["cover_sub"])
        sw = "スワイプ →"
        d.text((W - MARGIN - font("Bold", 32).getlength(sw), H_FEED - 122), sw, font=font("Bold", 32),
               fill=self.c["orange"])
        return img

    def s_text(self, s, n, total, where):
        img, d = self.base(False)
        self.chrome(d, n, total, False)
        y = self.title_area(d, s, 150, where)
        f, lines, lh = fit(s.get("body", ""), "Medium", 48, 30, W - MARGIN * 2, H_FEED - 140 - y, 1.75, where)
        draw_lines(d, lines, f, lh, MARGIN, y, self.palette(False))
        return img

    def s_list(self, s, n, total, where):
        img, d = self.base(False)
        self.chrome(d, n, total, False)
        y = self.title_area(d, s, 150, where)
        items = s.get("items", [])
        avail = H_FEED - 150 - y
        gap = 18
        for scale in [x / 100 for x in range(125, 55, -5)]:
            hs, ds = int(46 * scale), int(34 * scale)
            hf, df = font("Bold", hs), font("Medium", ds)
            blocks = []
            for it in items:
                head, _, desc = it.partition("｜")
                hl = wrap(head, hf, W - MARGIN * 2 - 150)
                dl = wrap(desc, df, W - MARGIN * 2 - 150) if desc else []
                bh = len(hl) * int(hs * 1.35) + (len(dl) * int(ds * 1.5) + 8 if dl else 0) + 44
                blocks.append((hl, dl, max(bh, 104)))
            total_h = sum(b[2] for b in blocks) + gap * (len(blocks) - 1)
            if total_h <= avail:
                break
        else:
            warnings.append(f"{where}：項目が多すぎて枠に収まりません")
        pal = self.palette(False)
        for i, (hl, dl, bh) in enumerate(blocks, 1):
            d.rounded_rectangle([MARGIN, y, W - MARGIN, y + bh], radius=22, fill=self.c["white"],
                                outline=self.c["line"], width=2)
            cx, cy, r = MARGIN + 60, y + bh // 2, 32
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=self.c["orange"])
            num = str(i)
            nf = font("Black", 34)
            d.text((cx - nf.getlength(num) / 2, cy - 24), num, font=nf, fill=self.c["white"])
            content_h = len(hl) * int(hs * 1.35) + (len(dl) * int(ds * 1.5) + 8 if dl else 0)
            ty = y + (bh - content_h) // 2 - 4
            ty = draw_lines(d, hl, hf, int(hs * 1.35), MARGIN + 120, ty, pal)
            if dl:
                draw_lines(d, dl, df, int(ds * 1.5), MARGIN + 120, ty + 8,
                           {"text": self.c["gray"], "accent": self.c["orange"], "marker": self.c["marker"]})
            y += bh + gap
        return img

    def prompt_card(self, d, text: str, x0, y0, x1, max_h, where, tag="コピペ用") -> int:
        pad = 44
        f, lines, lh = fit(text, "Medium", 44, 24, x1 - x0 - pad * 2, max_h - pad * 2 - 20, 1.6, where)
        h = len(lines) * lh + pad * 2 + 10
        d.rounded_rectangle([x0, y0, x1, y0 + h], radius=26, fill=self.c["white"], outline=self.c["ink"], width=4)
        pill(d, x0 + 30, y0 - 26, tag, font("Bold", 28), self.c["orange"], self.c["white"], 22, 8)
        draw_lines(d, lines, f, lh, x0 + pad, y0 + pad + 6, self.palette(False))
        return y0 + h

    def s_prompt(self, s, n, total, where):
        img, d = self.base(False)
        self.chrome(d, n, total, False)
        y = self.title_area(d, s, 150, where, max_size=64, max_h=260)
        if s.get("body"):
            f, lines, lh = fit(s["body"], "Medium", 38, 28, W - MARGIN * 2, 160, 1.6, where)
            y = draw_lines(d, lines, f, lh, MARGIN, y, self.palette(False)) + 30
        note_h = 90 if s.get("note") else 0
        y = self.prompt_card(d, s.get("prompt", ""), MARGIN, y + 46, W - MARGIN, H_FEED - 176 - y - note_h, where)
        if s.get("note"):
            f, lines, lh = fit("※" + s["note"], "Medium", 30, 24, W - MARGIN * 2, 90, 1.5, where)
            draw_lines(d, lines, f, lh, MARGIN, y + 24, {"text": self.c["gray"], "accent": self.c["orange"],
                                                         "marker": self.c["marker"]})
        return img

    def s_chat(self, s, n, total, where):
        img, d = self.base(False)
        self.chrome(d, n, total, False)
        y = self.title_area(d, s, 150, where) + 10
        nf, bf = font("Medium", 26), font("Medium", 38)
        for msg in s.get("messages", []):
            who, _, said = msg.partition(":")
            who, said = who.strip(), said.strip()
            me = who in ("自分", "わたし", "私")
            lines = wrap(said, bf, 600)
            lh = int(38 * 1.5)
            bw = max(line_width(l, bf) for l in lines) + 64
            bh = len(lines) * lh + 40
            if not me:
                d.text((MARGIN + 8, y), who, font=nf, fill=self.c["gray"])
                y += 40
            x0 = W - MARGIN - bw if me else MARGIN
            d.rounded_rectangle([x0, y, x0 + bw, y + bh], radius=30,
                                fill=self.c["bubble_me"] if me else self.c["white"],
                                outline=None if me else self.c["line"], width=2)
            draw_lines(d, lines, bf, lh, x0 + 32, y + 18, self.palette(False))
            y += bh + 34
        if y > H_FEED - 140:
            warnings.append(f"{where}：会話が多すぎて枠に収まりません")
        return img

    def s_compare(self, s, n, total, where):
        img, d = self.base(False)
        self.chrome(d, n, total, False)
        y = self.title_area(d, s, 150, where, max_h=260)
        y += 30
        avail = H_FEED - 150 - y - 70
        for i, side in enumerate(("left", "right")):
            label = s.get(f"{side}_label", "")
            body = s.get(side, "")
            f, lines, lh = fit(body, "Medium" if i == 0 else "Bold", 38, 26, W - MARGIN * 2 - 80,
                               int(avail * (0.36 if i == 0 else 0.64)) - 90, 1.5, where)
            h = len(lines) * lh + 90
            outline = self.c["line"] if i == 0 else self.c["orange"]
            d.rounded_rectangle([MARGIN, y, W - MARGIN, y + h], radius=24, fill=self.c["white"], outline=outline,
                                width=3 if i == 0 else 5)
            pill(d, MARGIN + 30, y - 24, label, font("Bold", 28), self.c["gray"] if i == 0 else self.c["orange"],
                 self.c["white"], 22, 8)
            draw_lines(d, lines, f, lh, MARGIN + 40, y + 50,
                       {"text": self.c["gray"] if i == 0 else self.c["ink"], "accent": self.c["orange"],
                        "marker": self.c["marker"]})
            y += h
            if i == 0:
                ax = W // 2
                d.polygon([(ax - 30, y + 18), (ax + 30, y + 18), (ax, y + 52)], fill=self.c["orange"])
                y += 80
        return img

    def s_summary(self, s, n, total, where):
        img, d = self.base(False)
        self.chrome(d, n, total, False)
        y = self.title_area(d, s, 150, where)
        items = s.get("items", [])
        body_h = 170 if s.get("body") else 0
        avail = H_FEED - 150 - y - body_h
        size = 46
        while size > 26:
            f = font("Bold", size)
            rows = [wrap(t, f, W - MARGIN * 2 - 150) for t in items]
            row_h = [len(r) * int(size * 1.35) + 34 for r in rows]
            if sum(row_h) + 60 <= avail:
                break
            size -= 2
        top = y
        total_h = sum(row_h) + 60
        d.rounded_rectangle([MARGIN, top, W - MARGIN, top + total_h], radius=26, fill=self.c["white"],
                            outline=self.c["ink"], width=3)
        y = top + 30
        for r, rh in zip(rows, row_h):
            bx, by, bs = MARGIN + 44, y + (rh - 34) // 2 - 2, 34
            d.rounded_rectangle([bx, by, bx + bs, by + bs], radius=6, outline=self.c["orange"], width=4)
            d.line([(bx + 7, by + 18), (bx + 15, by + 26), (bx + 28, by + 9)], fill=self.c["orange"], width=5)
            draw_lines(d, r, f, int(size * 1.35), MARGIN + 110, y + 10, self.palette(False))
            y += rh
        if s.get("body"):
            f2, l2, lh2 = fit(s["body"], "Bold", 36, 26, W - MARGIN * 2, body_h - 30, 1.55, where)
            draw_lines(d, l2, f2, lh2, MARGIN, top + total_h + 40, self.palette(False))
        return img

    def s_cta(self, s, n, total, where):
        img, d = self.base(True)
        d.text((W - MARGIN - font("Medium", 28).getlength(f"{n:02d} / {total:02d}"), 70),
               f"{n:02d} / {total:02d}", font=font("Medium", 28), fill=self.c["cover_sub"])
        y = 230
        f, lines, lh = fit(s.get("title", ""), "Black", 84, 54, W - MARGIN * 2, 360, 1.3, where, keep_lines=True)
        y = draw_lines(d, lines, f, lh, MARGIN, y, self.palette(True)) + 30
        if s.get("body"):
            f2, l2, lh2 = fit(s["body"], "Medium", 38, 28, W - MARGIN * 2, 160, 1.55, where)
            y = draw_lines(d, l2, f2, lh2, MARGIN, y, {"text": self.c["cover_sub"], "accent": self.c["orange"],
                                                       "marker": self.c["marker"]})
        # フォローのカード
        cy = max(y + 60, 800)
        d.rounded_rectangle([MARGIN, cy, W - MARGIN, cy + 330], radius=30, fill=self.c["white"])
        d.text((MARGIN + 50, cy + 50), self.b["handle"], font=font("Black", 46), fill=self.c["ink"])
        d.text((MARGIN + 50, cy + 125), self.b["promise"], font=font("Medium", 34), fill=self.c["gray"])
        bx = MARGIN + 50
        _, _, w1, _ = pill(d, bx, cy + 205, "フォローする", font("Bold", 34), self.c["orange"], self.c["white"], 40, 16)
        pill(d, bx + w1 + 24, cy + 205, "保存する", font("Bold", 34), self.c["ink"], self.c["white"], 40, 16)
        return img

    def render(self, out_dir: Path) -> list[Path]:
        out_dir.mkdir(parents=True, exist_ok=True)
        for old in out_dir.glob("*.jpg"):
            old.unlink()
        paths = []
        total = len(self.slides)
        for n, s in enumerate(self.slides, 1):
            fn = getattr(self, f"s_{s['type']}", None)
            if fn is None:
                warnings.append(f"{self.id} {n}枚目：知らないスライドの種類 {s['type']}")
                continue
            self._body_top = None
            img = fn(s, n, total, f"{self.id} {n}枚目")
            if s["type"] not in ("cover", "cta"):
                img = self.balance(img)
            p = out_dir / f"{n:02d}.jpg"
            img.save(p, "JPEG", quality=92)
            paths.append(p)
        return paths


# ---------------------------------------------------------------- リール表紙
def render_reel_cover(item_id: str, cover: dict, brand: dict, out: Path) -> Path:
    c = {k: hex2rgb(v) for k, v in brand["colors"].items()}
    img = Image.new("RGB", (W, H_TALL), c["ink"])
    d = ImageDraw.Draw(img)
    where = f"{item_id} 表紙"
    # 文字はすべて中央の 1080x1350（y=285〜1635）に入れる＝プロフィール一覧で切れない
    top = 285 + 110
    y = top
    if cover.get("label"):
        _, _, _, ph = pill(d, MARGIN, y, cover["label"], font("Bold", 40), c["orange"], c["white"], 30, 14)
        y += ph + 60
    f, lines, lh = fit(cover.get("title", ""), "Black", 140, 80, W - MARGIN * 2, 560, 1.25, where, keep_lines=True)
    y = draw_lines(d, lines, f, lh, MARGIN, y, {"text": c["white"], "accent": c["orange"], "marker": c["marker"]}) + 40
    if cover.get("sub"):
        f2, l2, lh2 = fit(cover["sub"], "Medium", 48, 34, W - MARGIN * 2, 180, 1.45, where, keep_lines=True)
        draw_lines(d, l2, f2, lh2, MARGIN, y, {"text": c["cover_sub"], "accent": c["orange"], "marker": c["marker"]})
    # 文字のかたまりを安全範囲（285〜1500）の中央へ
    zone_top, zone_bottom = 285, 1500
    region = img.crop((0, zone_top, W, zone_bottom))
    bbox = ImageChops.difference(region, Image.new("RGB", region.size, c["ink"])).getbbox()
    if bbox:
        block = region.crop((0, bbox[1], W, bbox[3]))
        img.paste(Image.new("RGB", region.size, c["ink"]), (0, zone_top))
        img.paste(block, (0, zone_top + ((zone_bottom - zone_top) - block.height) // 2))
    d.text((MARGIN, 1635 - 110), brand["handle"], font=font("Medium", 34), fill=c["cover_sub"])
    if y > 1635 - 140:
        warnings.append(f"{where}：一覧で切れる位置まで文字があります")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "JPEG", quality=92)
    return out


# ---------------------------------------------------------------- ストーリーズ・ブランド素材
STORY_TEMPLATES = [
    ("01_アンケート", "ink", "今日のアンケート", "AI、仕事で\n**使ってる？**", "↓ 下のスタンプで答えてください"),
    ("02_質問箱", "cream", "質問箱", "AIに頼みたいけど\n**頼み方が分からない**\n仕事は？", "答えはリールで返します"),
    ("03_クイズ", "ink", "クイズ", "AIに入れても\n**大丈夫なのは**\nどれ？", "↓ 選んでください"),
    ("04_スライダー", "cream", "教えてください", "言いにくいメール\n**しんどさ**は？", "↓ スライダーで"),
    ("05_新しい投稿", "ink", "新しい投稿", "今日の頼み方\n**できました**", "↓ タップして見る"),
    ("06_今週のまとめ", "cream", "今週のまとめ", "今週いちばん\n**保存された**投稿", "↓ 見逃した人はこちら"),
]
HIGHLIGHTS = [("01_はじめに", "はじめに"), ("02_コピペ集", "コピペ集"), ("03_営業のAI", "営業のAI"),
              ("04_注意点", "注意点"), ("05_質問箱", "質問箱")]


def render_story_templates(brand: dict, out_dir: Path) -> list[Path]:
    c = {k: hex2rgb(v) for k, v in brand["colors"].items()}
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, tone, label, title, hint in STORY_TEMPLATES:
        dark = tone == "ink"
        img = Image.new("RGB", (W, H_TALL), c["ink"] if dark else c["cream"])
        d = ImageDraw.Draw(img)
        y = 330  # 上 250px は UI と重なるので空ける
        _, _, _, ph = pill(d, MARGIN, y, label, font("Bold", 40), c["orange"], c["white"], 30, 14)
        y += ph + 50
        f, lines, lh = fit(title, "Black", 110, 70, W - MARGIN * 2, 480, 1.28, f"ストーリーズ {name}", keep_lines=True)
        y = draw_lines(d, lines, f, lh, MARGIN, y, {"text": c["white"] if dark else c["ink"], "accent": c["orange"],
                                                    "marker": c["marker"]}) + 30
        d.text((MARGIN, y), hint, font=font("Medium", 40), fill=c["cover_sub"] if dark else c["gray"])
        # スタンプを置く場所の目印（薄い点線の枠）
        bx0, by0, bx1, by1 = MARGIN, 1080, W - MARGIN, 1500
        col = (60, 70, 90) if dark else (225, 220, 208)
        for x in range(bx0, bx1, 36):
            d.line([(x, by0), (x + 18, by0)], fill=col, width=3)
            d.line([(x, by1), (x + 18, by1)], fill=col, width=3)
        for yy in range(by0, by1, 36):
            d.line([(bx0, yy), (bx0, yy + 18)], fill=col, width=3)
            d.line([(bx1, yy), (bx1, yy + 18)], fill=col, width=3)
        d.text((MARGIN, H_TALL - 340 - 60), brand["handle"], font=font("Medium", 32),
               fill=c["cover_sub"] if dark else c["gray"])
        p = out_dir / f"story_{name}.jpg"
        img.save(p, "JPEG", quality=92)
        paths.append(p)
    return paths


def render_brand(brand: dict, out_dir: Path) -> list[Path]:
    c = {k: hex2rgb(v) for k, v in brand["colors"].items()}
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    S = 1080

    def center_text(d, text, f, y, color):
        d.text(((S - f.getlength(text)) / 2, y), text, font=f, fill=color)

    # A：濃紺に白の「AI」＋オレンジ「コピペ」
    img = Image.new("RGB", (S, S), c["ink"])
    d = ImageDraw.Draw(img)
    center_text(d, "AI", font("Black", 420), 190, c["white"])
    f = font("Black", 92)
    tw = f.getlength("コピペ")
    d.rounded_rectangle([(S - tw) / 2 - 50, 700, (S + tw) / 2 + 50, 840], radius=70, fill=c["orange"])
    center_text(d, "コピペ", f, 708, c["white"])
    paths.append(out_dir / "icon_A.jpg")
    img.save(paths[-1], "JPEG", quality=95)

    # B：濃紺に「AI」＋入力中のカーソル
    img = Image.new("RGB", (S, S), c["ink"])
    d = ImageDraw.Draw(img)
    f = font("Black", 440)
    tw = f.getlength("AI")
    x = (S - tw - 90) / 2
    d.text((x, 200), "AI", font=f, fill=c["white"])
    d.rectangle([x + tw + 40, 330, x + tw + 90, 760], fill=c["orange"])
    paths.append(out_dir / "icon_B.jpg")
    img.save(paths[-1], "JPEG", quality=95)

    # C：オレンジに濃紺「AI 仕事術」
    img = Image.new("RGB", (S, S), c["orange"])
    d = ImageDraw.Draw(img)
    center_text(d, "AI", font("Black", 360), 170, c["ink"])
    center_text(d, "仕事術", font("Black", 170), 640, c["ink"])
    paths.append(out_dir / "icon_C.jpg")
    img.save(paths[-1], "JPEG", quality=95)

    # ハイライト表紙（1080x1920。中央が丸く切り抜かれる）
    for name, label in HIGHLIGHTS:
        img = Image.new("RGB", (W, H_TALL), c["ink"])
        d = ImageDraw.Draw(img)
        f = font("Black", 150 if len(label) <= 4 else 120)
        tw = f.getlength(label)
        d.text(((W - tw) / 2, H_TALL / 2 - 110), label, font=f, fill=c["white"])
        d.rectangle([W / 2 - 60, H_TALL / 2 + 140, W / 2 + 60, H_TALL / 2 + 154], fill=c["orange"])
        paths.append(out_dir / f"highlight_{name}.jpg")
        img.save(paths[-1], "JPEG", quality=92)
    return paths
