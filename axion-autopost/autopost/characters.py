"""ショート動画の2人のキャラクター（Pillowで描く）。

アクシー：AXION SALES の営業担当。紺のジャケットに金のネクタイ。答える側
ゲンちゃん：現場で働く社長。黄色いヘルメット。本音や疑問を言う側
2倍の大きさで描いてから縮小し、線をなめらかにする。
"""
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter

SS = 2                      # 描画倍率（アンチエイリアス用）
SPRITE_W, SPRITE_H = 360, 440

SKIN = (255, 226, 204)
BLUSH = (255, 160, 165)
EYE = (40, 36, 48)
MOUTH = (176, 64, 72)
NAVY = (36, 56, 100)
NAVY_DARK = (26, 40, 74)
GOLD = (232, 176, 58)
WHITE = (255, 255, 255)
HAT = (255, 204, 40)
HAT_DARK = (226, 168, 20)
VEST = (255, 138, 60)
SHIRT = (150, 190, 230)
STRIPE = (235, 240, 245)

NAMES = {"axie": "アクシー", "gen": "ゲンちゃん"}


def _s(*v):
    return [x * SS for x in v]


def _face(d: ImageDraw.ImageDraw, cx: int, cy: int, r: int, mouth_open: bool, brows: bool = False):
    d.ellipse(_s(cx - r, cy - r, cx + r, cy + r), fill=SKIN)
    ex, ey = 34, cy + 6
    for sx in (-1, 1):
        x = cx + sx * ex
        d.ellipse(_s(x - 11, ey - 15, x + 11, ey + 15), fill=EYE)          # 目
        d.ellipse(_s(x - 6, ey - 10, x + 1, ey - 3), fill=WHITE)           # ハイライト
        d.ellipse(_s(x + sx * 18 - 15, ey + 22, x + sx * 18 + 13, ey + 36), fill=BLUSH)  # ほっぺ
        if brows:
            d.rounded_rectangle(_s(x - 16, ey - 34, x + 14, ey - 27), radius=3 * SS, fill=EYE)
    my = cy + 44
    if mouth_open:
        d.ellipse(_s(cx - 13, my - 8, cx + 13, my + 14), fill=MOUTH)
        d.ellipse(_s(cx - 7, my + 4, cx + 7, my + 12), fill=(240, 120, 130))  # 舌
    else:
        d.arc(_s(cx - 14, my - 14, cx + 14, my + 6), start=20, end=160, fill=MOUTH, width=4 * SS)


def _hands(d, cx, y, color):
    for sx in (-1, 1):
        x = cx + sx * 112
        d.ellipse(_s(x - 22, y - 22, x + 22, y + 22), fill=color)


def _axie(mouth_open: bool) -> Image.Image:
    img = Image.new("RGBA", _s(SPRITE_W, SPRITE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = SPRITE_W // 2
    # 体：紺のジャケット・白いシャツ・金のネクタイ
    d.rounded_rectangle(_s(cx - 110, 268, cx + 110, 432), radius=60 * SS, fill=NAVY)
    d.polygon(_s(cx - 46, 270, cx + 46, 270, cx, 360), fill=WHITE)
    d.polygon(_s(cx - 12, 278, cx + 12, 278, cx + 16, 350, cx, 372, cx - 16, 350), fill=GOLD)
    d.polygon(_s(cx - 46, 270, cx - 8, 270, cx - 30, 330), fill=NAVY_DARK)   # 襟
    d.polygon(_s(cx + 46, 270, cx + 8, 270, cx + 30, 330), fill=NAVY_DARK)
    d.ellipse(_s(cx + 50, 330, cx + 78, 358), fill=GOLD)                       # バッジ
    _hands(d, cx, 370, SKIN)
    # 頭
    _face(d, cx, 160, 112, mouth_open)
    # 髪（紺・前髪はギザギザに流す）
    hair = (58, 70, 110)
    d.chord(_s(cx - 120, 38, cx + 120, 250), start=180, end=360, fill=hair)
    for bx, by, r in ((-88, 128, 34), (-48, 118, 36), (-6, 112, 34), (36, 110, 30), (74, 116, 28), (100, 132, 22)):
        d.ellipse(_s(cx + bx - r, by - r, cx + bx + r, by + r), fill=hair)     # 前髪
    d.ellipse(_s(cx - 124, 120, cx - 92, 196), fill=hair)                        # もみあげ
    d.ellipse(_s(cx + 92, 120, cx + 124, 196), fill=hair)
    d.polygon(_s(cx - 6, 44, cx + 26, 6, cx + 22, 52), fill=hair)              # アホ毛
    d.arc(_s(cx - 70, 52, cx + 10, 112), start=200, end=280, fill=(110, 125, 170), width=5 * SS)  # つや
    return img.resize((SPRITE_W, SPRITE_H), Image.LANCZOS)


def _gen(mouth_open: bool) -> Image.Image:
    img = Image.new("RGBA", _s(SPRITE_W, SPRITE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = SPRITE_W // 2
    # 体：水色のシャツにオレンジのベスト（反射テープ）
    d.rounded_rectangle(_s(cx - 110, 268, cx + 110, 432), radius=60 * SS, fill=SHIRT)
    d.rounded_rectangle(_s(cx - 104, 272, cx - 22, 432), radius=40 * SS, fill=VEST)
    d.rounded_rectangle(_s(cx + 22, 272, cx + 104, 432), radius=40 * SS, fill=VEST)
    for y in (330, 380):
        d.rectangle(_s(cx - 100, y, cx - 26, y + 14), fill=STRIPE)
        d.rectangle(_s(cx + 26, y, cx + 100, y + 14), fill=STRIPE)
    _hands(d, cx, 370, SKIN)
    # 頭（少し丸め・眉あり）
    _face(d, cx, 168, 112, mouth_open, brows=True)
    # 黄色いヘルメット
    d.chord(_s(cx - 122, 36, cx + 122, 200), start=180, end=360, fill=HAT)
    d.rounded_rectangle(_s(cx - 138, 108, cx + 138, 130), radius=11 * SS, fill=HAT_DARK)
    d.rounded_rectangle(_s(cx - 14, 40, cx + 14, 110), radius=8 * SS, fill=HAT_DARK)
    d.ellipse(_s(cx - 70, 64, cx - 46, 88), fill=(255, 236, 150))               # つや
    return img.resize((SPRITE_W, SPRITE_H), Image.LANCZOS)


def _outline(img: Image.Image, width: int = 7) -> Image.Image:
    """白いふちどりを付けてステッカー風にする（紺の背景でも輪郭が見えるように）"""
    alpha = img.getchannel("A").filter(ImageFilter.MaxFilter(width * 2 + 1))
    out = Image.new("RGBA", img.size, (255, 255, 255, 0))
    out.putalpha(alpha)
    out.alpha_composite(img)
    return out


@lru_cache(maxsize=None)
def sprite(who: str, mouth_open: bool) -> Image.Image:
    return _outline((_axie if who == "axie" else _gen)(mouth_open))
