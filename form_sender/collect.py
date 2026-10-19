"""【1. リスト作成】検索エンジン/企業名簿から名古屋市の中小企業の公式サイトを集めて companies.csv に追記する。"""
import json
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
import base64
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

import config
from common import (
    COMPANY_FIELDS, Registry, append_rows, launch_chromium, domain_of, is_excluded_domain, load_companies,
    load_ng, nfkc, normalize_name, read_csv,
)

# 検索エンジン（テスト時は差し替え可能）
DDG_URL = "https://duckduckgo.com/"
DDG_RESULT_SEL = "a[data-testid=result-title-a]"
BING_URL = "https://www.bing.com/search"
BING_RESULT_SEL = "li.b_algo h2 a"
SEARCH_SLEEP = (2.0, 5.0)
SITE_SLEEP = (1.0, 2.5)
FETCH_FAILED = "サイトを取得できない"

OVERVIEW_LINK_RE = re.compile(
    r"会社概要|会社案内|企業情報|会社情報|企業概要|事業所概要|私たちについて|about|company|outline|profile|gaiyo|gaiyou|corporate",
    re.I,
)
INDUSTRY_WORDS_RE = re.compile(
    r"建設|建築|工務店|土木|工事|設備|空調|給排水|配管|電気|リフォーム|リノベーション|住宅|不動産|賃貸|売買|仲介|管理"
)
CORP_IN_NAME_RE = re.compile(r"株式会社|有限会社|合同会社|合資会社|㈱|㈲|\(株\)|\(有\)|工務店|建設|工業|設備|不動産|ホーム|住建|建工|電設|電工")
NAME_LABELS = ("会社名", "社名", "商号", "名称", "法人名", "企業名", "屋号")
ADDRESS_RE = re.compile(r"(?:愛知県\s*)?名古屋市\s*\S{1,4}?区[^\s、。,<>「」()（）|｜/／]{1,40}")
EMPLOYEE_RE = re.compile(r"(?:従業員|社員|スタッフ)数?[^0-9\n]{0,12}?([0-9][0-9,]*)\s*(?:名|人)")
CAPITAL_RE = re.compile(r"資本金[^0-9\n]{0,12}?([0-9][0-9,\.]*)\s*(億|千万|百万|万)?")


@dataclass
class Candidate:
    name: str
    url: str
    address: str
    industry: str
    employees: int | None


