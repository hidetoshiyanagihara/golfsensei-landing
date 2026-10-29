"""毎朝の「フォローする相手リスト」を作る（フォローそのものは柳原さんが手で押す。自動フォローは規約違反になるため）。

営業代行を必要としていそうな会社・人（中小企業向けSaaSの社長・営業責任者、資金調達や営業募集を発表した会社の公式など）を
Claude の Web検索で探し、プロフィールのリンク・どんな人か・今フォローする理由・返信するときのひとこと案をまとめる。

  python -m autopost.follow     follow/日付.md と follow/latest.md を書く（一度載せた相手は history.json で除く）
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import anthropic

ROOT = Path(__file__).resolve().parent.parent
FOLLOW = ROOT / "follow"
HISTORY = FOLLOW / "history.json"
MODEL = os.environ.get("FOLLOW_MODEL") or "claude-opus-5-5"
# 安全のための自動判定で断られたときは、Anthropic が推奨する別モデルで自動的にやり直す
FALLBACK = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
TOOLS = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 8},
         {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 4}]
WANT = {"x": 7, "instagram": 3}
REPLY_MAX = 70
HANDLE_RE = {"x": re.compile(r"^[A-Za-z0-9_]{1,15}$"), "instagram": re.compile(r"^[A-Za-z0-9_.]{1,30}$")}
PROFILE_URL = {"x": "https://x.com/{}", "instagram": "https://www.instagram.com/{}/"}
NOT_PROFILES = {"home", "search", "explore", "i", "intent", "share", "hashtag", "p", "reel", "reels", "stories",
                "accounts", "about", "settings", "login"}

SYSTEM = """あなたは、営業代行「AXION SALES」代表・柳原秀俊のSNSのリサーチ担当です。
柳原さんが X と Instagram で「手で」フォローする相手を選びます。目的は、営業代行を必要としていそうな会社や人に知ってもらうことです。

選ぶ相手（優先順）
1. 中小企業向けSaaS（社員10〜100名ほど）の社長・創業者・取締役で、仕事の発信をしている人
2. SaaS企業の営業責任者・インサイドセールスの責任者
3. 直近に資金調達・営業職の募集・新サービスの発表をした、中小企業向けSaaSの公式アカウント

選ばない相手
- 上場企業・大企業の公式アカウント、フォロワー10万人を超える有名人
- 営業代行・営業支援・テレアポ代行など同業、情報商材・副業の勧誘、仕事の発信をしていない個人のアカウント

