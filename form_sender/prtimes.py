"""【無料版の送り先探し】PR TIMES の新着ニュースから、営業を強化しそうな会社を拾う（AIを使わない）。

- 新着RSS と、キーワード別の一覧（資金調達・シリーズA・SaaS など）からニュースを集める
- 見出しが「資金調達・新サービス・営業強化」などの動きで、業種が「情報通信」、未上場の会社だけを残す
- 公式サイトのURL・代表者名などは、ニュースのページ下の会社情報から取る
"""
import random
import re
import time
from dataclasses import dataclass
from html import unescape
from urllib.parse import quote

import requests

import config

BASE = "https://prtimes.jp"
RSS_URL = f"{BASE}/index.rdf"
KEYWORDS = ["資金調達", "シリーズA", "シリーズB", "プレシリーズA", "SaaS", "クラウドサービス", "提供開始",
            "営業DX", "インサイドセールス", "業務効率化"]
SLEEP = (1.0, 2.0)
MAX_PAGES_PER_RUN = 80   # 1回に開くニュースのページ数の上限（相手のサーバーに負担をかけない）

# 見出しの「動き」→ 営業文の書き出しを変える
SIGNALS = [
    ("funding", re.compile(r"資金調達|シリーズ[A-D]|プレシリーズ|シード(ラウンド)?|第三者割当|出資を受け|億円を調達")),
    ("launch", re.compile(r"提供開始|リリース|正式版|ローンチ|新機能|新サービス|新プラン|β版|ベータ版|販売開始")),
    ("sales", re.compile(r"営業|インサイドセールス|セールス|販売代理|パートナー(制度|募集|プログラム)|拡販|導入社数")),
]
# SaaS・ITサービスらしさ（業種が「情報通信」でないときの補助）
SAAS_RE = re.compile(r"SaaS|クラウド|AI|DX|アプリ|プラットフォーム|システム|ツール|ソフトウェア")
# 同業や対象外（営業代行・人材など）
EXCLUDE_RE = re.compile(r"営業代行|テレアポ|コールセンター|インサイドセールス代行|営業支援代行|人材派遣|人材紹介|求人広告"
                        r"|フォーム営業|フォームDM|アポ獲得|リスト作成代行"
                        r"|出版|新聞|放送|テレビ|雑誌|文芸|書籍|ラジオ|映画|ドラマ|アニメ|音楽|ライブ|コンサート")
# 会社・店舗向け（BtoB）らしさ。個人向けアプリなどは外す
B2B_RE = re.compile(r"法人|企業|業務|BtoB|B2B|SaaS|DX|営業|管理|経営|店舗|事業者|自治体|医療機関|導入|自社|Biz|ビジネス|"
                    r"バックオフィス|人事|労務|会計|経理|請求|採用|マーケティング|顧客|EC|物流|建設|不動産|製造")
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


def parse_company(html: str) -> dict:
    """ニュースのページ下の会社情報（URL・業種・上場・資本金・代表者名）と社名"""
    info = {}
    block = re.search(r'<dl class="_container_[^"]*">(.*?)</dl>', html, re.S)
    if block:
        for dt, dd in re.findall(r"<dt>(.*?)</dt>\s*<dd>(.*?)</dd>", block.group(1), re.S):
            link = re.search(r'href="(https?://[^"]+)"', dd)
            info[_clean(dt)] = link.group(1) if link and _clean(dt) == "URL" else _clean(dd)
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


def find(known_urls: set[str], log=print) -> list[Release]:
    """新しいニュースから送り先の候補を返す（同じニュースは二度見ない）"""
    f = Fetcher()
    items: dict[str, Release] = {}
    try:
        for r in parse_rss(f.get(RSS_URL)):
            items.setdefault(r.url, r)
    except requests.RequestException as e:
        log(f"PR TIMES：新着RSSを読めない（{type(e).__name__}）")
    for kw in KEYWORDS:
        try:
            for r in parse_list(f.get(f"{BASE}/topics/keywords/{quote(kw)}")):
                items.setdefault(r.url, r)
        except requests.RequestException:
            continue
    fresh = [r for r in items.values() if r.url not in known_urls and signal_of(r.title)]
    log(f"PR TIMES：ニュース {len(items)}件、うち動きのある新しいもの {len(fresh)}件")
    out = []
    for r in fresh[:MAX_PAGES_PER_RUN]:
        try:
            info = parse_company(f.get(r.url))
        except requests.RequestException:
            continue
        r.company = r.company or info.get("社名", "")
        r.site, r.industry, r.listed = info.get("URL", ""), info.get("業種", ""), info.get("上場", "")
        r.capital, r.ceo, r.signal = info.get("資本金", ""), info.get("代表者名", ""), signal_of(r.title)
        out.append(r)
    return out
