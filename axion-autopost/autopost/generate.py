"""prompt.md をシステムプロンプトにして、その日のX・Instagram投稿をClaudeで生成する。"""
import json
import os
import re

import anthropic

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")

REQUIRED_KEYS = ["theme", "target", "x_post", "instagram_image_title", "instagram_image_sub", "instagram_caption"]
CHECK_KEYS = ["hook", "target", "concrete", "insight", "reason_to_contact"]
X_MAX_CHARS = 140
# prompt.md「7. 禁止事項」のうち、機械的に見分けられるもの
BANNED = ["絶対", "必ず", "誰でも", "最短で", "いかがでしたか", "について解説します", "お気軽にご相談ください"]

WEEKDAYS = "月火水木金土日"


def build_system_prompt(template: str, today, recent_posts: str, memo: str) -> str:
    """prompt.md の {{today}} {{weekday}} {{recent_posts}} {{memo}} だけを差し込む（他の {{ }} は指示文なので残す）"""
    values = {
        "today": today.strftime("%Y年%m月%d日"),
        "weekday": WEEKDAYS[today.weekday()] + "曜日",
        "recent_posts": recent_posts or "（まだなし）",
        "memo": memo.strip() or "（なし）",
    }
    for key, value in values.items():
        template = template.replace("{{" + key + "}}", value)
    return template


def _extract_json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"AIの出力からJSONが見つかりません:\n{text}")
    return json.loads(text[start : end + 1])


def check_post(data: dict) -> dict:
    """出力を検査し、投稿に使う形に整える。問題があれば ValueError（作り直し）"""
    missing = [k for k in REQUIRED_KEYS if not str(data.get(k, "")).strip()]
    if missing:
        raise ValueError(f"項目が足りません: {missing}")
    x, caption = str(data["x_post"]).strip(), str(data["instagram_caption"]).strip()
    if len(x) > X_MAX_CHARS:
        raise ValueError(f"Xの本文が{len(x)}字（{X_MAX_CHARS}字以内）")
    if re.search(r"https?://", x + caption):
        raise ValueError("URLが含まれています")
    banned = [w for w in BANNED if w in x + caption]
    if banned:
        raise ValueError(f"禁止表現が含まれています: {banned}")
    scores = data.get("self_check") or {}
    low = [k for k in CHECK_KEYS if not isinstance(scores.get(k), (int, float)) or scores[k] <= 3]
    if low:
        raise ValueError(f"自己チェックが3点以下: {low}")
    return {
        "theme": str(data["theme"]).strip(),
        "target": str(data["target"]).strip(),
        "image_title": str(data["instagram_image_title"]).strip(),
        "image_sub": str(data["instagram_image_sub"]).strip(),
        "x": x,
        "x_char_count": len(x),
        "instagram": caption,
        "self_check": {k: scores[k] for k in CHECK_KEYS},
    }


def generate_post(template: str, recent_posts: str, memo: str, today) -> dict:
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY を環境変数から読む
    system = build_system_prompt(template, today, recent_posts, memo)
    request = "今日の投稿を作ってください。"
    last_error = None
    for _ in range(3):
        msg = client.messages.create(
            model=MODEL,
            max_tokens=3000,
            system=system,
            messages=[{"role": "user", "content": request}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        try:
            return check_post(_extract_json(text))
        except ValueError as e:  # json.JSONDecodeError も ValueError
            last_error = e
            request = f"今日の投稿を作ってください。前回の出力は「{e}」のため使えませんでした。直して出力してください。"
    raise RuntimeError(f"投稿文の生成に3回失敗しました: {last_error}")
