"""CSV の読み書き・文字数チェック・投稿対象の選定など共通処理。"""
import csv
import os
import re
import unicodedata
from datetime import datetime, timedelta

import config

POST_FIELDS = ["ID", "予定日時", "媒体", "本文", "画像URL"]
RESULT_FIELDS = ["ID", "媒体", "予定日時", "結果", "投稿ID・理由", "日時", "モード"]

RESULT_SUCCESS = "成功"
RESULT_SKIP = "スキップ"
RESULT_FAIL = "失敗"
MODE_TEST = "テスト"
MODE_LIVE = "本番"

DATE_FORMATS = ("%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M")

_URL_RE = re.compile(r"https?://\S+")
HASHTAG_RE = re.compile(r"(?<![\w#])#([^\s#、。,.!?！？()（）\[\]「」]+)")


# ---------------------------------------------------------------- CSV
def read_csv(path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [{k: (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(f)]


def load_posts() -> list[dict]:
    return read_csv(config.POSTS_CSV)


def load_results() -> list[dict]:
    return read_csv(config.RESULT_CSV)


def record_result(post: dict, result: str, detail: str, mode: str) -> None:
    new = not config.RESULT_CSV.exists()
    with open(config.RESULT_CSV, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=RESULT_FIELDS)
        if new:
            w.writeheader()
        w.writerow({
            "ID": post.get("ID", ""), "媒体": post.get("媒体", ""), "予定日時": post.get("予定日時", ""),
            "結果": result, "投稿ID・理由": detail, "日時": f"{datetime.now():%Y-%m-%d %H:%M:%S}",
            "モード": mode,
        })


def load_env() -> None:
    """sns/.env の KEY=VALUE を環境変数に読み込む（既に設定済みの値は上書きしない）。"""
    if not config.ENV_FILE.exists():
        return
    for line in config.ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


# ---------------------------------------------------------------- 本文
def parse_time(text: str):
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    return None


def build_text(post: dict) -> str:
    """CSV 上の \\n を改行に、{LP} を流入元付きの LP URL に置換する。"""
    text = post.get("本文", "").replace("\\n", "\n")
    return text.replace("{LP}", f"{config.LP_URL}?src={post.get('媒体', '')}")


def x_length(text: str) -> int:
    """X の重み付き文字数（URL は 23、ラテン文字等は 1、全角・絵文字は 2）。"""
    n = 0
    for part in _URL_RE.split(text):
        for ch in unicodedata.normalize("NFC", part):
            cp = ord(ch)
            light = (cp <= 0x10FF or 0x2000 <= cp <= 0x200D or 0x2010 <= cp <= 0x201F
                     or 0x2032 <= cp <= 0x2037)
            n += 1 if light else 2
    return n + 23 * len(_URL_RE.findall(text))


def text_length(platform: str, text: str) -> int:
    return x_length(text) if platform == "x" else len(text)


def hashtags(text: str) -> list[str]:
    return HASHTAG_RE.findall(text)


def validate(post: dict) -> list[str]:
    """投稿 1 件の問題点を返す（空なら問題なし）。"""
    errors = []
    platform = post.get("媒体", "")
    if not post.get("ID"):
        errors.append("ID が空")
    if platform not in config.PLATFORMS:
        errors.append(f"媒体は {'/'.join(config.PLATFORMS)} のいずれか（{platform or '空'}）")
    if parse_time(post.get("予定日時", "")) is None:
        errors.append("予定日時は 2026-11-01 09:00 の形式")
    text = build_text(post)
    if not text.strip():
        errors.append("本文が空")
    elif platform in config.MAX_LENGTH:
        n, limit = text_length(platform, text), config.MAX_LENGTH[platform]
        if n > limit:
            errors.append(f"本文が長すぎる（{n}/{limit}）")
    if platform in config.MAX_HASHTAGS and len(hashtags(text)) > config.MAX_HASHTAGS[platform]:
        errors.append(f"ハッシュタグは {config.MAX_HASHTAGS[platform]} 個まで")
    if platform == "instagram" and not post.get("画像URL", "").startswith("https://"):
        errors.append("Instagram は画像URL（https:// で公開されている JPEG）が必須")
    return errors


# ---------------------------------------------------------------- 対象の選定
def done_keys(results: list[dict], mode: str) -> set:
    """処理済みの (ID, 媒体)。本番は成功のみ・テストはすべてを処理済みとする。"""
    return {(r.get("ID"), r.get("媒体")) for r in results
            if r.get("モード") == mode and (mode == MODE_TEST or r.get("結果") == RESULT_SUCCESS)}


def posted_today(results: list[dict], platform: str, now: datetime) -> int:
    today = f"{now:%Y-%m-%d}"
    return sum(1 for r in results if r.get("モード") == MODE_LIVE and r.get("結果") == RESULT_SUCCESS
               and r.get("媒体") == platform and r.get("日時", "").startswith(today))


def due_posts(posts: list[dict], results: list[dict], mode: str, now: datetime,
              platform: str = "") -> tuple[list[dict], list[tuple[dict, str]]]:
    """予定日時を過ぎた未投稿の投稿を古い順に返す。あわせて自動では出さない投稿と理由を返す。"""
    done = done_keys(results, mode)
    due, late = [], []
    for p in posts:
        if platform and p.get("媒体") != platform:
            continue
        if (p.get("ID"), p.get("媒体")) in done:
            continue
        at = parse_time(p.get("予定日時", ""))
        if at is None or at > now:
            continue
        if now - at > timedelta(hours=config.LATE_LIMIT_HOURS):
            late.append((p, f"予定日時から {config.LATE_LIMIT_HOURS} 時間以上経過"))
            continue
        due.append(p)
    due.sort(key=lambda p: parse_time(p["予定日時"]))
    return due, late
