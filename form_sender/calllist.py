"""送信した会社のフォロー電話用リスト（call_list.csv）を作る。電話番号は各社の公式サイトから拾う。"""
import csv
import random
import re
import time

from bs4 import BeautifulSoup

import config
from collect import Collector, _page_text
from common import MODE_LIVE, RESULT_SUCCESS, SUBMITTED_PREFIX, load_companies, load_results, nfkc

CALL_LIST_CSV = config.BASE_DIR / "call_list.csv"
CALL_FIELDS = ["社名", "電話番号", "所在地", "業種", "送信日", "送信結果", "URL"]

PHONE_RE = re.compile(r"(?<!\d)(0\d{1,4})[-‐－ー―(（\s]{0,2}(\d{1,4})[-‐－ー―)）\s]{0,2}(\d{4})(?!\d)")
LABEL_RE = re.compile(r"TEL|Tel|tel|電話|☎|℡|お問い?合わ?せ|代表")
OWN_PHONE = re.sub(r"\D", "", config.SENDER["tel"])


def find_phone(texts: list[str], tel_links: list[str]) -> str:
    """サイトの文面から代表電話らしい番号を1つ選ぶ。FAX の番号は避ける。"""
    for href in tel_links:
        digits = re.sub(r"\D", "", href)
        if 10 <= len(digits) <= 11 and digits != OWN_PHONE:
            return _format(digits)
    best = ""
    for text in texts:
        for m in PHONE_RE.finditer(text):
            digits = "".join(m.groups())
            if not (10 <= len(digits) <= 11) or digits == OWN_PHONE or digits.startswith(("0120", "0800")):
                continue
            before = text[max(0, m.start() - 15):m.start()]
            if re.search(r"FAX|Fax|fax|ファックス|ファクス", before):
                continue
            number = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            if LABEL_RE.search(before):
                return number
            best = best or number
    return best


def _format(digits: str) -> str:
    if digits.startswith(("090", "080", "070", "050")):
        return f"{digits[:3]}-{digits[3:7]}-{digits[7:]}"
    if digits.startswith("052"):
        return f"052-{digits[3:6]}-{digits[6:]}"
    return f"{digits[:4]}-{digits[4:6]}-{digits[6:]}" if len(digits) == 10 else digits


def targets() -> list[dict]:
    """本番で送信できた会社（成功・送信された可能性あり）を、会社ごとに最新の結果で返す。"""
    last = {}
    for r in load_results():
        if r.get("モード") != MODE_LIVE:
            continue
        if r["結果"] == RESULT_SUCCESS:
            last[r["URL"]] = dict(r, 送信結果="送信成功")
        elif r["結果"] == "失敗" and r["理由"].startswith(SUBMITTED_PREFIX):
            last[r["URL"]] = dict(r, 送信結果="送信された可能性あり")
    rows = list(last.values())
    rows.sort(key=lambda r: (r["送信結果"] != "送信成功", r["日時"]))
    return rows


def build(log=print) -> int:
    companies = {c["URL"]: c for c in load_companies()}
    done = {}
    if CALL_LIST_CSV.exists():  # 途中で止まっても続きから
        with open(CALL_LIST_CSV, encoding="utf-8-sig", newline="") as f:
            done = {r["URL"]: r for r in csv.DictReader(f)}
    col = Collector(log=log)
    out = []
    for r in targets():
        url = r["URL"]
        if url in done and done[url].get("電話番号"):
            out.append(dict(done[url], 送信結果=r["送信結果"]))
            continue
        texts, links = [], []
        got = col.fetch(url)
        if got:
            soup = BeautifulSoup(got[1], "lxml")
            pages = [soup]
            overview = col._find_overview_link(soup, got[0])
            if overview and (more := col.fetch(overview)):
                pages.append(BeautifulSoup(more[1], "lxml"))
            for p in pages:
                texts.append(nfkc(_page_text(p)))
                links += [a["href"] for a in p.select("a[href^='tel:']")]
            time.sleep(random.uniform(0.5, 1.5))
        c = companies.get(url, {})
        row = {"社名": r["社名"], "電話番号": find_phone(texts, links), "所在地": c.get("所在地", ""),
               "業種": c.get("業種", ""), "送信日": r["日時"][:10], "送信結果": r["送信結果"], "URL": url}
        log(f"  {row['社名']}: {row['電話番号'] or '（見つからず）'}")
        out.append(row)
        with open(CALL_LIST_CSV, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=CALL_FIELDS)
            w.writeheader()
            w.writerows(out)
    return len(out)
