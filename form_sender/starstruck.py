"""【株式会社スターストラックのフォーム営業】マンション管理会社に、共用部清掃の協力会社として問い合わせフォームから送る。

1. 送り先：一般社団法人マンション管理業協会の「協会会員一覧」（公開）から、愛知県に本社・支店がある会員会社を拾う
   （会社ごとの公式サイトのURLが載っている）。愛知の本社の会社を先に、全国の会社の名古屋の支店をあとに送る
2. 送らない会社：EXCLUDE（2026-11-08 柳原さん指示の1社）と、暗号化した ss_ng.csv の会社
   リポジトリは公開なので、送らない会社は社名ではなく「社名・ドメインの指紋（sha256）」で持つ
3. 送れるか確かめる：フォームなし・営業お断り・画像認証は外す（AXION と同じ form_engine を使う）
4. 文面：message_starstruck.txt（送り主は SENDER。AXION SALES の名前は出さない）
5. 1社に送るのは1回だけ。同じ会社の別の支店にも送らない（ドメインで見分ける）
記録は AXION とは別のファイル（ss_*.csv）にし、state.enc に一緒に暗号化して残す。ログには会社名を出さない。
"""
import contextlib
import hashlib
import os
import random
import re
import time
from datetime import datetime

import requests
from bs4 import BeautifulSoup

import config
from common import (
    COMPANY_FIELDS, MODE_LIVE, MODE_TEST, RESULT_FAIL, RESULT_SKIP, RESULT_SUCCESS, SUBMITTED_PREFIX, Registry,
    append_rows, domain_of, finish_company, is_sent_row, load_companies, load_ng, load_results, normalize_name,
    record_result, sent_today_count, skip_stuck, start_company, Browser, COMPANY_LIMIT_SEC, CompanyTimeout, time_limit,
)

SENDER = {
    "company": "株式会社スターストラック",
    "company_short": "スターストラック",
    "last_name": "柳原",
    "first_name": "秀俊",
    "last_kana": "やなぎはら",
    "first_kana": "ひでとし",
    "email": "star.struck.hy@gmail.com",   # ホームページに載せている問い合わせ先と同じ
    "tel": "090-6616-4210",
    "zip": "452-0801",
    "pref": "愛知県",
    "city": "名古屋市西区",
    "street": "清里町149-1",
    "building": "401",
    "subject": "マンション共用部清掃の協力会社について（名古屋・尾張・豊田）",
}
SUBJECT = "{社名}さま　マンション共用部清掃の協力会社について"

# 送らない会社の指紋（normalize_name した社名、またはドメインの sha256 の先頭16文字）
EXCLUDE = {
    "dd06aa5f6460980f",  # 2026-11-08 柳原さん指示（社名）
    "bd306c7256258e90",  # 同（ドメイン）
}

PATHS = {
    "COMPANIES_CSV": config.BASE_DIR / "ss_companies.csv",
    "NG_LIST_CSV": config.BASE_DIR / "ss_ng.csv",
    "RESULT_CSV": config.BASE_DIR / "ss_result.csv",
    "INFLIGHT_JSON": config.BASE_DIR / ".ss_inflight.json",
}
MESSAGE_TXT = config.BASE_DIR / "message_starstruck.txt"
LIST_URL = "https://www.kanrikyo.or.jp/cgi-bin/memsearch/memsearch.cgi"
DETAIL_BASE = "https://www.kanrikyo.or.jp/member/data/"
AICHI = "22"            # 協会の検索の「愛知県」
KIND_HQ, KIND_BRANCH = "本社", "支店"
INDUSTRY = "マンション管理（管理業協会）"
# 2つ目の送り先：日本賃貸住宅管理協会（日管協）の愛知県の会員（アパート・賃貸マンションの管理会社。2026-11-12 追加）
JPM_LIST_URL = "https://www.jpm.jp/branch/list.php?cid=19"
INDUSTRY_JPM = "賃貸住宅管理（日管協）"
# 対応地域（名古屋市・尾張・豊田市周辺）。この住所の会社にだけ送る
AREA_RE = re.compile(r"名古屋市|春日井|小牧|一宮|あま市|長久手|豊田市|清須|北名古屋|稲沢|日進|尾張旭|瀬戸|みよし|大府|東郷|豊明|津島|江南|岩倉|犬山|豊山|大口|扶桑|蟹江|甚目寺|大治")
CORP_SHORT = {"（株）": "株式会社", "(株)": "株式会社", "（有）": "有限会社", "(有)": "有限会社", "（同）": "合同会社", "(同)": "合同会社"}


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def excluded(name: str, url: str) -> bool:
    return bool((name and fingerprint(normalize_name(name)) in EXCLUDE)
                or (url and fingerprint(domain_of(url)) in EXCLUDE))