class Collector:
    def __init__(self, log=print):
        self.log = log
        self.http = requests.Session()
        self.http.headers.update({"User-Agent": config.USER_AGENT, "Accept-Language": "ja,en;q=0.8"})
        self.state = self._load_state()
        self._pw = self._browser = self._page = None

    # ------------------------------------------------------------ state
    def _load_state(self) -> dict:
        try:
            return json.loads(config.COLLECT_STATE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"query_index": 0, "rejected_domains": []}

    def _save_state(self) -> None:
        self.state["rejected_domains"] = sorted(set(self.state.get("rejected_domains", [])))
        config.COLLECT_STATE.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")

    def _reject(self, url: str, reason: str) -> None:
        self.log(f"  除外: {url} ({reason})")
        self.state.setdefault("rejected_domains", []).append(domain_of(url))

    # ------------------------------------------------------------ http
    def fetch(self, url: str) -> tuple[str, str] | None:
        """(最終URL, HTML) を返す。失敗時は None。"""
        try:
            r = self.http.get(url, timeout=config.HTTP_TIMEOUT_SEC, allow_redirects=True)
        except requests.RequestException:
            return None
        if r.status_code >= 400 or "html" not in r.headers.get("Content-Type", "html"):
            return None
        if not r.encoding or r.encoding.lower() in ("iso-8859-1", "ascii"):
            r.encoding = r.apparent_encoding
        return r.url, r.text

    # ------------------------------------------------------------ search
    def search(self, query: str) -> list[str]:
        """実ブラウザで検索する（requests だと検索エンジンにブロックされるため）。"""
        urls = self._search_in_browser(f"{DDG_URL}?{urlencode({'q': query, 'kl': 'jp-jp'})}", DDG_RESULT_SEL)
        if not urls:
            urls = self._search_in_browser(f"{BING_URL}?{urlencode({'q': query, 'setlang': 'ja'})}", BING_RESULT_SEL)
        time.sleep(random.uniform(*SEARCH_SLEEP))
        return [u for u in (_unwrap_result_url(h) for h in urls) if u.startswith("http")]

    def _search_in_browser(self, url: str, selector: str) -> list[str]:
        if self._page is None:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
            self._browser = launch_chromium(self._pw)
            self._page = self._browser.new_page(locale="ja-JP", user_agent=config.USER_AGENT)
        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=config.PAGE_TIMEOUT_MS)
            self._page.wait_for_selector(selector, timeout=10000)
            return self._page.eval_on_selector_all(selector, "els => els.map(e => e.href)")
        except Exception:
            return []

    def close(self) -> None:
        if self._browser:
            self._browser.close()
            self._pw.stop()
            self._browser = self._page = None

    def queries(self):
        """(業種, 検索語) を区×業種でローテーションしながら返す。前回の続きから再開する。"""
        pairs = [
            (industry, f"名古屋市{ward} {kw}")
            for ward in config.NAGOYA_WARDS
            for industry, kws in config.INDUSTRY_QUERIES.items()
            for kw in kws
        ]
        start = self.state.get("query_index", 0) % len(pairs)
        for i in range(len(pairs)):
            idx = (start + i) % len(pairs)
            self.state["query_index"] = idx + 1
            yield pairs[idx]

    # ------------------------------------------------------------ site evaluation
    def evaluate_site(self, url: str, industry: str, expected_name: str = "") -> Candidate | str:
        """公式サイトを調べて Candidate を返す。対象外なら除外理由(str)を返す。"""
        root = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
        top = self.fetch(root) or self.fetch(url)
        if not top:
            return FETCH_FAILED
        final_url, html = top
        if is_excluded_domain(final_url):
            return "ポータル/対象外ドメインへ転送"
        soup = BeautifulSoup(html, "lxml")
        pages = [soup]
        overview = self._find_overview_link(soup, final_url)
        if overview:
            time.sleep(random.uniform(*SITE_SLEEP))
            got = self.fetch(overview)
            if got:
                pages.insert(0, BeautifulSoup(got[1], "lxml"))  # 会社概要を優先
        texts = [_page_text(p) for p in pages]
        alltext = "\n".join(texts)

        if expected_name and normalize_name(expected_name) not in normalize_name(alltext):
            return "社名がサイト内に見つからない"
        if not re.search(r"[ぁ-んァ-ン]", alltext):
            return "日本語サイトではない"
        if not INDUSTRY_WORDS_RE.search(alltext):
            return "対象業種の記載がない"
        for pat in config.LISTED_PATTERNS:
            if re.search(pat, alltext):
                return f"上場/大手の記載あり（{pat}）"

        name = expected_name or self._extract_name(pages, texts)
        if not name:
            return "社名を特定できない"
        for big in config.LARGE_COMPANY_NAMES:
            if nfkc(big) in nfkc(name):
                return f"大手企業（{big}）"

        address = _extract_address(texts)
        if not address:
            return "名古屋市の所在地が見つからない"

        employees = _extract_employees(alltext)
        if employees is not None and employees > config.MAX_EMPLOYEES:
            return f"従業員数 {employees} 名"
        capital = _extract_capital(alltext)
        if capital is not None and capital >= config.MAX_CAPITAL_YEN:
            return f"資本金 {capital:,} 円"

        return Candidate(name=name, url=_site_root(final_url), address=address, industry=industry,
                         employees=employees)

    def _find_overview_link(self, soup: BeautifulSoup, base: str) -> str | None:
        host = urlparse(base).netloc
        for a in soup.find_all("a", href=True):
            text = (a.get_text(" ", strip=True) or "") + " " + a["href"]
            if OVERVIEW_LINK_RE.search(text):
                href = urljoin(base, a["href"])
                if urlparse(href).netloc == host and href.rstrip("/") != base.rstrip("/"):
                    return href
        return None

    def _extract_name(self, pages: list[BeautifulSoup], texts: list[str]) -> str:
        # 1) 会社概要の表（会社名/商号 の行）
        for soup in pages:
            for cell in soup.find_all(["th", "dt", "td"]):
                label = nfkc(cell.get_text("", strip=True)).replace(" ", "")
                if label in NAME_LABELS:
                    nxt = cell.find_next_sibling(["td", "dd"])
                    if nxt:
                        cand = _clean_name(nxt.get_text(" ", strip=True))
                        if cand:
                            return cand
        # 2) og:site_name / title の区切りごと
        for soup in pages[::-1]:
            og = soup.find("meta", attrs={"property": "og:site_name"})
            segs = [og["content"]] if og and og.get("content") else []
            if soup.title and soup.title.string:
                segs += re.split(r"\s+[\-－–—]\s+|\s*[|｜/／:：【】「」]\s*", soup.title.string)  # 「A-WORK」の - では切らない
            for s in segs:
                cand = _clean_name(s)
                if cand and CORP_IN_NAME_RE.search(cand):
                    return cand
        # 3) コピーライト表記
        for t in texts:
            m = re.search(r"(?:©|\(c\)|copyright)\s*(?:\d{4}[\s\-–~]*\d{0,4})?\s*([^\n.,]{2,40})", t, re.I)
            if m:
                cand = _clean_name(m.group(1))
                if cand and CORP_IN_NAME_RE.search(cand):
                    return cand
        return ""

    # ------------------------------------------------------------ main entry
    def run(self, max_new: int) -> list[Candidate]:
        max_new = min(max_new, config.COLLECT_MAX_PER_RUN)
        existing = Registry(load_companies())
        ng = load_ng()
        rejected = set(self.state.get("rejected_domains", []))
        found: list[Candidate] = []
        seen: set[str] = set()
        empty_searches = 0
        try:
            for industry, query in self.queries():
                if len(found) >= max_new:
                    break
                self.log(f"検索: {query}")
                results = self.search(query)
                if not results:
                    empty_searches += 1
                    if empty_searches >= 5:
                        self.log("検索結果が連続して取得できないため中断します（検索エンジンにブロックされた可能性）")
                        break
                    continue
                empty_searches = 0
                for url in results:
                    if len(found) >= max_new:
                        break
                    d = domain_of(url)
                    if d in seen or d in rejected or is_excluded_domain(url):
                        continue
                    seen.add(d)
                    if existing.contains("", url) or ng.contains("", url):
                        continue
                    result = self.evaluate_site(url, industry)
                    time.sleep(random.uniform(*SITE_SLEEP))
                    if isinstance(result, str):
                        if result == FETCH_FAILED:
                            self.log(f"  取得失敗: {url}")
                        else:
                            self._reject(url, result)
                        continue
                    if existing.contains(result.name, result.url) or ng.contains(result.name, result.url):
                        continue
                    existing.add(result.name, result.url)
                    found.append(result)
                    self.log(f"  追加: {result.name} {result.url} [{result.industry}]")
        finally:
            self.close()
            self._save_state()
            self._write(found)
        return found

    def run_import(self, path: str, max_new: int) -> list[Candidate]:
        """企業名簿 CSV（社名, 所在地, 業種, URL[任意]）を取り込む。URL が無い行は検索で公式サイトを特定する。"""
        max_new = min(max_new, config.COLLECT_MAX_PER_RUN)
        existing = Registry(load_companies())
        ng = load_ng()
        found: list[Candidate] = []
        try:
            for row in read_csv(Path(path)):
                if len(found) >= max_new:
                    break
                name, url = row.get("社名", ""), row.get("URL", "")
                industry = row.get("業種", "")
                if not name or existing.contains(name, url) or ng.contains(name, url):
                    continue
                if "名古屋市" not in nfkc(row.get("所在地", "名古屋市")):
                    self.log(f"  除外: {name}（所在地が名古屋市外）")
                    continue
                if not url:
                    self.log(f"検索: {name}")
                    url = next((u for u in self.search(f"{name} 名古屋市 {industry}")
                                if not is_excluded_domain(u)), "")
                    if not url:
                        self.log(f"  除外: {name}（公式サイトが見つからない）")
                        continue
                result = self.evaluate_site(url, industry, expected_name=name)
                time.sleep(random.uniform(*SITE_SLEEP))
                if isinstance(result, str):
                    self.log(f"  除外: {name} {url}（{result}）")
                    continue
                if row.get("所在地"):
                    result.address = row["所在地"]
                if existing.contains("", result.url):
                    continue
                existing.add(result.name, result.url)
                found.append(result)
                self.log(f"  追加: {result.name} {result.url}")
        finally:
            self.close()
            self._write(found)
        return found

    def _write(self, found: list[Candidate]) -> None:
        # 従業員数が確認できた中小企業を先頭に（＝送信で優先される）
        found.sort(key=lambda c: (c.employees is None, c.employees or 0))
        append_rows(config.COMPANIES_CSV, COMPANY_FIELDS, [
            {"社名": c.name, "URL": c.url, "所在地": c.address, "業種": c.industry} for c in found
        ])


