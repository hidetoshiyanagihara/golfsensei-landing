"""brand.md を読んで、その日の投稿文（3SNS分）をClaudeで生成する。"""
import json
import os
import re

import anthropic

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")

REQUIRED_KEYS = ["theme", "image_title", "image_sub", "x", "instagram", "linkedin"]

PROMPT = """あなたは「AXION SALES」のSNS担当です。下の【発信設定】に厳密に従って、今日の投稿を1本作ってください。

【今日】{today}（{weekday}曜日）

【発信設定】
{brand}

【最近使ったテーマ（これらと被らないこと）】
{recent}

【出力】
次のキーを持つJSONだけを出力してください。前置きやコードブロック記号は不要です。
- "theme": 今日のテーマ（全角20字以内）
- "image_title": Instagram画像に大きく載せる見出し（全角18字以内、改行なし）
- "image_sub": 画像の補足一文（全角40字以内）
- "x": X用の本文（全角120字以内。URL禁止。ハッシュタグは0〜2個）
- "instagram": Instagramキャプション（300〜600字。読みやすく改行を入れる。最後にハッシュタグ5個以内）
- "linkedin": LinkedIn用本文（400〜900字。経営者向けのビジネス文体。ハッシュタグ3個以内）

3つのSNSは同じテーマで、それぞれの媒体に合わせて書き分けてください。
【発信設定】の「絶対に守ること」に反する内容（作り話の実績・数字・顧客の声、成果の断定、他社批判、電話番号・住所・URL）は一切書かないこと。
"""

WEEKDAYS = "月火水木金土日"


def _extract_json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"AIの出力からJSONが見つかりません:\n{text}")
    return json.loads(text[start : end + 1])


def generate_post(brand: str, recent_themes: list[str], today) -> dict:
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY を環境変数から読む
    prompt = PROMPT.format(
        today=today.strftime("%Y年%m月%d日"),
        weekday=WEEKDAYS[today.weekday()],
        brand=brand,
        recent="\n".join(f"- {t}" for t in recent_themes) or "（まだなし）",
    )
    last_error = None
    for _ in range(3):
        msg = client.messages.create(
            model=MODEL,
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        try:
            data = _extract_json(text)
            missing = [k for k in REQUIRED_KEYS if not str(data.get(k, "")).strip()]
            if missing:
                raise ValueError(f"項目が足りません: {missing}")
            if re.search(r"https?://", data["x"] + data["instagram"] + data["linkedin"]):
                raise ValueError("URLが含まれています")
            return {k: str(data[k]).strip() for k in REQUIRED_KEYS}
        except ValueError as e:  # json.JSONDecodeError も ValueError
            last_error = e
    raise RuntimeError(f"投稿文の生成に3回失敗しました: {last_error}")
