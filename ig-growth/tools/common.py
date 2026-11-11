"""ig-growth 共通：パス・ブランド設定・CSV の読み書き。"""
from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # ig-growth/
CONTENT = ROOT / "content"
DATA = ROOT / "data"
OUTPUT = ROOT / "output"
REPORTS = ROOT / "reports"
FONTS = ROOT / "fonts"

CALENDAR_CSV = CONTENT / "calendar_30days.csv"
CAPTIONS_CSV = CONTENT / "captions.csv"
IDEAS_CSV = CONTENT / "ideas_backlog.csv"
POSTS_LOG_CSV = DATA / "posts_log.csv"
FOLLOWERS_CSV = DATA / "followers_daily.csv"
IMPROVEMENTS_CSV = DATA / "improvements.csv"
PROMPTS_MD = ROOT / "assets" / "プロンプト集_無料配布.md"
WORKBOOK_XLSX = DATA / "管理シート.xlsx"

# 投稿実績の列（この順で保存する）。数値の列が空欄＝未取得
POSTS_LOG_COLUMNS = [
    "投稿ID", "投稿日", "時刻", "形式", "柱", "テーマ", "フック型", "尺(秒)", "トライアル", "投稿URL", "計測日",
    "再生数", "リーチ数", "フォロワー外リーチ率(%)", "平均視聴時間(秒)", "視聴維持率(%)",
    "いいね", "コメント", "保存", "シェア", "プロフィールアクセス", "フォロー数", "メモ",
]
METRIC_COLUMNS = POSTS_LOG_COLUMNS[11:22]
FOLLOWERS_COLUMNS = ["日付", "フォロワー数", "プロフィールアクセス", "リンクのクリック", "メモ"]


def load_brand() -> dict:
    return json.loads((ROOT / "brand.json").read_text(encoding="utf-8"))


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    """Excel・Google スプレッドシートで文字化けしないよう BOM 付き UTF-8 で保存する。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in columns})


def to_number(v) -> float | None:
    """空欄・「未取得」・数字でないものは None（＝未取得）。カンマと % は取り除く。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").replace("%", "").replace("％", "")
    if s in ("", "未取得", "-", "—"):
        return None
    try:
        return float(s)
    except ValueError:
        return None
