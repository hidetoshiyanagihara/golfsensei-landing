"""オフラインの通しテスト（外部サービスには一切アクセスしない）。

  python tests/test_igtool.py
"""
from __future__ import annotations

import datetime as dt
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import common  # noqa: E402
import content  # noqa: E402
import insights  # noqa: E402
import report  # noqa: E402
import sheets  # noqa: E402

PASSED = []


def test(fn):
    fn()
    PASSED.append(fn.__name__)
    print("ok", fn.__name__)
    return fn


@test
def parse_all_content():
    items = content.load_items()
    reels = [i for i in items if i.kind == "reel"]
    cars = [i for i in items if i.kind == "carousel"]
    assert len(reels) >= 10 and len(cars) >= 5, (len(reels), len(cars))
    for r in reels:
        assert r.cover.get("title"), r.id
        assert r.telops and r.caption and 1 <= len(r.hashtags) <= 5, r.id
    for c in cars:
        assert c.slides[0]["type"] == "cover", c.id
        assert all(s["type"] in {"cover", "text", "list", "prompt", "chat", "compare", "summary", "cta"}
                   for s in c.slides), c.id


@test
def slide_parser_multiline():
    s = content.parse_slides("=== prompt\ntitle: A\\nB\nprompt: |\n  1行目\n  2行目\n=== list\nitems:\n- x｜y\n- z\n")
    assert s[0]["title"] == "A\nB" and s[0]["prompt"] == "1行目\n2行目"
    assert s[1]["items"] == ["x｜y", "z"]


@test
def srt_format():
    srt = content.to_srt([content.Telop(0, 1.5, "あ"), content.Telop(1.5, 62.25, "い\nう")])
    assert "00:00:00,000 --> 00:00:01,500" in srt and "00:00:01,500 --> 00:01:02,250" in srt


@test
def prompt_numbers_cover_references():
    nums = content.prompt_numbers()
    assert {f"{i:02d}" for i in range(0, 31)} <= nums


@test
def report_marks_missing_as_untaken():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        posts, fol = tmp / "posts.csv", tmp / "fol.csv"
        rows = [
            {"投稿ID": "R01", "投稿日": "2026-11-16", "形式": "リール", "柱": "E 頼み方の型", "フック型": "一言だけ",
             "投稿URL": "https://x/1", "再生数": "1000", "リーチ数": "800", "保存": "16", "シェア": "8",
             "プロフィールアクセス": "40", "フォロー数": "8"},
            {"投稿ID": "R02", "投稿日": "2026-11-17", "形式": "リール", "柱": "D AIのやらかし注意", "フック型": "損失回避",
             "投稿URL": "https://x/2", "再生数": "5000", "リーチ数": "4000", "保存": "20", "シェア": "",
             "プロフィールアクセス": "50", "フォロー数": "4"},
            {"投稿ID": "R03", "投稿日": "2026-11-18", "形式": "リール", "柱": "A コピペ1発", "投稿URL": "https://x/3",
             "再生数": "300"},  # リーチ未取得
        ]
        common.write_csv(posts, rows, common.POSTS_LOG_COLUMNS)
        common.write_csv(fol, [{"日付": "2026-11-15", "フォロワー数": "0"}, {"日付": "2026-11-18", "フォロワー数": "30"}],
                         common.FOLLOWERS_COLUMNS)
        report.POSTS_LOG_CSV, report.FOLLOWERS_CSV = posts, fol
        md = report.build(dt.date(2026, 11, 16), dt.date(2026, 11, 22))
        assert "未取得" in md
        assert "R03" in md and "フォロー率を計算できない投稿" in md
        assert "10.00" in md          # R01：8/800*1000
        assert "3 本未満のため、自動判定はしません" in md  # 少ないサンプルで判断しない
        assert "純増：30人" in md
        x = report.rates({"リーチ数": "", "保存": "3"})
        assert x["保存率(%)"] is None   # 推測しない


