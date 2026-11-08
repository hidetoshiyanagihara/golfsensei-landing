"""（任意）Instagram 公式 API からインサイトを取得して data/*.csv に書き込む。

- 使うのは Meta 公式の「Instagram API（Instagram ログイン）」の読み取りだけ。投稿・いいね・フォロー等の操作はしない
- トークンは環境変数 IG_GROWTH_TOKEN から読む（ファイルやコードには書かない）
- API が返さない指標（フォロワー外リーチ率など）は空欄のまま＝未取得
- 指標の名前は Meta の仕様変更で変わることがある。取れなかった指標は飛ばして続ける

手順は README の「インサイトの自動取得（任意）」。
"""
from __future__ import annotations

import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from common import FOLLOWERS_COLUMNS, FOLLOWERS_CSV, POSTS_LOG_COLUMNS, POSTS_LOG_CSV, read_csv, write_csv

API_VERSION = os.environ.get("IG_API_VERSION", "v23.0")
BASE = f"https://graph.instagram.com/{API_VERSION}"
JST = dt.timezone(dt.timedelta(hours=9))
# API の指標名 → 投稿実績の列名（倍率）
METRICS = {
    "views": ("再生数", 1), "reach": ("リーチ数", 1), "likes": ("いいね", 1), "comments": ("コメント", 1),
    "saved": ("保存", 1), "shares": ("シェア", 1), "profile_visits": ("プロフィールアクセス", 1),
    "follows": ("フォロー数", 1), "ig_reels_avg_watch_time": ("平均視聴時間(秒)", 0.001),
}
KIND = {"REELS": "リール", "CAROUSEL_ALBUM": "カルーセル", "FEED": "画像"}


def http_get(path: str, params: dict) -> dict:
    token = os.environ.get("IG_GROWTH_TOKEN", "").strip()
    if not token:
        raise RuntimeError("環境変数 IG_GROWTH_TOKEN が設定されていません（README の手順を参照）")
    q = urllib.parse.urlencode({**params, "access_token": token})
    try:
        with urllib.request.urlopen(f"{BASE}/{path}?{q}", timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"API エラー {e.code}: {body[:300]}") from None


def fetch_media(limit: int = 50) -> list[dict]:
    data = http_get("me/media", {"fields": "id,caption,media_type,media_product_type,permalink,timestamp,"
                                           "like_count,comments_count", "limit": limit})
    return data.get("data", [])


def fetch_insights(media_id: str) -> tuple[dict, list[str]]:
    """まとめて取得し、失敗したら 1 指標ずつ取り直す（その投稿の種類で使えない指標があるため）。"""
    got, skipped = {}, []

    def parse(resp):
        for m in resp.get("data", []):
            vals = m.get("values") or [{}]
            v = m.get("total_value", {}).get("value", vals[0].get("value"))
            if isinstance(v, (int, float)):
                got[m["name"]] = v

    try:
        parse(http_get(f"{media_id}/insights", {"metric": ",".join(METRICS)}))
    except RuntimeError:
        for name in METRICS:
            try:
                parse(http_get(f"{media_id}/insights", {"metric": name}))
            except RuntimeError:
                skipped.append(name)
    return got, skipped


def run(days: int = 30) -> str:
    logs = read_csv(POSTS_LOG_CSV)
    by_url = {r.get("投稿URL", "").strip(): r for r in logs if r.get("投稿URL", "").strip()}
    today = dt.datetime.now(JST).date()
    report, unmatched = [], []
    for m in fetch_media():
        ts = dt.datetime.strptime(m["timestamp"], "%Y-%m-%dT%H:%M:%S%z").astimezone(JST)
        if (today - ts.date()).days > days:
            continue
        kind = KIND.get(m.get("media_product_type") or "", KIND.get(m.get("media_type") or "", ""))
        if m.get("media_type") == "CAROUSEL_ALBUM":
            kind = "カルーセル"
        row = by_url.get(m["permalink"])
        if row is None:  # URL 未記入なら、同じ日・同じ形式の予定が 1 つだけのときに結びつける
            cands = [r for r in logs if r.get("投稿日") == ts.date().isoformat() and r.get("形式") == kind
                     and not r.get("投稿URL", "").strip()]
            if len(cands) == 1:
                row = cands[0]
                row["投稿URL"] = m["permalink"]
            else:
                unmatched.append(f"{ts:%m/%d %H:%M} {kind} {m['permalink']}")
                continue
        vals, skipped = fetch_insights(m["id"])
        if "likes" not in vals and m.get("like_count") is not None:
            vals["likes"] = m["like_count"]
        if "comments" not in vals and m.get("comments_count") is not None:
            vals["comments"] = m["comments_count"]
        for api_name, (col, mult) in METRICS.items():
            if api_name in vals:
                v = vals[api_name] * mult
                row[col] = str(round(v, 1) if mult != 1 else int(v))
        row["時刻"] = row.get("時刻") or ts.strftime("%H:%M")
        row["計測日"] = today.isoformat()
        report.append(f"{row['投稿ID']}：{len(vals)} 指標を更新" + (f"（取得できず：{', '.join(skipped)}）" if skipped else ""))
    write_csv(POSTS_LOG_CSV, logs, POSTS_LOG_COLUMNS)

    # フォロワー数（今日の行がなければ追加）
    me = http_get("me", {"fields": "username,followers_count,media_count"})
    fol = read_csv(FOLLOWERS_CSV)
    if me.get("followers_count") is not None and not any(r.get("日付") == today.isoformat() for r in fol):
        fol.append({"日付": today.isoformat(), "フォロワー数": str(me["followers_count"]), "メモ": "API"})
        fol.sort(key=lambda r: r.get("日付", ""))
        write_csv(FOLLOWERS_CSV, fol, FOLLOWERS_COLUMNS)
        report.append(f"フォロワー数 {me['followers_count']} を記録")
    if unmatched:
        report.append("投稿実績と結びつけられなかった投稿（投稿実績の「投稿URL」に URL を入れると次回から取得）：")
        report += [f"  - {u}" for u in unmatched]
    return "\n".join(report) or "取得対象の投稿がありません"
