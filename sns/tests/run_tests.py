"""オフラインのテスト:  python tests/run_tests.py
実際の SNS には一切アクセス・投稿しない（API 呼び出しは差し替え）。"""
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import config  # noqa: E402

tmp = Path(tempfile.mkdtemp())
for name in ("POSTS_CSV", "RESULT_CSV", "ENV_FILE", "CARDS_CSV", "IMAGE_DIR"):
    setattr(config, name, tmp / getattr(config, name).name)

import common  # noqa: E402
import main  # noqa: E402
import platforms  # noqa: E402

failures = []


def check(cond, msg):
    print(("OK  " if cond else "NG  ") + msg)
    if not cond:
        failures.append(msg)


# ---------------------------------------------------------------- 文字数
check(common.x_length("abc") == 3, "X: 半角は1")
check(common.x_length("あいう") == 6, "X: 全角は2")
check(common.x_length("見て https://example.com/very/long/path?x=1") == 4 + 1 + 23, "X: URLは23")
check(common.x_length("“引用”") == 6, "X: 一般句読点の引用符は1")

# ---------------------------------------------------------------- 本文の組み立て
p = {"ID": "1", "予定日時": "2026-11-01 09:00", "媒体": "x", "本文": "一行目\\n{LP}"}
check(common.build_text(p) == f"一行目\n{config.LP_URL}?src=x", "\\n を改行、{LP} を流入元付き URL に置換")

# ---------------------------------------------------------------- 検査
check(common.validate(p) == [], "正しい投稿は問題なし")
check(any("長すぎる" in e for e in common.validate({**p, "本文": "あ" * 141})), "X: 141全角は長すぎる")
check(common.validate({**p, "本文": "あ" * 140}) == [], "X: 140全角は可")
check(any("画像URL" in e for e in common.validate({**p, "媒体": "instagram"})), "Instagram は画像URL必須")
check(common.validate({**p, "媒体": "instagram", "画像URL": "https://e.com/a.jpg"}) == [], "Instagram 画像あり可")
check(any("予定日時" in e for e in common.validate({**p, "予定日時": "11/1"})), "日時形式の誤り")
check(any("媒体" in e for e in common.validate({**p, "媒体": "tiktok"})), "未対応の媒体")
check(any("ハッシュタグ" in e for e in common.validate(
    {**p, "媒体": "instagram", "画像URL": "https://e.com/a.jpg", "本文": " ".join(f"#t{i}" for i in range(31))})),
    "Instagram ハッシュタグ31個は不可")

# ---------------------------------------------------------------- LinkedIn の little text
check(platforms.linkedin_commentary("費用(税別) #営業代行 と #名古屋。") ==
      "費用\\(税別\\) {hashtag|\\#|営業代行} と {hashtag|\\#|名古屋}。", "LinkedIn: 予約文字エスケープとハッシュタグ化")
check(platforms.linkedin_commentary("a_b@c") == "a\\_b\\@c", "LinkedIn: _ と @ をエスケープ")

# ---------------------------------------------------------------- 対象の選定
now = datetime(2026, 11, 5, 12, 0)
posts = [
    {"ID": "A", "予定日時": "2026-11-05 11:00", "媒体": "x", "本文": "a"},
    {"ID": "B", "予定日時": "2026-11-05 09:00", "媒体": "linkedin", "本文": "b"},
    {"ID": "C", "予定日時": "2026-11-05 13:00", "媒体": "x", "本文": "c"},
    {"ID": "D", "予定日時": "2026-11-03 09:00", "媒体": "x", "本文": "d"},
]
due, late = common.due_posts(posts, [], common.MODE_LIVE, now)
check([q["ID"] for q in due] == ["B", "A"], "予定日時を過ぎたものを古い順に（未来は除く）")
check([q["ID"] for q, _ in late] == ["D"], "24時間以上前の予定は見送り")
due, _ = common.due_posts(posts, [], common.MODE_LIVE, now, "x")
check([q["ID"] for q in due] == ["A"], "媒体で絞り込み")
results = [{"ID": "A", "媒体": "x", "結果": "成功", "モード": "本番"},
           {"ID": "B", "媒体": "linkedin", "結果": "失敗", "モード": "本番"}]
due, _ = common.due_posts(posts, results, common.MODE_LIVE, now)
check([q["ID"] for q in due] == ["B"], "本番: 成功済みは除外、失敗は再試行")

# ---------------------------------------------------------------- post コマンド（API は差し替え）
fmt = "%Y-%m-%d %H:%M"
soon = datetime.now().replace(second=0, microsecond=0)
with open(config.POSTS_CSV, "w", encoding="utf-8-sig") as f:
    f.write("ID,予定日時,媒体,本文,画像URL\n")
    f.write(f"P1,{soon:{fmt}},x,こんにちは {{LP}},\n")
    f.write(f"P2,{soon:{fmt}},instagram,画像なし,\n")
    f.write(f"P3,{soon:{fmt}},linkedin,つながりましょう,\n")
    f.write(f"P4,{soon:{fmt}},x,二件目,\n")

calls = []
platforms.POSTERS = {k: (lambda k: lambda text, img: calls.append((k, text)) or f"id-{k}-{len(calls)}")(k)
                     for k in platforms.POSTERS}

check(main.main(["check"]) == 1, "check: 画像なしの Instagram を検出")
main.main(["post", "--mode", "test"])
check(calls == [], "テストモードは API を呼ばない")
rows = common.load_results()
check(len(rows) == 4 and all(r["モード"] == "テスト" for r in rows), "テストモードの記録")
check(main.main(["post", "--mode", "test"]) == 0 and len(common.load_results()) == 4, "テスト済みは再処理しない")

