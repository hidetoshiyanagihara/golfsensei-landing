"""毎朝の「フォローする相手リスト」を作る（フォローそのものは柳原さんが手で押す。自動フォローは規約違反になるため）。

営業代行を必要としていそうな会社・人（中小企業向けSaaSの社長・営業責任者、資金調達や営業募集を発表した会社の公式など）を
Claude の Web検索で探し、プロフィールのリンク・どんな人か・今フォローする理由・返信するときのひとこと案をまとめる。

1. 会社を探す   ：直近に資金調達・営業の募集・新サービスの発表をした中小企業向けSaaSを数社
2. アカウントを探す：1社ずつ、会社の公式と代表・営業責任者の X / Instagram を検索する。
                    検索結果に実際に出てきたプロフィールURLだけを候補にする（アカウント名をAIに作らせない）

  python -m autopost.follow     follow/日付.md と follow/latest.md を書く（一度載せた相手・会社は history.json で除く）
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
COMPANY_TOOLS = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 10}]
PROFILE_TOOLS = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 4}]
COMPANIES = 6
WANT = {"x": 7, "instagram": 3}
REPLY_MAX = 70
HANDLE_RE = {"x": re.compile(r"^[A-Za-z0-9_]{1,15}$"), "instagram": re.compile(r"^[A-Za-z0-9_.]{1,30}$")}
PROFILE_URL = {"x": "https://x.com/{}", "instagram": "https://www.instagram.com/{}/"}
PROFILE_IN_URL = {
    "x": re.compile(r"https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})(?:[/?#]|$)"),
    "instagram": re.compile(r"https?://(?:www\.)?instagram\.com/([A-Za-z0-9_.]{1,30})/?(?:[?#]|$)"),
}
NOT_PROFILES = {"home", "search", "explore", "i", "intent", "share", "hashtag", "p", "reel", "reels", "stories",
                "accounts", "about", "settings", "login", "signup", "privacy", "tos", "help", "notifications"}

SYSTEM = """あなたは、営業代行「AXION SALES」代表・柳原秀俊のSNSのリサーチ担当です。
柳原さんが X と Instagram で「手で」フォローする相手を選びます。目的は、営業代行を必要としていそうな会社や人に知ってもらうことです。

選ぶ相手
- 中小企業向けSaaS（社員10〜100名ほど）の社長・創業者・取締役、営業責任者・インサイドセールスの責任者
- 直近に資金調達・営業職の募集・新サービスの発表をした、中小企業向けSaaSの公式アカウント

選ばない相手
- 上場企業・大企業とその子会社、フォロワー10万人を超える有名人
- 営業代行・営業支援・テレアポ代行など同業、情報商材・副業の勧誘、メディアのアカウント