# ---------------------------------------------------------------- helpers
def _unwrap_result_url(href: str) -> str:
    """検索エンジンのリダイレクトURL（DDG の uddg= / Bing の ck/a?u=a1...）から実URLを取り出す。"""
    q = parse_qs(urlparse(href).query)
    if "uddg" in q:
        return q["uddg"][0]
    u = q.get("u", [""])[0]
    if "bing.com" in href and u.startswith("a1"):
        b = u[2:] + "=" * (-len(u[2:]) % 4)
        try:
            return base64.urlsafe_b64decode(b).decode()
        except ValueError:
            return ""
    return href


def _page_text(soup: BeautifulSoup) -> str:
    soup = BeautifulSoup(str(soup), "lxml")
    for t in soup(["script", "style", "noscript", "template"]):
        t.decompose()
    text = nfkc(soup.get_text("\n"))
    return re.sub(r"[ \t　]+", " ", text)


def _site_root(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}/"


GENERIC_PAGE_TITLES = {"ホーム", "home", "トップ", "top", "トップページ", "お問い合わせ", "会社概要", "会社案内", "企業情報"}
_CORP = r"(?:株式会社|有限会社|合同会社|合資会社|合名会社)"


def _clean_name(s: str) -> str:
    """タイトル等から取った文字列を社名だけに整える。社名と言えなければ空文字。"""
    s = nfkc(s).strip()
    s = re.sub(r"^(?:©|\(c\)|copyright)\s*(?:\d{4}[\s\-–~]*\d{0,4})?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*(all rights reserved|inc\.?|co\.,? ?ltd\.?).*$", "", s, flags=re.I).strip(" ,|-")
    s = re.sub(r"\s*[|｜].*$", "", s)                                   # 「社名 | ROKUGO」
    s = re.sub(r"\s+[\-–—]\s+.*$", "", s)                               # 「株式会社X - 土木工事・…」
    s = re.sub(r"[(（【][ァ-ヶー・\s]+[)）】]", "", s)                   # 途中の読み「三本(ミモト)建設」
    s = re.sub(r"(まで|にお任せ.*|へようこそ.*)$", "", s)
    s = re.sub(r"[\s・\-]+(公式(ホームページ|サイト|HP)|ホームページ|オフィシャルサイト|official site|トップページ|TOP)$", "", s, flags=re.I)
    # 「名古屋市北区で…なら【株式会社X】」「…の株式会社X」→ 株式会社X
    m = re.match(rf"^.*(?:なら|の)\s*【?({_CORP}[^】]+)】?$", s) or re.match(rf"^.*【(.*{_CORP}.*)】.*$", s)
    if m:
        s = m.group(1)
    elif "なら" in s:
        s = s.rsplit("なら", 1)[1]
    # 「創業120年の久野工務店株式会社」→ 法人格を含む「の」の後ろだけ（「株式会社リフォームの松もと」は対象外）
    m = re.match(rf"^([^の]*)の(\S*{_CORP}\S*)$", s)
    if m and not re.search(_CORP, m.group(1)):
        s = m.group(2)
    # 「総合建設 株式会社Takeichi」→ 株式会社Takeichi
    m = re.match(rf"^(\S+)\s+({_CORP}\S+)$", s)
    if m and not re.search(_CORP, m.group(1)):
        s = m.group(2)
    s = re.sub(r"\s*[(（][^)）]*[)）]?\s*$", "", s)                    # 末尾の（読み・英文名）
    s = re.sub(r"[!！。].*$", "", s)                                     # 宣伝文句
    m = re.match(rf"^(\S+?{_CORP})\s+\S.*$", s)                          # 「X株式会社 X一級建築士事務所」
    if m:
        s = m.group(1)
    m = re.match(r"^(.*[ぁ-んァ-ヶ一-龥])\s+[A-Za-z][A-Za-z .,&'-]*$", s)  # 「株式会社X ASAI CONSTRUCTION」
    if m and not re.fullmatch(_CORP, m.group(1).strip()):           # 「株式会社 I.D.E.」は残す
        s = m.group(1)
    s = s.strip(" 【】「」")
    if s.lower() in GENERIC_PAGE_TITLES or re.fullmatch(_CORP, s):
        return ""
    if not (2 <= len(s) <= 40) or "\n" in s:
        return ""
    if "名古屋市" in s or re.search(r"(会社|業者)$", s) and not re.search(_CORP, s):
        return ""  # 「名古屋市中区 不動産会社」など社名でないもの
    return s


def _extract_address(texts: list[str]) -> str:
    best = ""
    for t in texts:
        for m in ADDRESS_RE.finditer(t):
            addr = m.group(0).replace(" ", "")
            if not addr.startswith("愛知県"):
                addr = "愛知県" + addr
            before = t[max(0, m.start() - 40):m.start()]
            if re.search(r"所在地|本社|本店|住所|〒|address", before, re.I):
                return addr
            best = best or addr
    return best


def _extract_employees(text: str) -> int | None:
    m = EMPLOYEE_RE.search(text)
    return int(m.group(1).replace(",", "")) if m else None


def _extract_capital(text: str) -> int | None:
    m = CAPITAL_RE.search(text)
    if not m:
        return None
    try:
        num = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    unit = {"億": 10**8, "千万": 10**7, "百万": 10**6, "万": 10**4}.get(m.group(2) or "", 1)
    return int(num * unit)


def collect(max_new: int, log=print) -> list[Candidate]:
    return Collector(log=log).run(max_new)


def import_list(path: str, max_new: int, log=print) -> list[Candidate]:
    return Collector(log=log).run_import(path, max_new)