@contextlib.contextmanager
def own_files():
    """記録のファイルを AXION のものからスターストラック用（ss_*.csv）に切り替える"""
    old = {k: getattr(config, k) for k in PATHS}
    for k, v in PATHS.items():
        setattr(config, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(config, k, v)


# ---------------------------------------------------------------- 送り先（管理業協会の会員一覧）
def _get(http: requests.Session, method: str, url: str, **kw) -> str:
    r = http.request(method, url, timeout=config.HTTP_TIMEOUT_SEC, **kw)
    r.raise_for_status()
    return r.content.decode("cp932", errors="replace")


def member_list(http: requests.Session) -> list[tuple[str, str, str]]:
    """(会員ページのURL, 一覧に出ている名前, 本社/支店) を、愛知の本社 → 愛知の支店 の順に返す"""
    out = []
    for p2, kind in (("0", KIND_HQ), ("1", KIND_BRANCH)):
        html = _get(http, "POST", LIST_URL, data={"mode": "search", "P1": "99", "P2": p2, "P3": AICHI, "word": ""})
        for href, label in re.findall(r'href="(?:\.\./)*member/data/(\d+\.html)"[^>]*>(.*?)</a>', html, re.S):
            out.append((DETAIL_BASE + href, BeautifulSoup(label, "lxml").get_text(" ", strip=True), kind))
    return out


def member_detail(http: requests.Session, url: str) -> tuple[str, str]:
    """会員ページから (正式な社名, 公式サイトのURL)"""
    soup = BeautifulSoup(_get(http, "GET", url), "lxml")
    title = (soup.title.get_text(strip=True) if soup.title else "").split("｜")[0].strip()
    site = next((a["href"].strip() for a in soup.select("a[href^=http]") if "kanrikyo.or.jp" not in a["href"]), "")
    return title, site


def branch_of(label: str) -> str:
    """一覧の名前「(株)○○　名古屋支店」から支店名だけ取り出す"""
    parts = re.split(r"[　 ]+", label.strip(), maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else ""


def full_name(name: str) -> str:
    """「（株）アットイン」→「株式会社アットイン」、「○○不動産（株）」→「○○不動産株式会社」"""
    name = re.sub(r"\s+", "", name)
    for short, full in CORP_SHORT.items():
        name = name.replace(short, full)
    return name


def jpm_members(http: requests.Session) -> list[tuple[str, str, str]]:
    """日管協の愛知県の会員から (社名, 公式サイト, 住所)。サイトの載っていない会社は外す"""
    r = http.get(JPM_LIST_URL, timeout=config.HTTP_TIMEOUT_SEC)
    r.raise_for_status()
    html = re.sub(r"<(script|style).*?</\1>", "", r.text, flags=re.S)
    out = []
    for block in re.findall(r"<dl>(.*?)</dl>", html, re.S):
        dt = re.search(r"<dt>(.*?)</dt>", block, re.S)
        if not dt:
            continue
        head = re.split(r'<div class="map_link"', dt.group(1))[0]
        site = re.search(r'<a href="(https?://(?!maps\.google)[^"]+)"', head)
        name = BeautifulSoup(head, "lxml").get_text(" ", strip=True)
        addr = re.search(r'add_block">\s*(.*?)</div>', block, re.S)
        addr = BeautifulSoup(addr.group(1), "lxml").get_text(" ", strip=True) if addr else ""
        if name and site:
            out.append((full_name(name), site.group(1).strip(), addr))
    return out


def discover(log=log) -> int:
    """まだ読んでいない名簿から、候補にしていない会社を ss_companies.csv に足す。足した数を返す"""
    http = requests.Session()
    http.headers.update({"User-Agent": config.USER_AGENT, "Accept-Language": "ja"})
    companies = load_companies()
    known = Registry(companies)
    done_sources = {c.get("業種", "") for c in companies}
    added = 0
    if INDUSTRY_JPM not in done_sources:
        try:
            members = jpm_members(http)
        except requests.RequestException as e:
            log(f"日管協の会員一覧を読めませんでした（{type(e).__name__}）")
            members = []
        rows = []
        for name, site, addr in members:
            if not AREA_RE.search(addr) or known.contains(name, site) or excluded(name, site):
                continue
            known.add(name, site)
            rows.append({"社名": name, "URL": site, "所在地": f"{KIND_HQ}:", "業種": INDUSTRY_JPM})
        append_rows(config.COMPANIES_CSV, COMPANY_FIELDS, rows)
        added += len(rows)
        log(f"日管協（愛知）：会員 {len(members)}社 → 対応地域の {len(rows)}社を候補に追加")
    if INDUSTRY in done_sources:
        return added
    try:
        members = member_list(http)
    except requests.RequestException as e:
        log(f"会員一覧を読めませんでした（{type(e).__name__}）")
        return 0
    log(f"会員一覧：愛知の本社・支店 {len(members)}件")
    for url, label, kind in members:
        time.sleep(random.uniform(0.8, 1.6))
        try:
            name, site = member_detail(http, url)
        except requests.RequestException:
            continue
        if not name or not site or known.contains(name, site) or excluded(name, site):
            continue
        known.add(name, site)
        append_rows(config.COMPANIES_CSV, COMPANY_FIELDS,
                    [{"社名": name, "URL": site, "所在地": f"{kind}:{branch_of(label)}", "業種": INDUSTRY}])
        added += 1
    log(f"送り先の候補に {added}社を追加")
    return added


def pending(mode: str) -> list[dict]:
    """まだ送っていない会社（本番でスキップ・送信済みの会社と、送らない会社は除く）。本社の会社が先"""
    results = load_results()
    if mode == MODE_LIVE:
        done = Registry([r for r in results if r.get("モード") == MODE_LIVE and (is_sent_row(r) or r.get("結果") == RESULT_SKIP)])
    else:
        done = Registry([r for r in results if r.get("モード") == MODE_TEST])
    fails = {}
    for r in results:   # 2回失敗した会社（サイトにつながらない等）はもう試さない
        if r.get("モード") == mode and r.get("結果") == RESULT_FAIL:
            fails[(r["社名"], r["URL"])] = fails.get((r["社名"], r["URL"]), 0) + 1
    for (n, u), k in fails.items():
        if k >= 2:
            done.add(n, u)
    ng = load_ng()
    rows = [c for c in load_companies()
            if c.get("URL") and not done.contains(c["社名"], c["URL"]) and not ng.contains(c["社名"], c["URL"])
            and not excluded(c["社名"], c["URL"])]
    return sorted(rows, key=lambda c: not c.get("所在地", "").startswith(KIND_HQ))


def build_letter(company: dict) -> tuple[str, str]:
    branch = company.get("所在地", "").partition(":")[2]
    text = MESSAGE_TXT.read_text(encoding="utf-8")
    body = (text.replace("{社名}", company["社名"]).replace("{宛名}", f"{branch}　" if branch else "")
            .replace("{メール}", SENDER["email"]))
    return SUBJECT.replace("{社名}", company["社名"])[:60], body.strip() + "\n"


# ---------------------------------------------------------------- 送る
def run(count: int, live: bool, headed: bool = False, wait: bool = True) -> None:
    with own_files():
        _run(count, live, headed, wait)


def _run(count: int, live: bool, headed: bool, wait: bool) -> None:
    from playwright.sync_api import sync_playwright

    from form_engine import precheck, process_company

    mode = MODE_LIVE if live else MODE_TEST
    skip_stuck(log)
    if live:
        count = min(count, config.DAILY_SEND_LIMIT - sent_today_count(load_results()))
        if count <= 0:
            log("本日の送信上限に達しています")
            return
    if len(pending(mode)) < count * 4:   # 送れるのは5社に1社ほどなので、足りなければ名簿を足す
        discover()
    targets = pending(mode)
    log(f"スターストラック {mode}モード：候補 {len(targets)}社 / 今回 最大{count}件")
    if not targets:
        log("送り先が残っていません（管理業協会の愛知の会員には、すべて送り終えています）")
        return
    config.SCREENSHOT_DIR.mkdir(exist_ok=True)

    sent = i = 0
    with sync_playwright() as pw:
        b = Browser(pw, headed)
        try:
            for c in targets:
                if sent >= count:
                    break
                i += 1
                name, url = c["社名"], c["URL"]
                start_company(name, url, mode)
                page = b.new_page()
                timed_out = False
                try:
                    with time_limit(COMPANY_LIMIT_SEC):
                        out = precheck(page, url)
                    if out:
                        record_result(name, url, out.result, out.reason, mode)
                        log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                        continue
                    subject, message = build_letter(c)
                    if sent and wait:
                        time.sleep(random.uniform(config.WAIT_MIN_SEC, config.WAIT_MAX_SEC))
                    shot = str(config.SCREENSHOT_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_ss_{mode}_{i}.png")
                    with time_limit(COMPANY_LIMIT_SEC):
                        out = process_company(page, name, url, message, live, shot, subject=subject, sender=SENDER)
                    record_result(name, url, out.result, out.reason, mode)
                    log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                    if out.result == RESULT_SUCCESS or out.reason.startswith(SUBMITTED_PREFIX):
                        sent += 1
                except CompanyTimeout:
                    record_result(name, url, RESULT_SKIP, f"時間切れ（{COMPANY_LIMIT_SEC}秒で打ち切り）", mode)
                    log(f"{i}社目：スキップ（時間切れ）")
                    timed_out = True
                except Exception as e:  # 想定外のエラーでも記録して次へ
                    first = (str(e).splitlines() or [type(e).__name__])[0]
                    record_result(name, url, RESULT_FAIL, f"予期しないエラー: {first[:150]}", mode)
                    log(f"{i}社目：失敗（{type(e).__name__}）")
                finally:
                    if timed_out:
                        b.restart()
                    else:
                        b.close_page(page)
                    finish_company()
        finally:
            b.close()
    log(f"終了：{'送信' if live else 'テスト入力'} {sent}件")
