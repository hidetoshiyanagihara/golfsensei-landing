"""CSV の読み書き・社名/URL の正規化など共通処理。"""
import csv
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import config

COMPANY_FIELDS = ["社名", "URL", "所在地", "業種"]
NG_FIELDS = ["社名", "URL", "理由"]
RESULT_FIELDS = ["社名", "URL", "結果", "理由", "日時", "モード"]

RESULT_SUCCESS = "成功"
RESULT_SKIP = "スキップ"
RESULT_FAIL = "失敗"
MODE_TEST = "テスト"
MODE_LIVE = "本番"
# 送信ボタンを押した後に完了が確認できなかった失敗の理由はこの接頭辞で始める。
# 送信された可能性があるため、再送防止の対象（送信済み扱い）にする。
SUBMITTED_PREFIX = "送信後"

_CORP_WORDS = r"(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|\(株\)|\(有\)|\(同\)|㈱|㈲)"


def nfkc(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "")


def normalize_name(name: str) -> str:
    """社名の重複判定用キー（法人格・空白・記号を除去）。"""
    s = nfkc(name)
    s = re.sub(_CORP_WORDS, "", s)
    s = re.sub(r"[\s・\-‐－ー（）()「」『』【】\[\].,、。]", "", s)
    return s.lower()


def domain_of(url: str) -> str:
    """重複判定用のホスト名（www. を除去、小文字）。"""
    if not url:
        return ""
    if "://" not in url:
        url = "http://" + url
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def is_excluded_domain(url: str) -> bool:
    host = domain_of(url)
    if not host:
        return True
    for d in config.EXCLUDED_DOMAINS:
        if d.endswith(".") or "." not in d:
            if d in host:
                return True
        elif host == d or host.endswith("." + d):
            return True
    return False


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(f)]


def _ensure_header(path: Path, fields: list[str]) -> None:
    if not path.exists() or path.stat().st_size == 0:
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            csv.writer(f).writerow(fields)


def append_rows(path: Path, fields: list[str], rows: list[dict]) -> None:
    _ensure_header(path, fields)
    with open(path, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


class Registry:
    """社名・ドメインで会社を照合するための集合。"""

    def __init__(self, rows: list[dict] = ()):
        self.names: set[str] = set()
        self.domains: set[str] = set()
        for r in rows:
            self.add(r.get("社名", ""), r.get("URL", ""))

    def add(self, name: str, url: str) -> None:
        if name and normalize_name(name):
            self.names.add(normalize_name(name))
        if url and domain_of(url):
            self.domains.add(domain_of(url))

    def contains(self, name: str, url: str) -> bool:
        return bool(
            (name and normalize_name(name) in self.names)
            or (url and domain_of(url) in self.domains)
        )


def load_companies() -> list[dict]:
    return read_csv(config.COMPANIES_CSV)


def load_ng() -> Registry:
    return Registry(read_csv(config.NG_LIST_CSV))


def load_results() -> list[dict]:
    return read_csv(config.RESULT_CSV)


def is_sent_row(row: dict) -> bool:
    """本番で送信済み（または送信された可能性がある）行か。"""
    if row.get("モード", MODE_LIVE) != MODE_LIVE:
        return False
    if row.get("結果") == RESULT_SUCCESS:
        return True
    return row.get("結果") == RESULT_FAIL and row.get("理由", "").startswith(SUBMITTED_PREFIX)


def sent_registry(results: list[dict]) -> Registry:
    return Registry([r for r in results if is_sent_row(r)])


def sent_today_count(results: list[dict]) -> int:
    today = datetime.now().strftime("%Y-%m-%d")
    return sum(1 for r in results if is_sent_row(r) and r.get("日時", "").startswith(today))


def record_result(name: str, url: str, result: str, reason: str, mode: str) -> dict:
    row = {"社名": name, "URL": url, "結果": result, "理由": reason, "日時": now_str(), "モード": mode}
    append_rows(config.RESULT_CSV, RESULT_FIELDS, [row])
    return row


def build_message(company_name: str) -> str:
    text = config.MESSAGE_TXT.read_text(encoding="utf-8")
    return text.replace("{社名}", company_name).strip() + "\n"


def launch_chromium(pw, headless: bool = True):
    """Chromium を起動する。CHROMIUM_PATH を指定するとそのブラウザ実行ファイルを使う。"""
    return pw.chromium.launch(headless=headless, executable_path=os.environ.get("CHROMIUM_PATH") or None)
