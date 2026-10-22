"""cards.csv から Instagram 用の画像（1080×1350 JPEG）を生成し、posts.csv の画像URLを埋める。

images/ は main ブランチにマージすると Vercel で公開され、Instagram API がその URL から画像を取得する。
"""
import csv
import html
import re

import config
from common import POST_FIELDS, load_posts, read_csv

CARD_FIELDS = ["ID", "ラベル", "見出し", "項目", "結び"]

TEMPLATE = """<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    width: 1080px; height: 1350px; overflow: hidden;
    font-family: 'Noto Sans JP', 'IPAGothic', sans-serif;
    background: linear-gradient(160deg, #0f2340 0%, #1b3a63 100%); color: #fff;
    display: flex; flex-direction: column; padding: 96px 88px 72px;
  }}
  .label {{
    align-self: flex-start; font-size: 30px; font-weight: 700; letter-spacing: 0.06em;
    color: #0f2340; background: #e8962e; padding: 10px 28px; border-radius: 999px; margin-bottom: 48px;
  }}
  h1 {{ font-size: {title_size}px; font-weight: 900; line-height: 1.45; margin-bottom: 56px; }}
  h1 em {{ font-style: normal; color: #e8962e; }}
  ul {{ list-style: none; display: grid; gap: 24px; }}
  li {{
    background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.16); border-radius: 20px;
    padding: 26px 32px 26px 96px; position: relative; font-size: {item_size}px; font-weight: 500; line-height: 1.5;
  }}
  li::before {{
    content: attr(data-n); position: absolute; left: 28px; top: 50%; transform: translateY(-50%);
    width: 48px; height: 48px; border-radius: 50%; background: #e8962e; color: #0f2340;
    font-size: 26px; font-weight: 900; display: grid; place-items: center;
  }}
  .close {{ margin-top: auto; padding-top: 40px; font-size: 34px; font-weight: 700; line-height: 1.6; color: #fff; }}
  .close em {{ font-style: normal; color: #e8962e; }}
  footer {{
    margin-top: 48px; padding-top: 32px; border-top: 2px solid rgba(255,255,255,0.18);
    display: flex; justify-content: space-between; align-items: center; font-size: 26px; color: rgba(255,255,255,0.75);
  }}
  footer b {{ font-size: 34px; font-weight: 900; letter-spacing: 0.08em; color: #fff; }}
</style></head><body>
  <div class="label">{label}</div>
  <h1>{title}</h1>
  <ul>{items}</ul>
  <p class="close">{close}</p>
  <footer><b>AXION SALES</b><span>名古屋の建設・不動産専門 営業代行</span></footer>
</body></html>"""


def _rich(text: str) -> str:
    """エスケープした上で \\n を改行、**強調** を色付きにする。"""
    s = html.escape(text.replace("\\n", "\n")).replace("\n", "<br>")
    return re.sub(r"\*\*(.+?)\*\*", r"<em>\1</em>", s)


def card_html(card: dict) -> str:
    items = [i for i in card.get("項目", "").split("|") if i.strip()]
    lines = sum(len(i.split("\\n")) for i in items)
    title_lines = card.get("見出し", "").split("\\n")
    return TEMPLATE.format(
        label=html.escape(card.get("ラベル", "")),
        title=_rich(card.get("見出し", "")),
        title_size=72 if max(len(t.replace("**", "")) for t in title_lines) <= 12 else 60,
        items="".join(f'<li data-n="{n}">{_rich(i)}</li>' for n, i in enumerate(items, 1)),
        item_size=38 if lines <= 5 else 32 if lines <= 6 else 28,
        close=_rich(card.get("結び", "")),
    )


def image_url(post_id: str) -> str:
    return f"{config.IMAGE_URL_BASE}/{post_id}.jpg"


def render(cards: list[dict], log=print) -> list[str]:
    from playwright.sync_api import sync_playwright
    config.IMAGE_DIR.mkdir(exist_ok=True)
    made = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1080, "height": 1350})
        for card in cards:
            page.set_content(card_html(card), wait_until="networkidle")
            page.evaluate("document.fonts.ready")
            path = config.IMAGE_DIR / f"{card['ID']}.jpg"
            page.screenshot(path=str(path), type="jpeg", quality=90)
            made.append(card["ID"])
            log(f"生成 {path.relative_to(config.BASE_DIR)}")
        browser.close()
    return made


def fill_image_urls(ids: list[str]) -> int:
    """posts.csv の Instagram 投稿のうち、画像URLが空で画像を生成した ID に URL を入れる。"""
    posts, n = load_posts(), 0
    for p in posts:
        if p.get("媒体") == "instagram" and not p.get("画像URL") and p.get("ID") in ids:
            p["画像URL"] = image_url(p["ID"])
            n += 1
    if n:
        with open(config.POSTS_CSV, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=POST_FIELDS, lineterminator="\n")
            w.writeheader()
            w.writerows({k: p.get(k, "") for k in POST_FIELDS} for p in posts)
    return n


def load_cards() -> list[dict]:
    return read_csv(config.CARDS_CSV)
