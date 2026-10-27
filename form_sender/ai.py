"""【SaaS向け】送り先の発見・1社ごとの事前調査・営業文づくり（Claude API ＋ Web検索）。

1. discover  : 条件に合う国内SaaS企業をWeb検索で探す
2. research  : 1社ずつ、公式サイトとWeb検索で「何を誰に売っているか・会社の段階・営業体制・競合」を調べる
3. write     : 調査メモから、送るべきか判断し、その会社向けの営業文を書く

事実は調査で出典（URL）を確認できたものだけを使う。実績・料金・成果保証・他社の悪口は書かない。
"""
import json
import os
import re

import anthropic

MODEL = os.environ.get("FORM_AI_MODEL") or "claude-opus-5-5"
# 安全のための自動判定で断られたときは、Anthropic が推奨する別モデルで自動的にやり直す
FALLBACK = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
SEARCH_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 5},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 3},
]
MAX_CONTINUE = 4

BODY_MIN, BODY_MAX = 150, 480
SUBJECT_MAX = 40
# 実績・料金・保証・誇大表現は、確定するまで営業文に書かない（prompt.md と同じ方針）
BANNED = ["絶対", "必ず", "確実", "保証", "実績", "料金", "費用", "円", "成果報酬", "支援社数", "導入社数",
          "No.1", "ナンバーワン", "業界最安", "http", "www."]

ABOUT_AXION = """AXION SALES（アクシオンセールス）について（使ってよい事実はこれだけ）
- 代表 柳原秀俊。営業代行。全国対応、打ち合わせはオンライン
- やること：新規開拓のアポ獲得まで（見込み客リストの作成 → 問い合わせフォーム営業・電話 → 商談日程の確定）。商談と契約は相手の会社が行う
- やり方：AIと自動化で「量」をこなし、人が「トークと質」を磨く。誰に・どんな文面で・何件当たり・どんな反応だったかを全部共有する（やり方を隠さない）
- 無料オファー：相手のサービスが合いそうな会社のリスト20件を、無料で作って送る
- 料金・成果保証は未確定。自社の実績・お客様の声・数字はまだない"""


class AIError(RuntimeError):
    pass


_client = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=3)
    return _client


def _ask(system: str, user: str, tools=None, schema=None, effort="medium") -> str:
    """1回分の問い合わせ。Web検索が長引いて一時停止（pause_turn）したら続きから再開する"""
    messages = [{"role": "user", "content": user}]
    output_config = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs = dict(model=MODEL, max_tokens=16000, system=system, output_config=output_config, **FALLBACK)
    if tools:
        kwargs["tools"] = tools
    for _ in range(MAX_CONTINUE + 1):
        resp = client().beta.messages.create(messages=messages, **kwargs)
        if resp.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": resp.content}]
    if resp.stop_reason == "refusal":
        raise AIError("AIが回答を控えました")
    if resp.stop_reason == "max_tokens":
        raise AIError("AIの回答が長すぎて途中で切れました")
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        raise AIError(f"AIの回答が空でした（{resp.stop_reason}）")
    return text


def _json(system: str, user: str, schema: dict, effort="medium") -> dict:
    return json.loads(_ask(system, user, schema=schema, effort=effort))


# ---------------------------------------------------------------- 1. 送り先を探す
FOCUSES = [
    "直近3か月以内に資金調達（シード〜シリーズB）を発表した、中小企業向けのSaaS",
    "インサイドセールス・フィールドセールス・営業を求人で募集している、中小企業向けのSaaS",
    "建設・不動産・介護・医療・飲食・物流・士業など、特定の業界向けの業界特化SaaS（バーティカルSaaS）",
    "勤怠・労務・会計・請求・経費・人事など、中小企業向けのバックオフィスSaaS",
    "予約・顧客管理・店舗運営・EC・マーケティングなど、中小企業や店舗向けのSaaS",
    "直近3か月以内に新しいサービスや新プランを発表した、中小企業向けのSaaS",
]

