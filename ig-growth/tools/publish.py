#!/usr/bin/env python3
"""カレンダーどおりに Instagram へ自動投稿する（Meta 公式「Instagram API（Instagram ログイン）」のみ使用）。

  python tools/publish.py plan          # これから投稿する予定と、いま投稿対象のものを表示（API は呼ばない）
  python tools/publish.py run           # 予定時刻を過ぎた投稿を 1 件ずつ投稿（GitHub Actions が 20 分ごとに実行）
  python tools/publish.py run --dry-run # 投稿せずに、何をするかだけ表示

仕組み
- content/calendar_30days.csv のリール・カルーセルを「日付＋時刻（日本時間）」に投稿する
- 投稿の 40 分後に、その投稿のお知らせストーリーズ（output/stories/auto/ID.jpg）を投稿する
- 画像・動画は Vercel で公開されている URL（brand.json の media_base_url）から Instagram が取りに来る
- 予定から 6 時間以上遅れている（トークン登録が遅れた等）ときは、未投稿の予定を丸ごと後ろへずらす（まとめて投稿しない）
- 1 回の実行でフィード投稿は 1 件まで。失敗は 3 回まで再試行し、だめなら飛ばしてエラーで知らせる
- 止めたいときは brand.json の "auto_post" を false にする
- いいね・フォロー・DM・コメントの自動化は一切しない
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import content  # noqa: E402
from common import (CALENDAR_CSV, DATA, POSTS_LOG_COLUMNS, POSTS_LOG_CSV, ROOT, load_brand, read_csv,  # noqa: E402
                    write_csv)

JST = dt.timezone(dt.timedelta(hours=9))
STATE_JSON = DATA / "published.json"
GRACE = dt.timedelta(hours=6)
STORY_DELAY = dt.timedelta(minutes=40)
MAX_TRIES = 3
API_VERSION = os.environ.get("IG_API_VERSION", "v23.0")
BASE = f"https://graph.instagram.com/{API_VERSION}"


class PublishError(Exception):
    pass


# ---------------------------------------------------------------- HTTP（テストで差し替える）
def _token() -> str:
    t = os.environ.get("IG_GROWTH_TOKEN", "").strip()
    if not t:
        raise PublishError("IG_GROWTH_TOKEN が未設定です")
    return t


def api(method: str, path: str, params: dict | None = None) -> dict:
    params = {**(params or {}), "access_token": _token()}
    data = urllib.parse.urlencode(params).encode()
    url = f"{BASE}/{path}"
    if method == "GET":
        req = urllib.request.Request(f"{url}?{data.decode()}")
    else:
        req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise PublishError(f"API エラー {e.code}（{path}）: {e.read().decode(errors='replace')[:400]}") from None


def url_ok(url: str) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status == 200
    except Exception:
        return False


def sleep(sec: float) -> None:
    time.sleep(sec)


# ---------------------------------------------------------------- 予定
def load_state() -> dict:
    return json.loads(STATE_JSON.read_text(encoding="utf-8")) if STATE_JSON.exists() else {}


def save_state(st: dict) -> None:
    STATE_JSON.parent.mkdir(parents=True, exist_ok=True)
    STATE_JSON.write_text(json.dumps(st, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _when(row: dict) -> dt.datetime | None:
    try:
        d = dt.date.fromisoformat(row["日付"])
        h, m = map(int, row["時刻"].split(":"))
    except (KeyError, ValueError):
        return None
    return dt.datetime(d.year, d.month, d.day, h, m, tzinfo=JST)


def jobs() -> list[dict]:
    brand = load_brand()
    base = brand.get("media_base_url", "").rstrip("/")
    items = {it.id: it for it in content.load_items()}
    out = []
    for row in read_csv(CALENDAR_CSV):
        if row.get("形式") not in ("リール", "カルーセル"):
            continue
        it = items.get(row["ID"])
        when = _when(row)
        if it is None or when is None:
            continue
        job = {"id": it.id, "kind": "reel" if it.kind == "reel" else "carousel", "when": when,
               "caption": it.full_caption()}
        if it.kind == "reel":
            job["video_url"] = f"{base}/videos/{it.id}.mp4"
            job["cover_url"] = f"{base}/reels/{it.id}_cover.jpg"
            job["urls"] = [job["video_url"], job["cover_url"]]
        else:
            job["image_urls"] = [f"{base}/carousels/{it.id}/{i:02d}.jpg" for i in range(1, len(it.slides) + 1)]
            job["urls"] = job["image_urls"]
        out.append(job)
        story = {"id": f"S-{it.id}", "kind": "story", "when": when + STORY_DELAY, "after": it.id,
                 "image_url": f"{base}/stories/auto/{it.id}.jpg"}
        story["urls"] = [story["image_url"]]
        out.append(story)
    out.sort(key=lambda j: j["when"])
    return out


def reschedule_if_late(now: dt.datetime, state: dict) -> str | None:
    """最初の未投稿のフィード投稿が 6 時間以上遅れていたら、未投稿の予定を日単位で後ろへずらす。"""
    pending = [j for j in jobs() if j["kind"] != "story" and not state.get(j["id"], {}).get("media_id")
               and not state.get(j["id"], {}).get("gave_up")]
    if not pending or now - pending[0]["when"] <= GRACE:
        return None
    first = pending[0]
    delta = now - first["when"]
    days = delta.days + (1 if delta - dt.timedelta(days=delta.days) > dt.timedelta(0) else 0)  # 切り上げ
    cutoff = first["when"].date()
    posted_ids = {k for k, v in state.items() if v.get("media_id")}
    rows = read_csv(CALENDAR_CSV)
    moved = set()
    for r in rows:
        try:
            d = dt.date.fromisoformat(r["日付"])
        except ValueError:
            continue
        if d >= cutoff and r["ID"] not in posted_ids:
            nd = d + dt.timedelta(days=days)
            r["日付"], r["曜日"] = nd.isoformat(), "月火水木金土日"[nd.weekday()]
            moved.add(r["ID"])
    write_csv(CALENDAR_CSV, rows, list(rows[0].keys()))
    logs = read_csv(POSTS_LOG_CSV)
    for r in logs:
        if r["投稿ID"] in moved and not r.get("投稿URL"):
            d = dt.date.fromisoformat(r["投稿日"]) + dt.timedelta(days=days)
            r["投稿日"] = d.isoformat()
    write_csv(POSTS_LOG_CSV, logs, POSTS_LOG_COLUMNS)
    if not posted_ids:  # まだ 1 件も投稿していなければ、運用開始日もずらす
        bp = ROOT / "brand.json"
        b = json.loads(bp.read_text(encoding="utf-8"))
        b["start_date"] = (dt.date.fromisoformat(b["start_date"]) + dt.timedelta(days=days)).isoformat()
        bp.write_text(json.dumps(b, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return f"予定より遅れていたため、未投稿の予定 {len(moved)} 件を {days} 日後ろへずらしました（{first['id']} から）"


def due(now: dt.datetime, state: dict) -> list[dict]:
    out = []
    for j in jobs():
        s = state.get(j["id"], {})
        if s.get("media_id") or s.get("gave_up") or j["when"] > now:
            continue
        if j["kind"] == "story":
            if not state.get(j["after"], {}).get("media_id"):
                continue
            if now - j["when"] > dt.timedelta(hours=12):   # 古いお知らせは出さない
                continue
        out.append(j)
    return out


# ---------------------------------------------------------------- 投稿
def _wait_finished(container: str, tries: int = 60, every: float = 10) -> None:
    for _ in range(tries):
        st = api("GET", container, {"fields": "status_code,status"})
        code = st.get("status_code")
        if code == "FINISHED":
            return
        if code in ("ERROR", "EXPIRED"):
            raise PublishError(f"Instagram 側の処理エラー: {st}")
        sleep(every)
    raise PublishError("Instagram 側の処理が時間内に終わりませんでした")


def publish_job(job: dict) -> dict:
    uid = api("GET", "me", {"fields": "user_id,username"})["user_id"]
    if job["kind"] == "reel":
        c = api("POST", f"{uid}/media", {"media_type": "REELS", "video_url": job["video_url"],
                                         "cover_url": job["cover_url"], "caption": job["caption"][:2200],
                                         "share_to_feed": "true"})["id"]
        _wait_finished(c)
    elif job["kind"] == "carousel":
        children = []
        for u in job["image_urls"]:
            children.append(api("POST", f"{uid}/media", {"image_url": u, "is_carousel_item": "true"})["id"])
        for ch in children:
            _wait_finished(ch, tries=30, every=3)
        c = api("POST", f"{uid}/media", {"media_type": "CAROUSEL", "children": ",".join(children),
                                         "caption": job["caption"][:2200]})["id"]
        _wait_finished(c, tries=30, every=5)
    else:
        c = api("POST", f"{uid}/media", {"media_type": "STORIES", "image_url": job["image_url"]})["id"]
        _wait_finished(c, tries=30, every=3)
    media_id = api("POST", f"{uid}/media_publish", {"creation_id": c})["id"]
    info = {}
    try:
        info = api("GET", media_id, {"fields": "permalink,timestamp"})
    except PublishError:
        pass
    return {"media_id": media_id, "permalink": info.get("permalink", ""),
            "published_at": dt.datetime.now(JST).isoformat(timespec="minutes")}


def record(job: dict, result: dict) -> None:
    if job["kind"] == "story":
        return
    now = dt.datetime.now(JST)
    logs = read_csv(POSTS_LOG_CSV)
    for r in logs:
        if r["投稿ID"] == job["id"]:
            r["投稿URL"] = result.get("permalink", "")
            r["投稿日"], r["時刻"] = now.date().isoformat(), now.strftime("%H:%M")
    write_csv(POSTS_LOG_CSV, logs, POSTS_LOG_COLUMNS)
    rows = read_csv(CALENDAR_CSV)
    for r in rows:
        if r["ID"] == job["id"]:
            r["状態"] = "投稿済み"
    write_csv(CALENDAR_CSV, rows, list(rows[0].keys()))


def run(now: dt.datetime | None = None, dry_run: bool = False) -> int:
    brand = load_brand()
    if not brand.get("auto_post", True):
        print("brand.json の auto_post が false のため、自動投稿は止まっています")
        return 0
    if not os.environ.get("IG_GROWTH_TOKEN", "").strip() and not dry_run:
        print("IG_GROWTH_TOKEN が未設定のため、何もしません")
        return 0
    now = now or dt.datetime.now(JST)
    state = load_state()
    msg = None if dry_run else reschedule_if_late(now, state)
    if msg:
        print(msg)
    todo = due(now, state)
    feed_done = False
    failed = False
    for job in todo:
        if job["kind"] != "story" and feed_done:
            continue   # フィード投稿は 1 回の実行で 1 件まで
        missing = [u for u in job["urls"] if not url_ok(u)]
        if missing:
            print(f"{job['id']}：素材がまだ公開されていません（デプロイ待ち）→ 次回に回します：{missing[0]}")
            continue
        if dry_run:
            print(f"[dry-run] {job['id']}（{job['kind']}）を投稿します（予定 {job['when']:%m/%d %H:%M}）")
            feed_done = feed_done or job["kind"] != "story"
            continue
        s = state.setdefault(job["id"], {})
        try:
            res = publish_job(job)
            state[job["id"]] = res
            record(job, res)
            print(f"{job['id']}：投稿しました {res.get('permalink', '')}")
            feed_done = feed_done or job["kind"] != "story"
        except PublishError as e:
            s["tries"] = s.get("tries", 0) + 1
            s["last_error"] = str(e)[:500]
            if s["tries"] >= MAX_TRIES:
                s["gave_up"] = True
            print(f"{job['id']}：失敗（{s['tries']}回目）{e}")
            failed = True
        save_state(state)
    if not todo:
        nxt = next((j for j in jobs() if not state.get(j["id"], {}).get("media_id") and j["when"] > now), None)
        print("いま投稿するものはありません" + (f"（次は {nxt['id']} {nxt['when']:%m/%d %H:%M}）" if nxt else ""))
    return 1 if failed else 0


def plan() -> None:
    state = load_state()
    now = dt.datetime.now(JST)
    for j in jobs():
        s = state.get(j["id"], {})
        mark = "済" if s.get("media_id") else ("中止" if s.get("gave_up") else ("期限" if j["when"] <= now else "予定"))
        w = j["when"]
        print(f"{mark:2} {w:%m/%d} {'月火水木金土日'[w.weekday()]} {w:%H:%M} {j['id']:6} {j['kind']}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan")
    p = sub.add_parser("run")
    p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "plan":
        plan()
        return 0
    return run(dry_run=a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
