"""ショート動画の2人のキャラクター（AXION SALES 公式イラスト、assets/ の切り抜きPNG）。

アポくん：話すのが好きでフットワークの軽い行動派の営業マン。ムードメーカー
つながりちゃん：丁寧で気配り上手。相手の「本音」を引き出すのが得意
"""
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ASSETS = Path(__file__).resolve().parent.parent / "assets"
HEIGHT = 540                      # アポくんの表示の高さ。2人は同じ倍率で縮める（元の身長差を保つ）

NAMES = {"apo": "アポくん", "tsunagari": "つながりちゃん"}
COLORS = {"apo": (40, 96, 200), "tsunagari": (226, 92, 140)}


@lru_cache(maxsize=None)
def _scale() -> float:
    return HEIGHT / Image.open(ASSETS / "apo.png").height


@lru_cache(maxsize=None)
def sprite(who: str, active: bool = True) -> Image.Image:
    """話している方は明るく、聞いている方は少し暗くする"""
    img = Image.open(ASSETS / f"{who}.png").convert("RGBA")
    img = img.resize((round(img.width * _scale()), round(img.height * _scale())), Image.LANCZOS)
    if not active:
        rgb = ImageEnhance.Brightness(img.convert("RGB")).enhance(0.7)
        rgb.putalpha(img.getchannel("A"))
        img = rgb
    return img


@lru_cache(maxsize=None)
def glow(who: str) -> Image.Image:
    """話している人の後ろに出す、キャラの色のやわらかい光（イラスト原画の雰囲気に合わせる）"""
    w, h = 520, 640
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([60, 60, w - 60, h - 60], fill=COLORS[who] + (150,))
    return img.filter(ImageFilter.GaussianBlur(70))
