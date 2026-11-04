"""【無料版の送り先探し】PR TIMES の新着ニュースから、営業を強化しそうな会社を拾う（AIを使わない）。

- 新着RSS と、キーワード検索（資金調達・シリーズA・SaaS など）からニュースを集める。
  キーワード検索は PR TIMES の「もっと見る」と同じ仕組み（/api/search_release.php）で、過去のページまでさかのぼる
- 見出しが「資金調達・新サービス・営業強化」などの動きで、業種が「情報通信」、未上場の会社だけを残す
- 公式サイトのURL・代表者名などは、ニュースのページ下の会社情報から取る
"""
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from urllib.parse import quote

import requests

import config

BASE = "https://prtimes.jp"
RSS_URL = f"{BASE}/index.rdf"
KEYWORDS = ["資金調達", "シリーズA", "シリーズB", "プレシリーズA", "SaaS", "クラウドサービス", "提供開始",
            "営業DX", "インサイドセールス", "業務効率化", "DX", "法人向け", "BtoB", "新機能", "販売代理店", "パートナー募集"]
SEARCH_API = f"{BASE}/api/search_release.php"
SEARCH_LIMIT = 40        # 検索1ページの件数
SEARCH_MAX_PAGE = 25     # キーワードごとに、ここまでさかのぼる（40件×25ページ）
MAX_AGE_DAYS = 120       # これより古いニュースは使わない（書き出しで「拝見し」と書くため）
SLEEP = (1.0, 2.0)
MAX_PAGES_PER_RUN = 400  # 1回に開くニュースのページ数の上限（相手のサーバーに負担をかけない）

# 見出しの「動き」→ 営業文の書き出しを変える
SIGNALS = [
    ("funding", re.compile(r"資金調達|シリーズ[A-D]|プレシリーズ|シード(ラウンド)?|第三者割当|出資を受け|億円を調達")),
    ("launch", re.compile(r"提供開始|リリース|正式版|ローンチ|新機能|新サービス|新プラン|β版|ベータ版|販売開始")),
    ("sales", re.compile(r"営業|インサイドセールス|セールス|販売代理|パートナー(制度|募集|プログラム)|拡販|導入社数")),
]
# SaaS・ITサービスらしさ（業種が「情報通信」でないときの補助）
SAAS_RE = re.compile(r"SaaS|クラウド|AI|DX|アプリ|プラットフォーム|システム|ツール|ソフトウェア")
# 同業や対象外（営業代行・人材など）
EXCLUDE_RE = re.compile(r"営業代行|テレアポ|テレマーケティング|アポイント獲得|コールセンター|インサイドセールス代行|営業支援代行|人材派遣|人材紹介|求人広告"
                        r"|フォーム営業|フォームDM|アポ獲得|リスト作成代行|営業リスト|作成代行|商談化|営業支援|営業コンサル"
                        r"|マッチングアプリ|恋活|婚活|推し活|VTuber|Vtuber|ゲーム|アーティスト|ファンクラブ|ファンコミュニティ"
                        r"|出版|新聞|放送|テレビ|雑誌|文芸|書籍|ラジオ|映画|ドラマ|アニメ|音楽|ライブ|コンサート")
# 会社・店舗向け（BtoB）らしさ。個人向けアプリなどは外す
B2B_RE = re.compile(r"法人|企業|業務|BtoB|B2B|SaaS|DX|営業|管理|経営|店舗|事業者|自治体|医療機関|導入|自社|Biz|ビジネス|"
                    r"バックオフィス|人事|労務|会計|経理|請求|採用|マーケティング|顧客|物流|建設|不動産|製造")
# 営業代行の会社（下請けの売り込み先。AGENCY_KEYWORDS で探し、judge_agency で判断）
AGENCY_KEYWORDS = ["営業代行", "テレアポ代行", "インサイドセールス代行", "営業アウトソーシング", "アポイント獲得", "営業支援サービス"]
AGENCY_RE = re.compile(r"営業代行|テレアポ代行|テレマーケティング|インサイドセールス代行|インサイドセールス支援|アポ(イント)?獲得"
                       r"|営業支援(サービス|会社)|営業アウトソーシング|セールスアウトソーシング|フォーム営業|コールセンター")
