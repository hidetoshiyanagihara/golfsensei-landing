"""prompt.md をシステムプロンプトにして、その日のX・Instagram投稿をClaudeで生成する。"""
import json
import os
import re

import anthropic

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")

REQUIRED_KEYS = ["theme", "target", "pain", "x_post", "instagram_image_title", "instagram_image_sub", "instagram_caption"]
# prompt.md「10. 投稿前の最終審査」の配点。合計70点未満は作り直す（実験の枠は除く）
SCORE_MAX = {"hook": 20, "target": 20, "retention": 15, "share": 10, "save": 10, "originality": 10, "trust": 10, "lead": 5}
PASS_SCORE = 70
HOOKS_MIN = 10   # prompt.md はフック20個を指示。少なすぎる出力だけ作り直す
EXPERIMENT = "実験・検証"
OFFER = "無料リストの案内"
# prompt.md「4. 今日の枠」。曜日で決め、金曜の無料リストの案内は4週に1回だけ（ほかの金曜は判断の材料）
SLOTS = ["本音・痛み", "有益：ノウハウ", "有益：比較", EXPERIMENT, "有益：判断の材料", "ゼロから記録", "本音・痛み（誤解に答える）"]
X_MAX_CHARS = 140
LINE_MAX_CHARS = 36   # ショートのセリフ（prompt.md は30字以内と指示。少し余裕を持たせる）
SPEAKERS = ["tsunagari", "apo"]
# prompt.md「7. 禁止事項」のうち、機械的に見分けられるもの
BANNED = ["絶対", "必ず", "誰でも", "最短で", "いかがでしたか", "について解説します", "お気軽にご相談ください",
          "清掃"]  # 代表の他の事業には触れない（2026-10-24）

WEEKDAYS = "月火水木金土日"

# prompt.md「11. 出力形式」と同じ形。structured outputs でこの形のJSONだけが返る
_STR = {"type": "string"}
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "theme": _STR, "target": _STR, "pain": _STR, "x_post": _STR, "x_char_count": {"type": "integer"},
        "instagram_image_title": _STR, "instagram_image_sub": _STR, "instagram_caption": _STR,
        "hooks": {"type": "array", "items": _STR},
        "score": {
            "type": "object",
            "properties": {k: {"type": "integer"} for k in SCORE_MAX},
            "required": list(SCORE_MAX),
            "additionalProperties": False,
        },
        "short_dialogue": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"speaker": {"type": "string", "enum": SPEAKERS}, "line": _STR},
                "required": ["speaker", "line"],
                "additionalProperties": False,
            },
        },
    },
    "required": REQUIRED_KEYS + ["x_char_count", "hooks", "score", "short_dialogue"],
    "additionalProperties": False,
}


def slot_for(today) -> str:
    """今日の枠。金曜は ISO週番号が4の倍数の週だけ「無料リストの案内」"""
    if today.weekday() == 4 and today.isocalendar()[1] % 4 == 0:
        return OFFER
    return SLOTS[today.weekday()]


def build_system_prompt(template: str, today, recent_posts: str, memo: str) -> str:
    """prompt.md の {{today}} {{weekday}} {{slot}} {{recent_posts}} {{memo}} だけを差し込む（他の {{ }} は指示文なので残す）"""
    values = {
        "today": today.strftime("%Y年%m月%d日"),
        "weekday": WEEKDAYS[today.weekday()] + "曜日",
        "slot": slot_for(today),
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


def check_post(data: dict, slot: str = "") -> dict:
    """出力を検査し、投稿に使う形に整える。問題があれば ValueError（作り直し）"""
    missing = [k for k in REQUIRED_KEYS if not str(data.get(k, "")).strip()]
    if missing:
        raise ValueError(f"項目が足りません: {missing}")
    x, caption = str(data["x_post"]).strip(), str(data["instagram_caption"]).strip()
    if len(x) > X_MAX_CHARS:
        raise ValueError(f"Xの本文が{len(x)}字（{X_MAX_CHARS}字以内）")
    if re.search(r"https?://", x + caption):
        raise ValueError("URLが含まれています")
    dialogue = [{"speaker": d.get("speaker"), "line": str(d.get("line", "")).strip()}
                for d in data.get("short_dialogue") or []]
    if not 3 <= len(dialogue) <= 8:
        raise ValueError(f"ショートの会話が{len(dialogue)}回（4〜6回）")
    long_lines = [d["line"] for d in dialogue if len(d["line"]) > LINE_MAX_CHARS or not d["line"]]
    if long_lines or any(d["speaker"] not in SPEAKERS for d in dialogue):
        raise ValueError(f"ショートのセリフが長すぎるか話し手が不正: {long_lines[:2]}")
    lines = "".join(d["line"] for d in dialogue)
    if "DM" in lines:
        raise ValueError("ショートのセリフにDMの案内がある（YouTubeにはDMがない）")
    banned = [w for w in BANNED if w in x + caption + lines]
    if banned:
        raise ValueError(f"禁止表現が含まれています: {banned}")
    hooks = [str(h).strip() for h in data.get("hooks") or [] if str(h).strip()]
    if len(hooks) < HOOKS_MIN:
        raise ValueError(f"フック案が{len(hooks)}個（20個書き出してから選ぶ）")
    scores = data.get("score") or {}
    bad = [k for k, m in SCORE_MAX.items() if not isinstance(scores.get(k), (int, float)) or not 0 <= scores[k] <= m]
    if bad:
        raise ValueError(f"最終審査の点数が配点の範囲外: {bad}")
    total = sum(scores[k] for k in SCORE_MAX)
    if total < PASS_SCORE and slot != EXPERIMENT:
        raise ValueError(f"最終審査が{total}点（{PASS_SCORE}点未満は書き直す）")
    return {
        "theme": str(data["theme"]).strip(),
        "target": str(data["target"]).strip(),
        "slot": slot,
        "pain": str(data["pain"]).strip(),
        "image_title": str(data["instagram_image_title"]).strip(),
        "image_sub": str(data["instagram_image_sub"]).strip(),
        "x": x,
        "x_char_count": len(x),
        "instagram": caption,
        "score": {k: scores[k] for k in SCORE_MAX},
        "score_total": total,
        "hooks": hooks,
        "short_dialogue": dialogue,
    }


def generate_post(template: str, recent_posts: str, memo: str, today) -> dict:
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY を環境変数から読む
    system = build_system_prompt(template, today, recent_posts, memo)
    slot = slot_for(today)
    request = "今日の投稿を作ってください。"
    last_error = None
    for _ in range(3):
        # Sonnet 5.5 は答える前に考える（thinking）。その分も含めた上限なので余裕を持たせる
        msg = client.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": request}],
            output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        try:
            if msg.stop_reason == "refusal":
                raise ValueError(f"AIが回答を断りました: {getattr(msg.stop_details, 'explanation', '')}")
            if msg.stop_reason == "max_tokens":
                raise ValueError("出力が上限に達して途中で切れました")
            return check_post(_extract_json(text), slot)
        except ValueError as e:  # json.JSONDecodeError も ValueError
            last_error = e
            request = f"今日の投稿を作ってください。前回の出力は「{e}」のため使えませんでした。直して出力してください。"
    raise RuntimeError(f"投稿文の生成に3回失敗しました: {last_error}")
