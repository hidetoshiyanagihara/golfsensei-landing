"""CSV の読み書き・社名/URL の正規化など共通処理。"""
import contextlib
import csv
import hashlib
import re
import signal
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


# 暗号化した ng_list.csv とは別に、どの送り方でも送らない会社。リポジトリは公開なので
# 社名・ドメインそのものではなく指紋（sha256 の先頭16桁）で持つ
ALWAYS_NG = {
    "0d2893ee54004ea8",  # 2026-11-12 柳原さん指示（社名）
    "6b00a4f10e33d620",  # 同（ドメイン）
}


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class NgRegistry(Registry):
    def contains(self, name: str, url: str) -> bool:
        return super().contains(name, url) or bool(
            (name and fingerprint(normalize_name(name)) in ALWAYS_NG)
            or (url and fingerprint(domain_of(url)) in ALWAYS_NG))


def load_ng() -> Registry:
    return NgRegistry(read_csv(config.NG_LIST_CSV))


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


class CompanyTimeout(Exception):
    """1社の処理が時間内に終わらなかった"""


COMPANY_LIMIT_SEC = 180   # 送れるか確かめる・入力して送る、それぞれの上限（2026-11-12：サイトによっては無限に待ち続けるため）


def _kill_own_browsers() -> None:
    """このプログラムが起動したブラウザ（子孫プロセスのうち chrome/chromium）だけを止める"""
    import os
    me = os.getpid()
    parent = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                parent[int(d)] = int(open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                pass
    for pid in parent:
        p, depth = pid, 0
        while p in parent and p != me and depth < 20:
            p, depth = parent[p], depth + 1
        if p != me or pid == me:
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="ignore").lower()
        except OSError:
            continue
        if "chrom" in cmd:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


@contextlib.contextmanager
def time_limit(seconds: int):
    """seconds 秒たっても終わらなければ、ブラウザを止めて CompanyTimeout にする。
    （ページの中の処理が固まると Playwright は待ち続け、シグナルでも抜けられないため。2026-11-12）"""
    import threading
    fired = threading.Event()
    timer = threading.Timer(seconds, lambda: (fired.set(), _kill_own_browsers()))
    timer.daemon = True
    timer.start()
    try:
        yield
    except Exception as e:
        timer.cancel()
        if fired.is_set():
            raise CompanyTimeout() from e
        raise
    timer.cancel()
    if fired.is_set():
        raise CompanyTimeout()


class Browser:
    """送信に使うブラウザ。1社で固まったら作り直して、次の会社に進めるようにする"""

    def __init__(self, pw, headed: bool = False):
        import os
        self.pw, self.headed, self.path = pw, headed, os.environ.get("CHROMIUM_PATH") or None
        self._open()

    def _open(self) -> None:
        self.browser = self.pw.chromium.launch(headless=not self.headed, executable_path=self.path)
        self.ctx = self.browser.new_context(locale="ja-JP", user_agent=config.USER_AGENT,
                                            viewport={"width": 1280, "height": 900})
        self.ctx.set_default_timeout(config.PAGE_TIMEOUT_MS)

    def new_page(self):
        page = self.ctx.new_page()
        page.on("dialog", lambda d: d.accept())   # 「送信しますか？」等の確認ダイアログ
        return page

    def close_page(self, page) -> None:
        """ページを閉じる。閉じられなければブラウザごと作り直す"""
        try:
            with time_limit(20):
                page.close()
        except Exception:
            self.restart()

    def restart(self) -> None:
        self.close()
        self._open()

    def close(self) -> None:
        try:
            with time_limit(20):
                self.ctx.close()
                self.browser.close()
        except Exception:
            pass


def start_company(name: str, url: str, mode: str) -> None:
    """これから処理する会社を書いておく。処理が終われば消す。残っていたら、その会社で止まったということ"""
    import json
    config.INFLIGHT_JSON.write_text(json.dumps({"社名": name, "URL": url, "モード": mode}, ensure_ascii=False),
                                    encoding="utf-8")


def finish_company() -> None:
    config.INFLIGHT_JSON.unlink(missing_ok=True)


def skip_stuck(log=print) -> None:
    """前の回に処理の途中で止まった（時間切れで打ち切られた）会社を、スキップとして記録して二度と試さない。
    同じ会社で毎回止まり、ほかの会社に送れなくなるのを防ぐ（2026-11-12）"""
    import json
    if not config.INFLIGHT_JSON.exists():
        return
    try:
        row = json.loads(config.INFLIGHT_JSON.read_text(encoding="utf-8"))
        record_result(row["社名"], row["URL"], RESULT_SKIP, "前回の処理中に止まった（時間切れ）", row.get("モード", MODE_LIVE))
        log("前回の処理中に止まった会社を1社、スキップにしました")
    except (ValueError, KeyError):
        pass
    finish_company()


def build_message(company_name: str) -> str:
    text = config.MESSAGE_TXT.read_text(encoding="utf-8")
    return text.replace("{社名}", company_name).strip() + "\n"