ルール
- Web検索で、x.com または instagram.com のプロフィールURLを実際に確認できた相手だけを出す。アカウント名（@以降）を推測で作らない
- 「今フォローする理由」は、出典（ニュース・求人・公式サイトなど）のURLで確認できた事実を1行で
- 「返信するときのひとこと案」は、その人の最近の動き（資金調達・新サービス・採用など）に触れる、売り込みのない短い一言。確認できた事実だけを使う"""

SCHEMA = {
    "type": "object",
    "properties": {
        "accounts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["x", "instagram"]},
                    "handle": {"type": "string", "description": "@を除いたアカウント名"},
                    "name": {"type": "string", "description": "表示名"},
                    "who": {"type": "string", "description": "どんな会社・人か（会社名と役職）"},
                    "why_now": {"type": "string", "description": "今フォローする理由（確認できた事実）"},
                    "source": {"type": "string", "description": "理由の出典URL"},
                    "reply_idea": {"type": "string", "description": "返信するときのひとこと案"},
                },
                "required": ["platform", "handle", "name", "who", "why_now", "source", "reply_idea"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["accounts"],
    "additionalProperties": False,
}


def today():
    return datetime.now(ZoneInfo("Asia/Tokyo"))


def load_history() -> list[str]:
    return json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else []


def key(platform: str, handle: str) -> str:
    return f"{platform}:{handle.lstrip('@').lower()}"


def _ask(client, user: str, tools=None, schema=None, effort="medium") -> str:
    """Web検索が長引いて一時停止（pause_turn）したら続きから再開する"""
    messages = [{"role": "user", "content": user}]
    output_config = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs = dict(model=MODEL, max_tokens=16000, system=SYSTEM, output_config=output_config, **FALLBACK)
    if tools:
        kwargs["tools"] = tools
    for _ in range(5):
        resp = client.beta.messages.create(messages=messages, **kwargs)
        if resp.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": resp.content}]
    if resp.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"AIの回答が得られませんでした（{resp.stop_reason}）")
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def find_accounts(client, history: list[str]) -> list[dict]:
    exclude = "、".join(history[-400:]) or "（なし）"
    notes = _ask(client, f"X から {WANT['x']}人、Instagram から {WANT['instagram']}人を探してください"
                         f"（少し多めに候補を挙げてかまいません）。次の相手はすでに載せたので除いてください：{exclude}\n\n"
                         "相手ごとに、媒体・プロフィールURL・表示名・どんな会社/人か・今フォローする理由と出典URL・返信するときのひとこと案を"
                         "箇条書きでまとめてください。", tools=TOOLS)
    data = json.loads(_ask(client, "次のメモを指定の形式に写してください。メモにない相手や事実は足さない。\n\n" + notes,
                           schema=SCHEMA, effort="low"))
    return data["accounts"]


def clean(accounts: list[dict], history: list[str]) -> dict[str, list[dict]]:
    """アカウント名として正しいもの・まだ載せていないものだけを、媒体ごとに決まった人数まで残す"""
    seen = set(history)
    out = {p: [] for p in WANT}
    for a in accounts:
        p, h = a["platform"], a["handle"].strip().lstrip("@").split("/")[-1].split("?")[0]
        if not HANDLE_RE[p].match(h) or h.lower() in NOT_PROFILES or key(p, h) in seen:
            continue
        if len(out[p]) >= WANT[p]:
            continue
        seen.add(key(p, h))
        reply = a["reply_idea"].strip()
        out[p].append({**a, "handle": h, "url": PROFILE_URL[p].format(h),
                       "reply_idea": reply if len(reply) <= REPLY_MAX else ""})
    return out


def to_markdown(d, picked: dict[str, list[dict]]) -> str:
    lines = [f"# フォローする相手（{d:%m/%d}）", "",
             "リンクを押してプロフィールを開き、「フォロー」を押してください。"
             "最近の投稿に返信やいいねをすると、さらに覚えてもらいやすくなります。", ""]
    titles = {"x": "X", "instagram": "Instagram"}
    for p, accounts in picked.items():
        if not accounts:
            continue
        lines += [f"## {titles[p]}", ""]
        for i, a in enumerate(accounts, 1):
            lines += [f"{i}. **{a['name']}**（{a['who']}）", f"   {a['url']}",
                      f"   - 今フォローする理由：{a['why_now']}" + (f"（[出典]({a['source']})）" if a["source"].startswith("http") else "")]
            if a["reply_idea"]:
                lines.append(f"   - 返信するときのひとこと案：「{a['reply_idea']}」")
            lines.append("")
    if not any(picked.values()):
        lines += ["今日は条件に合う新しい相手が見つかりませんでした。", ""]
    return "\n".join(lines)


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY が未設定です")
    d = today()
    FOLLOW.mkdir(exist_ok=True)
    history = load_history()
    picked = clean(find_accounts(anthropic.Anthropic(max_retries=3), history), history)
    md = to_markdown(d, picked)
    (FOLLOW / f"{d:%Y-%m-%d}.md").write_text(md, encoding="utf-8")
    (FOLLOW / "latest.md").write_text(md, encoding="utf-8")
    history += [key(p, a["handle"]) for p, accounts in picked.items() for a in accounts]
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"フォローする相手：X {len(picked['x'])}人 / Instagram {len(picked['instagram'])}人")


if __name__ == "__main__":
    main()