DISCOVER_SYSTEM = """あなたはBtoB営業のリサーチ担当です。営業代行（アポ獲得の代行）を必要としていそうな日本のSaaS企業を、Web検索で探します。

条件（すべて満たす会社だけ）
- 日本の会社で、自社でSaaS（クラウドサービス）を開発・提供している
- 主なお客さんが中小企業・店舗・中堅企業（大企業だけに売る会社は除く）
- 社員数がおおむね10〜100名、または資金調達の段階がシード〜シリーズB程度（上場企業・大企業の子会社は除く）
- 営業代行・営業支援・テレアポ代行・インサイドセールス代行・営業コンサル・人材派遣の会社は除く（同業のため）
- 公式サイトがある

候補ごとに、公式サイトのトップURL、主なサービス名、誰向けか、「今まさに営業を強化したい」と言える根拠（資金調達・営業の求人・新サービス発表など）と、その出典URLを確認すること。確認できないことは書かない。"""

DISCOVER_SCHEMA = {
    "type": "object",
    "properties": {
        "companies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "正式な会社名（株式会社〜）"},
                    "url": {"type": "string", "description": "公式サイトのトップURL"},
                    "product": {"type": "string"},
                    "customers": {"type": "string"},
                    "signal": {"type": "string", "description": "営業を強化したい根拠（なければ空）"},
                    "source": {"type": "string", "description": "根拠の出典URL（なければ空）"},
                },
                "required": ["name", "url", "product", "customers", "signal", "source"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["companies"],
    "additionalProperties": False,
}


def discover(focus: str, exclude_names: list[str], want: int = 15) -> list[dict]:
    exclude = "、".join(exclude_names[-300:]) or "（なし）"
    notes = _ask(
        DISCOVER_SYSTEM,
        f"今回の切り口：{focus}\n\n条件に合う会社を{want}社探してください。次の会社はすでに調べたので除いてください：{exclude}\n\n"
        "見つけた会社ごとに、会社名・公式サイトURL・サービス名・誰向けか・営業強化の根拠・出典URLを箇条書きでまとめてください。",
        tools=SEARCH_TOOLS,
    )
    data = _json("箇条書きのメモを、指定の形式に写してください。メモにないことは足さない。URLはメモにあるものだけ。",
                 notes, DISCOVER_SCHEMA, effort="low")
    out = []
    for c in data["companies"]:
        url = c["url"].strip()
        if re.match(r"https?://", url) and c["name"].strip():
            out.append({**c, "name": c["name"].strip(), "url": url})
    return out


# ---------------------------------------------------------------- 2. 1社ごとの事前調査
RESEARCH_SYSTEM = """あなたはBtoB営業のリサーチ担当です。営業代行のAXION SALESが、ある日本のSaaS企業に問い合わせフォームから提案を送る前に、その会社を調べます。
公式サイトの本文（ユーザーが渡します）と、Web検索・Webページ取得で調べ、次の5つを日本語のメモにまとめてください。

1. 何を・誰に売っているか（サービス名、主なお客さんの業種・規模、料金の形態がわかれば）
2. 会社の段階（設立年、社員数、資金調達の有無と時期、上場しているか）
3. 営業・集客の体制のてがかり（営業やインサイドセールスの求人、資料請求・無料トライアル・セミナーなどの集客の入口、導入事例の数）
4. 競合（同じ分野で比べられる主なサービス名と、公開情報からわかるその売り方や強み）
5. この会社にどんな営業代行が合いそうか（誰に向けたアポを、どう作ると良さそうか）

ルール
- 1〜4は、確認できた事実だけを書き、1項目ごとに出典URLを書く。確認できないことは「不明」と書く。推測で埋めない
- 5だけは、1〜4をもとにした考えでよい（考えであることがわかるように書く）
- 他社を悪く言わない"""


def research(name: str, url: str, site_text: str) -> str:
    return _ask(
        RESEARCH_SYSTEM,
        f"会社名：{name}\n公式サイト：{url}\n\n公式サイトの本文（抜粋）：\n{site_text[:8000]}",
        tools=SEARCH_TOOLS,
    )


# ---------------------------------------------------------------- 3. 送るか判断して営業文を書く
WRITE_SYSTEM = f"""あなたは営業代行「AXION SALES」代表・柳原秀俊の名前で、SaaS企業の問い合わせフォームに送る営業文を書きます。
目的は、読んだ担当者に「うちのことをちゃんと調べてくれている」「この人に一度話を聞いてみたい」と思ってもらうことです。

{ABOUT_AXION}

まず、調査メモから送るべき会社か判断する。次のどれかなら fit を "skip" にして理由を書く（営業文は空でよい）
- SaaSを自社で提供していない／主なお客さんが個人（BtoC）／大企業だけに売っている
- 上場企業、大企業やその子会社、社員数がおおむね300名を超える
- 営業代行・営業支援・テレアポ・インサイドセールス代行・営業コンサル・人材派遣の会社（同業）
- 何を誰に売っているかがわからず、具体的な文面が書けない

送る場合の営業文（body）のルール
- 宛名・あいさつ・自己紹介・無料リストの案内・連絡先・結びは、あとから決まった文で付け足すので書かない。本文の中身だけを書く
- {BODY_MIN}〜{BODY_MAX}字、2〜3段落。ですます調。改行は段落の間だけ
- 1段落目：調べてわかった、その会社ならではの具体（サービス名、誰向けか、最近の動きなど）を1〜2点。「拝見しました」から始めない
- 2段落目：その会社の状況から考えて、どんなアポ獲得が役に立ちそうかを具体的に（どんな業種・規模の会社に、どう当たるか）。競合に触れる場合は、調査メモに出典のある事実だけを、相手を持ち上げる形で使う（例：同じ分野に〇〇や〇〇がある中で、△△が強み）。他社を悪く言わない
- 3段落目（任意）：AXION SALESのやり方（量はAIと自動化、質は人、やり方を全部共有）が、その会社の状況にどう合うかを1〜2文
- 調査メモにない事実を書かない。推測は「〜ではないかと考えました」のように推測とわかる形で
- 実績・お客様の声・数字の実績・料金・成果保証・URLは書かない。「絶対」「必ず」「確実」などの言い切りや誇大表現は使わない
- 件名（subject）は{SUBJECT_MAX}字以内。相手のサービス名かお客さんの業種を入れ、何の連絡かがわかるように（例：「〇〇の中小企業向け商談づくりについて」）

analysis の各欄は、社内で後から見返すための記録。調査メモの事実を短く写す"""

WRITE_SCHEMA = {
    "type": "object",
    "properties": {
        "fit": {"type": "string", "enum": ["send", "skip"]},
        "skip_reason": {"type": "string"},
        "analysis": {
            "type": "object",
            "properties": {
                "product": {"type": "string", "description": "何を誰に売っているか"},
                "stage": {"type": "string", "description": "会社の段階（社員数・資金調達など）"},
                "sales_signals": {"type": "string", "description": "営業・集客体制のてがかり"},
                "competitors": {"type": "string", "description": "主な競合と、その売り方・強み（出典つき）"},
                "needed_support": {"type": "string", "description": "どんな営業代行が合うか"},
                "appeal": {"type": "string", "description": "AXION SALESとして何をアピールするか"},
            },
            "required": ["product", "stage", "sales_signals", "competitors", "needed_support", "appeal"],
            "additionalProperties": False,
        },
        "subject": {"type": "string"},
        "body": {"type": "string"},
    },
    "required": ["fit", "skip_reason", "analysis", "subject", "body"],
    "additionalProperties": False,
}


def check_letter(subject: str, body: str) -> list[str]:
    errs = []
    n = len(body.replace("\n", ""))
    if not BODY_MIN <= n <= BODY_MAX:
        errs.append(f"本文が{n}字（{BODY_MIN}〜{BODY_MAX}字にする）")
    if not 0 < len(subject) <= SUBJECT_MAX:
        errs.append(f"件名が{len(subject)}字（1〜{SUBJECT_MAX}字にする）")
    hit = [w for w in BANNED if w in subject + body]
    if hit:
        errs.append(f"使わない言葉が入っている：{'、'.join(hit)}")
    return errs


def write(name: str, notes: str) -> dict:
    """送るか判断し、送る場合は件名と本文を作る。ルール違反なら理由を伝えて書き直させる（最大3回）"""
    user = f"会社名：{name}\n\n調査メモ：\n{notes}"
    last_errs = []
    for _ in range(3):
        prompt = user if not last_errs else user + "\n\n前回の文面は次の点がルール違反でした。直してください：\n- " + "\n- ".join(last_errs)
        data = _json(WRITE_SYSTEM, prompt, WRITE_SCHEMA)
        if data["fit"] == "skip":
            return data
        data["subject"] = data["subject"].strip()
        data["body"] = data["body"].strip()
        last_errs = check_letter(data["subject"], data["body"])
        if not last_errs:
            return data
    raise AIError("営業文がルールを満たさない：" + " / ".join(last_errs))