# 大手グループの子会社（社名の頭で判断）
LARGE_GROUP_RE = re.compile(r"^(株式会社\s*)?(NTT|KDDI|ソフトバンク|富士通|NEC|日立|パナソニック|トヨタ|三菱|三井|住友|ソニー|楽天|"
                            r"リクルート|サイバーエージェント|ヤフー|LINEヤフー|GMO|電通|博報堂|大日本印刷|凸版|TOPPAN|日本郵政|JR)")
MAX_CAPITAL_YEN = 2_000_000_000


@dataclass
class Release:
    url: str
    title: str
    company: str = ""
    site: str = ""
    industry: str = ""
    listed: str = ""
    capital: str = ""
    ceo: str = ""
    signal: str = ""


class Fetcher:
    def __init__(self):
        self.http = requests.Session()
        self.http.headers["User-Agent"] = config.USER_AGENT
        self.pages = 0

    def get(self, url: str) -> str:
        time.sleep(random.uniform(*SLEEP))
        r = self.http.get(url, timeout=config.HTTP_TIMEOUT_SEC)
        r.raise_for_status()
        r.encoding = "utf-8"
        return r.text


def _clean(html: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", html))).strip()


def signal_of(title: str) -> str:
    for name, rx in SIGNALS:
        if rx.search(title):
            return name
    return ""


def parse_rss(xml: str) -> list[Release]:
    out = []
    for url, body in re.findall(r'<item rdf:about="([^"]+)">(.*?)</item>', xml, re.S):
        title = re.search(r"<title>(.*?)</title>", body, re.S)
        corp = re.search(r"<dc:corp>(.*?)</dc:corp>", body, re.S)
        out.append(Release(url=url, title=_clean(title.group(1)) if title else "",
                           company=_clean(corp.group(1)) if corp else ""))
    return out


def parse_list(html: str) -> list[Release]:
    out, seen = [], set()
    for path, inner in re.findall(r'<a[^>]*href="(/main/html/rd/p/[0-9.]+\.html)"[^>]*>(.*?)</a>', html, re.S):
        title = _clean(inner)
        if title and path not in seen:
            seen.add(path)
            out.append(Release(url=BASE + path, title=title))
    return out


def parse_search(data: dict) -> list[Release]:
    """キーワード検索（JSON）から見出し・社名・日付。古いニュースは外す"""
    out = []
    oldest = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    for a in data.get("articles") or []:
        url, title = a.get("url") or "", _clean(a.get("title") or "")
        if not url.startswith("/main/html/rd/p/") or not title:
            continue
        when = ((a.get("updated_at") or {}).get("origin") or "")
        try:
            if datetime.fromisoformat(when) < oldest:
                continue
        except ValueError:
            pass
        out.append(Release(url=BASE + url, title=title, company=_clean((a.get("provider") or {}).get("name") or "")))
    return out


def parse_company(html: str) -> dict:
    """ニュースのページ下の会社情報（URL・業種・上場・資本金・代表者名）と社名"""
    info = {}
    block = re.search(r'<dl class="_container_[^"]*">(.*?)</dl>', html, re.S)
    if block:
        for dt, dd in re.findall(r"<dt>(.*?)</dt>\s*<dd>(.*?)</dd>", block.group(1), re.S):
            link = re.search(r'href="(https?://[^"]+)"', dd)
            info[_clean(dt)] = link.group(1) if link and _clean(dt) == "URL" else _clean(dd)
    if not info.get("URL", "").startswith("http"):
        info["URL"] = ""
    name = re.search(r'class="_companyName_[^"]*">(.*?)</', html, re.S)
    info["社名"] = _clean(name.group(1)) if name else ""
    return info


def capital_yen(text: str) -> int | None:
    """「1億2,000万円」「7152万円」「3,000,000円」を円に直す"""
    t = text.replace(",", "").replace(" ", "")
    m = re.search(r"(?:([0-9.]+)億)?(?:([0-9.]+)万)?([0-9.]+)?円", t)
    if not m or not any(m.groups()):
        return None
    oku, man, yen = (float(x) if x else 0 for x in m.groups())
    return int(oku * 100_000_000 + man * 10_000 + yen)


def judge(r: Release) -> str:
    """送り先にするなら空文字、外すなら理由"""
    text = f"{r.title} {r.company}"
    if EXCLUDE_RE.search(text):
        return "同業・対象外の業種"
    if LARGE_GROUP_RE.search(r.company):
        return "大手グループの会社"
    if not r.site:
        return "公式サイトのURLがない"
    if r.listed and r.listed != "未上場":
        return "上場企業"
    cap = capital_yen(r.capital)
    if cap and cap > MAX_CAPITAL_YEN:
        return "資本金が大きい（大企業）"
    if r.industry == "情報通信":
        if r.signal != "funding" and not B2B_RE.search(r.title):
            return "会社向けのサービスではなさそう"
    elif not (SAAS_RE.search(r.title) and B2B_RE.search(r.title)):
        return "IT・SaaSの会社ではない"
    return ""


def precheck(r: Release) -> bool:
    """ニュースのページを開く前に、見出しと社名だけで外せるものを外す（相手のサーバーへの負担を減らす）"""
    if not signal_of(r.title) or EXCLUDE_RE.search(f"{r.title} {r.company}"):
        return False
    return not (r.company and LARGE_GROUP_RE.search(r.company))


def listings(f: "Fetcher", log=print, keywords=KEYWORDS):
    """新着RSS → キーワード検索の1ページ目 → 2ページ目 … の順にニュースを出す（新しいものから）"""
    try:
        yield from parse_rss(f.get(RSS_URL))
    except requests.RequestException as e:
        log(f"PR TIMES：新着RSSを読めない（{type(e).__name__}）")
    alive = list(keywords)
    for page in range(1, SEARCH_MAX_PAGE + 1):
        for kw in list(alive):
            try:
                time.sleep(random.uniform(*SLEEP))
                res = f.http.get(SEARCH_API, params={"page": page, "type": "search", "v": kw, "limit": SEARCH_LIMIT},
                                 timeout=config.HTTP_TIMEOUT_SEC)
                res.raise_for_status()
                items = parse_search(res.json())
            except (requests.RequestException, ValueError):
                alive.remove(kw)
                continue
            if not items:
                alive.remove(kw)   # このキーワードは古いニュースまで見終わった
            yield from items
        if not alive:
            return


def judge_agency(r: Release) -> str:
    """下請けの売り込み先（営業代行の会社）にするなら空文字、外すなら理由"""
    if not AGENCY_RE.search(f"{r.title} {r.company}"):
        return "営業代行の会社ではない"
    if LARGE_GROUP_RE.search(r.company):
        return "大手グループの会社"
    if not r.site:
        return "公式サイトのURLがない"
    if r.listed and r.listed != "未上場":
        return "上場企業"
    cap = capital_yen(r.capital)
    if cap and cap > MAX_CAPITAL_YEN:
        return "資本金が大きい（大企業）"
    return ""


def precheck_agency(r: Release) -> bool:
    return bool(AGENCY_RE.search(f"{r.title} {r.company}")) and not (r.company and LARGE_GROUP_RE.search(r.company))


def find(known_urls: set[str], log=print, keywords=None, check=None):
    """新しいニュースから送り先の候補を1件ずつ返す（同じニュース・同じ会社は二度見ない）。
    呼ぶ側が必要な数そろったところで止めればよい。ニュースのページは1回 MAX_PAGES_PER_RUN 件まで"""
    f = Fetcher()
    seen, companies = set(known_urls), set()
    for r in listings(f, log, keywords or KEYWORDS):
        if r.url in seen or not (check or precheck)(r) or (r.company and r.company in companies):
            seen.add(r.url)
            continue
        seen.add(r.url)
        if f.pages >= MAX_PAGES_PER_RUN:
            log(f"PR TIMES：ニュースのページを{MAX_PAGES_PER_RUN}件見たので、今日はここまで")
            return
        try:
            info = parse_company(f.get(r.url))
        except requests.RequestException:
            continue
        f.pages += 1
        r.company = r.company or info.get("社名", "")
        companies.add(r.company)
        r.site, r.industry, r.listed = info.get("URL", ""), info.get("業種", ""), info.get("上場", "")
        r.capital, r.ceo, r.signal = info.get("資本金", ""), info.get("代表者名", ""), signal_of(r.title)
        yield r