@test
def workbook_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        posts, fol, xlsx = tmp / "posts.csv", tmp / "fol.csv", tmp / "wb.xlsx"
        common.write_csv(posts, [{"投稿ID": "R01", "投稿日": "2026-11-16", "形式": "リール", "リーチ数": "800",
                                  "フォロー数": "8"}], common.POSTS_LOG_COLUMNS)
        common.write_csv(fol, [{"日付": "2026-11-16", "フォロワー数": "12"}], common.FOLLOWERS_COLUMNS)
        sheets.POSTS_LOG_CSV, sheets.FOLLOWERS_CSV = posts, fol
        sheets.export_workbook(xlsx)
        posts.unlink()
        fol.unlink()
        n1, n2 = sheets.import_workbook(xlsx)
        assert n1 == 1 and n2 == 1, (n1, n2)
        r = common.read_csv(posts)[0]
        assert r["リーチ数"] == "800" and r["フォロー数"] == "8" and r["再生数"] == ""
        assert common.read_csv(fol)[0]["フォロワー数"] == "12"


@test
def insights_merge_with_mock_api():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        posts, fol = tmp / "posts.csv", tmp / "fol.csv"
        common.write_csv(posts, [{"投稿ID": "R01", "投稿日": "2026-11-16", "形式": "リール", "保存": "99", "メモ": "手入力"}],
                         common.POSTS_LOG_COLUMNS)
        common.write_csv(fol, [], common.FOLLOWERS_COLUMNS)
        insights.POSTS_LOG_CSV, insights.FOLLOWERS_CSV = posts, fol
        today = dt.datetime.now(insights.JST).date()
        calls = []

        def fake_get(path, params):
            calls.append((path, params.get("metric")))
            if path == "me/media":
                ts = "2026-11-16T11:00:00+0000"  # JST 20:00
                return {"data": [{"id": "1", "media_type": "VIDEO", "media_product_type": "REELS",
                                  "permalink": "https://www.instagram.com/reel/abc/", "timestamp": ts,
                                  "like_count": 7, "comments_count": 2}]}
            if path == "1/insights":
                if params["metric"] == ",".join(insights.METRICS):
                    raise RuntimeError("API エラー 400: unsupported metric")   # まとめて取れない → 1 つずつ
                table = {"reach": 500, "views": 900, "saved": 12, "ig_reels_avg_watch_time": 6400}
                if params["metric"] not in table:
                    raise RuntimeError("API エラー 400")
                return {"data": [{"name": params["metric"], "values": [{"value": table[params["metric"]]}]}]}
            if path == "me":
                return {"followers_count": 42}
            raise AssertionError(path)

        insights.http_get = fake_get
        out = insights.run(days=10_000)
        r = common.read_csv(posts)[0]
        assert r["投稿URL"] == "https://www.instagram.com/reel/abc/"
        assert r["リーチ数"] == "500" and r["再生数"] == "900" and r["保存"] == "12"
        assert r["平均視聴時間(秒)"] == "6.4" and r["いいね"] == "7" and r["コメント"] == "2"
        assert r["フォロワー外リーチ率(%)"] == "" and r["フォロー数"] == ""   # 取れないものは空欄のまま
        assert r["メモ"] == "手入力" and r["時刻"] == "20:00" and r["計測日"] == today.isoformat()
        assert common.read_csv(fol)[0]["フォロワー数"] == "42"
        assert "取得できず" in out