確認できた事実だけを書き、推測で埋めない。"""

COMPANY_SCHEMA = {
    "type": "object",
    "properties": {
        "companies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "company": {"type": "string", "description": "会社名"},
                    "product": {"type": "string", "description": "サービス名と、誰向けか"},
                    "people": {"type": "string", "description": "代表・営業責任者の名前（わかれば。なければ空）"},
                    "why_now": {"type": "string", "description": "今フォローする理由（資金調達・営業の募集・新サービスなど、確認できた事実）"},
                    "source": {"type": "string", "description": "理由の出典URL"},
                },
                "required": ["company", "product", "people", "why_now", "source"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["companies"],
    "additionalProperties": False,
}


def today():
    return datetime.now(ZoneInfo("Asia/Tokyo"))


def load_history() -> list[str]:
    return json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else []


def key(platform: str, handle: str) -> str:
    return f"{platform}:{handle.lstrip('@').lower()}"


def _ask(client, user: str, tools=None, schema=None, effort="medium") -> tuple[str, list[tuple[str, str]]]:
    """回答の文章と、Web検索の結果に出てきた（URL, タイトル）の一覧を返す。検索が長引いて一時停止（pause_turn）したら再開する"""
    messages = [{"role": "user", "content": user}]
    output_config = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs = dict(model=MODEL, max_tokens=16000, system=SYSTEM, output_config=output_config, **FALLBACK)
    if tools:
        kwargs["tools"] = tools
    urls = []
    for _ in range(5):
        resp = client.beta.messages.create(messages=messages, **kwargs)
        for block in resp.content:
            if block.type == "web_search_tool_result" and isinstance(block.content, list):  # 失敗時は一覧ではなくエラー
                urls += [(r.url, getattr(r, "title", "") or "") for r in block.content if getattr(r, "url", None)]
        if resp.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": resp.content}]
    if resp.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"AIの回答が得られませんでした（{resp.stop_reason}）")
    return "".join(b.text for b in resp.content if b.type == "text").strip(), urls


def profiles_in(results: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
    """検索結果から、X・Instagram のプロフィールだけを {(媒体, アカウント名): 検索結果のタイトル} で取り出す"""
    out = {}
    for url, title in results:
        for p, rx in PROFILE_IN_URL.items():
            m = rx.match(url)
            if m and m.group(1).lower() not in NOT_PROFILES:
                out.setdefault((p, m.group(1)), title)
    return out


def find_companies(client, history: list[str]) -> list[dict]:
    done = "、".join(h[8:] for h in history if h.startswith("company:")) or "（なし）"
    notes, _ = _ask(client, f"直近2か月以内に、資金調達・営業やインサイドセールスの募集・新サービスの発表をした、会社や店舗向けの国内SaaS・ITサービスを"
                            f"{COMPANIES}社探してください。会社ごとに、サービスと誰向けか・代表や営業責任者の名前・今フォローする理由と出典URLを"
                            f"箇条書きでまとめてください。資金調達まとめ記事・PR TIMES・求人サイトなど、複数の会社が載っているページから探すと早いです。"
                            f"深追いせず、見つかった分だけでかまいません。次の会社はすでに調べたので除く：{done}", tools=COMPANY_TOOLS)
    print(f"会社探しのメモ：\n{notes[:2000]}\n---")
    data, _ = _ask(client, "次のメモを指定の形式に写してください。メモにない会社や事実は足さない。\n\n" + notes,
                   schema=COMPANY_SCHEMA, effort="low")
    return json.loads(data)["companies"]


def find_profiles(client, company: dict) -> list[dict]:
    """1社分。検索結果に出てきたプロフィールURLの中から、その会社・人のものだけを選ばせる"""
    _, results = _ask(client, f"{company['company']}（{company['product']}）の公式アカウントと、代表・営業責任者"
                           f"（{company['people'] or '名前は未確認'}）の X と Instagram を Web検索で探してください。"
                           "「会社名 X」「会社名 instagram」「代表の名前 X」のように検索してください。", tools=PROFILE_TOOLS)
    found = profiles_in(results)
    print(f"  {company['company']}：検索結果 {len(results)}件、うちプロフィール {len(found)}件")
    if not found:
        return []
    handles = [f"{p}:{h}" for p, h in found]
    listing = "\n".join(f"- {p}:{h}（検索結果のタイトル：{t or 'なし'}）" for (p, h), t in found.items())
    schema = {
        "type": "object",
        "properties": {"accounts": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "account": {"type": "string", "enum": handles},
                "name": {"type": "string", "description": "表示名（会社名または人の名前）"},
                "who": {"type": "string", "description": "会社名と役職（公式なら「公式」）"},
                "reply_idea": {"type": "string", "description": "最近の動きに触れる、売り込みのない短い一言"},
            },
            "required": ["account", "name", "who", "reply_idea"],
            "additionalProperties": False,
        }}},
        "required": ["accounts"],
        "additionalProperties": False,
    }
    data, _ = _ask(client, f"会社：{company['company']}（{company['product']}）\n代表・営業責任者：{company['people'] or '未確認'}\n"
                           f"最近の動き：{company['why_now']}\n\n検索結果に出てきたアカウント：\n{listing}\n\n"
                           "この中から、この会社の公式アカウントと、この会社の代表・営業責任者本人のアカウントを選んでください。"
                           "タイトルやアカウント名に会社名・サービス名・本人の名前が入っていれば、本人のものと判断してよい。"
                           "別の会社・同姓同名の別人・メディア・ファンのアカウントは選ばない。",
                   schema=schema, effort="low")
    out = []
    for a in json.loads(data)["accounts"]:
        p, h = a["account"].split(":", 1)
        out.append({"platform": p, "handle": h, "name": a["name"], "who": a["who"], "company": company["company"],
                    "why_now": company["why_now"], "source": company["source"], "reply_idea": a["reply_idea"]})
    return out


def clean(accounts: list[dict], history: list[str]) -> dict[str, list[dict]]:
    """アカウント名として正しいもの・まだ載せていないものだけを、媒体ごとに決まった人数まで残す"""
    seen = set(history)
    out = {p: [] for p in WANT}
    for a in accounts:
        p, h = a["platform"], a["handle"].strip().lstrip("@")
        if not HANDLE_RE[p].match(h) or h.lower() in NOT_PROFILES or key(p, h) in seen or len(out[p]) >= WANT[p]:
            continue
        seen.add(key(p, h))
        reply = a["reply_idea"].strip()
        out[p].append({**a, "handle": h, "url": PROFILE_URL[p].format(h),
                       "reply_idea": reply if len(reply) <= REPLY_MAX else ""})
    return out


def collect(client, history: list[str]) -> tuple[dict[str, list[dict]], list[str]]:
    """会社を探し、1社ずつアカウントを探す。決まった人数がそろったら止める。調べた会社名も返す"""
    companies = find_companies(client, history)
    print(f"会社 {len(companies)}社")
    accounts, checked = [], []
    for c in companies:
        try:
            found = find_profiles(client, c)
        except Exception as e:  # 1社失敗しても次へ
            print(f"  {c['company']}：失敗（{str(e)[:80]}）")
            continue
        checked.append(c["company"])
        accounts += found
        print(f"  {c['company']}：{len(found)}アカウント")
        picked = clean(accounts, history)
        if all(len(picked[p]) >= n for p, n in WANT.items()):
            break
    return clean(accounts, history), checked


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
    picked, checked = collect(anthropic.Anthropic(max_retries=3), history)
    md = to_markdown(d, picked)
    (FOLLOW / f"{d:%Y-%m-%d}.md").write_text(md, encoding="utf-8")
    (FOLLOW / "latest.md").write_text(md, encoding="utf-8")
    history += [key(p, a["handle"]) for p, accounts in picked.items() for a in accounts]
    history += [f"company:{c}" for c in checked]
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"フォローする相手：X {len(picked['x'])}人 / Instagram {len(picked['instagram'])}人")


if __name__ == "__main__":
    main()