import os  # noqa: E402
for k in sum(platforms.REQUIRED_ENV.values(), []):
    os.environ.pop(k, None)
config.ENV_FILE.write_text("X_API_KEY=k\nX_API_SECRET=s\nX_ACCESS_TOKEN=t\nX_ACCESS_SECRET='u'\n", encoding="utf-8")
config.DAILY_POST_LIMIT = {**config.DAILY_POST_LIMIT, "x": 1}
code = main.main(["post", "--mode", "live", "--yes"])
live = {r["ID"]: r for r in common.load_results() if r["モード"] == "本番"}
check(os.environ.get("X_ACCESS_SECRET") == "u", ".env を読み込み（引用符を除去）")
check(calls == [("x", f"こんにちは {config.LP_URL}?src=x")], "本番: X に投稿（1日上限1件）")
check(live["P1"]["結果"] == "成功" and live["P1"]["投稿ID・理由"].startswith("id-x"), "成功と投稿IDを記録")
check(live["P2"]["結果"] == "スキップ", "検査NGはスキップ")
check(live["P3"]["結果"] == "失敗" and "LINKEDIN_ACCESS_TOKEN" in live["P3"]["投稿ID・理由"], "認証情報なしは失敗")
check("P4" not in live, "上限超過分は記録せず保留（翌日に投稿）")
check(code == 1, "失敗があれば終了コード1")
main.main(["post", "--mode", "live", "--yes"])
check(len(calls) == 1, "成功済み・上限到達分は再投稿しない")
check(len([r for r in common.load_results() if r["モード"] == "本番"]) == 3, "同じスキップ・失敗は重複して記録しない")

# ---------------------------------------------------------------- .env の書き換え
common.save_env("X_API_KEY", "new")
common.save_env("FOO", "bar")
env_text = config.ENV_FILE.read_text(encoding="utf-8")
check("X_API_KEY=new" in env_text and "X_API_KEY=k" not in env_text and env_text.endswith("FOO=bar\n"),
      "save_env: 既存キーは置換・新規キーは追記")

# ---------------------------------------------------------------- verify（API は差し替え）
class FakeRes:
    def __init__(self, data, status=200):
        self.status_code, self._data, self.text, self.headers = status, data, str(data), {}

    def json(self):
        return self._data


def fake_get(url, **kw):
    if url.endswith("/userinfo"):
        return FakeRes({"sub": "abc123", "name": "柳原 秀俊"})
    if url.endswith("/me/accounts"):
        return FakeRes({"data": [{"name": "ページ"}, {"name": "AXION", "instagram_business_account": {"id": "1789"}}]})
    if url.endswith("/oauth/access_token"):
        return FakeRes({"access_token": "LONG"})
    if url.endswith("/1789"):
        return FakeRes({"username": "axionsales"})
    if url.endswith("/users/me"):
        return FakeRes({"data": {"username": "axion_sales"}})
    return FakeRes({"error": "?"}, 400)


platforms.requests.get = fake_get
os.environ.update({"LINKEDIN_ACCESS_TOKEN": "t", "LINKEDIN_AUTHOR_URN": "urn:li:person:xxxxxxxx",
                   "IG_ACCESS_TOKEN": "short", "FB_APP_ID": "a", "FB_APP_SECRET": "b"})
os.environ.pop("IG_USER_ID", None)
os.environ.pop("IG_TOKEN_LONG_LIVED", None)
code = main.main(["verify"])
env_text = config.ENV_FILE.read_text(encoding="utf-8")
check(code == 0, "verify: 3 媒体とも OK")
check("LINKEDIN_AUTHOR_URN=urn:li:person:abc123" in env_text, "verify: LinkedIn の URN を自動記入")
check("IG_USER_ID=1789" in env_text and "IG_ACCESS_TOKEN=LONG" in env_text, "verify: IG ユーザーIDと長期トークンを自動記入")
os.environ.pop("X_API_KEY")
config.ENV_FILE.write_text("", encoding="utf-8")
check(main.main(["verify"]) == 1, "verify: 未設定の媒体があれば終了コード1")

# ---------------------------------------------------------------- 画像
import images  # noqa: E402
card = {"ID": "P9", "ラベル": "<保存版>", "見出し": "選ぶ\\n**4つの**ポイント", "項目": "一つ目|二つ\\n目", "結び": "以上"}
h = images.card_html(card)
check("&lt;保存版&gt;" in h and "選ぶ<br><em>4つの</em>ポイント" in h, "画像: エスケープ・改行・強調")
check(h.count("<li ") == 2 and "二つ<br>目" in h, "画像: 項目は | 区切り、項目内は改行")
with open(config.POSTS_CSV, "w", encoding="utf-8-sig") as f:
    f.write("ID,予定日時,媒体,本文,画像URL\n")
    f.write("P9,2026-11-01 09:00,instagram,a,\nP8,2026-11-01 09:00,instagram,b,https://e.com/b.jpg\n")
    f.write("P7,2026-11-01 09:00,x,c,\n")
check(images.fill_image_urls(["P9", "P8", "P7"]) == 1, "画像URL: 空の Instagram 投稿だけ記入")
urls = {p["ID"]: p["画像URL"] for p in common.load_posts()}
check(urls == {"P9": f"{config.IMAGE_URL_BASE}/P9.jpg", "P8": "https://e.com/b.jpg", "P7": ""}, "画像URL: 既存の URL は上書きしない")

shutil.rmtree(tmp)
print(f"\n{'全テスト成功' if not failures else f'{len(failures)} 件失敗'}")
sys.exit(1 if failures else 0)