@test
def publisher_schedule_and_posting():
    import json
    import shutil
    import publish
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for name in ("calendar_30days.csv",):
            shutil.copy(common.CALENDAR_CSV, tmp / name)
        shutil.copy(common.POSTS_LOG_CSV, tmp / "posts.csv")
        shutil.copy(common.ROOT / "brand.json", tmp / "brand.json")
        publish.CALENDAR_CSV, publish.POSTS_LOG_CSV = tmp / "calendar_30days.csv", tmp / "posts.csv"
        publish.STATE_JSON, publish.ROOT = tmp / "published.json", tmp
        import os
        os.environ["IG_GROWTH_TOKEN"] = "dummy"
        calls = []
        seq = iter(range(1, 10_000))

        def fake_api(method, path, params=None):
            calls.append((method, path, dict(params or {})))
            if path == "me":
                return {"user_id": "U1", "username": "x"}
            if path.endswith("/media"):
                return {"id": f"c{next(seq)}"}
            if path.endswith("/media_publish"):
                return {"id": f"m{next(seq)}"}
            if params and params.get("fields", "").startswith("status_code"):
                return {"status_code": "FINISHED"}
            if params and params.get("fields") == "permalink,timestamp":
                return {"permalink": f"https://www.instagram.com/p/{path}/"}
            raise AssertionError(path)

        publish.api, publish.url_ok, publish.sleep = fake_api, (lambda u: True), (lambda s: None)
        J = publish.JST
        # 1) 11/15 19:05：C02（カルーセル10枚）だけ投稿
        assert publish.run(dt.datetime(2026, 11, 15, 19, 5, tzinfo=J)) == 0
        st = json.loads(publish.STATE_JSON.read_text())
        assert list(st) == ["C02"] and st["C02"]["permalink"]
        kids = [c for c in calls if c[2].get("is_carousel_item") == "true"]
        assert len(kids) == 10 and kids[0][2]["image_url"].endswith("/carousels/C02/01.jpg")
        car = [c for c in calls if c[2].get("media_type") == "CAROUSEL"][0]
        assert car[2]["caption"].startswith("【保存版】") and "#プロンプト" in car[2]["caption"]
        log = {r["投稿ID"]: r for r in common.read_csv(publish.POSTS_LOG_CSV)}
        assert log["C02"]["投稿URL"].startswith("https://www.instagram.com/")
        # 2) 19:45：C01 とお知らせストーリーズ S-C02 を投稿（フィードは1件だけ）
        calls.clear()
        publish.run(dt.datetime(2026, 11, 15, 19, 45, tzinfo=J))
        st = json.loads(publish.STATE_JSON.read_text())
        assert {"C01", "S-C02"} <= set(st) and "S-C01" not in st
        assert any(c[2].get("media_type") == "STORIES" and c[2]["image_url"].endswith("/stories/auto/C02.jpg")
                   for c in calls)
        # 3) リール：動画と表紙の URL
        calls.clear()
        publish.run(dt.datetime(2026, 11, 16, 20, 5, tzinfo=J))
        reel = [c for c in calls if c[2].get("media_type") == "REELS"][0][2]
        assert reel["video_url"].endswith("/videos/R01.mp4") and reel["cover_url"].endswith("/reels/R01_cover.jpg")
        # 4) 素材が未公開なら投稿しない
        calls.clear()
        publish.url_ok = lambda u: False
        publish.run(dt.datetime(2026, 11, 17, 20, 5, tzinfo=J))
        assert not any(c[1].endswith("media_publish") for c in calls)
        # 5) 失敗は記録して終了コード 1
        publish.url_ok = lambda u: True

        def broken(method, path, params=None):
            raise publish.PublishError("API エラー 400")
        publish.api = broken
        assert publish.run(dt.datetime(2026, 11, 17, 20, 5, tzinfo=J)) == 1
        assert json.loads(publish.STATE_JSON.read_text())["R02"]["tries"] == 1


@test
def publisher_reschedules_when_started_late():
    import json
    import shutil
    import publish
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        shutil.copy(common.CALENDAR_CSV, tmp / "cal.csv")
        shutil.copy(common.POSTS_LOG_CSV, tmp / "posts.csv")
        shutil.copy(common.ROOT / "brand.json", tmp / "brand.json")
        publish.CALENDAR_CSV, publish.POSTS_LOG_CSV = tmp / "cal.csv", tmp / "posts.csv"
        publish.STATE_JSON, publish.ROOT = tmp / "published.json", tmp
        now = dt.datetime(2026, 11, 20, 10, 0, tzinfo=publish.JST)
        msg = publish.reschedule_if_late(now, {})
        assert msg and "5 日" in msg, msg
        cal = {r["ID"]: r for r in common.read_csv(publish.CALENDAR_CSV)}
        assert cal["C02"]["日付"] == "2026-11-20" and cal["R01"]["日付"] == "2026-11-21" and cal["R01"]["曜日"] == "土"
        assert json.loads((tmp / "brand.json").read_text())["start_date"] == "2026-11-21"
        log = {r["投稿ID"]: r for r in common.read_csv(publish.POSTS_LOG_CSV)}
        assert log["R01"]["投稿日"] == "2026-11-21"
        assert publish.reschedule_if_late(now, {}) is None   # 2 回目はずらさない


if __name__ == "__main__":
    print(f"\n{len(PASSED)} tests passed")
