"""オフラインの通しテスト:  python tests/test_offline.py
AIとSNSのAPIは差し替えるので、実際には何も生成・投稿しない。"""
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from autopost import generate, main, platforms  # noqa: E402

failures = []


def check(cond, msg):
    print(("OK  " if cond else "NG  ") + msg)
    if not cond:
        failures.append(msg)


tmp = Path(tempfile.mkdtemp())
main.ROOT, main.POSTS, main.IMAGES, main.HISTORY = tmp, tmp / "posts", tmp / "images", tmp / "history.json"
(tmp / "brand.md").write_text((ROOT / "brand.md").read_text(encoding="utf-8"), encoding="utf-8")

# ---------------------------------------------------------------- 生成（AIは差し替え）
POST = {
    "theme": "フォーム営業の送り先選び", "image_title": "送る前に「送らない判断」を",
    "image_sub": "営業お断りの会社に送らないことが、結果的に反応率を上げます",
    "x": "問い合わせフォーム営業で大事なのは、本文より送らない判断。" * 6,
    "instagram": "フォーム営業のコツ\n\n#営業 #名古屋", "linkedin": "フォーム営業について #営業代行 (要点)",
}
replies = ['前置き {"theme": "x"}', "URL入り " + json.dumps({**POST, "x": "見て https://e.com"}), json.dumps(POST)]
prompts = []


class FakeMessages:
    def create(self, **kw):
        prompts.append(kw["messages"][0]["content"])
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=replies.pop(0))])


generate.anthropic.Anthropic = lambda: SimpleNamespace(messages=FakeMessages())
os.environ.pop("ANTHROPIC_API_KEY", None)
main.cmd_generate()
check(len(prompts) == 0 and not (tmp / "posts").exists(), "AIのキー未設定なら何もしない（失敗にしない）")
main.cmd_publish()
check(True, "AIのキー未設定で投稿がなくても失敗にしない")
os.environ["ANTHROPIC_API_KEY"] = "dummy"
main.cmd_generate()
day = main.today().strftime("%Y-%m-%d")
saved = json.loads((tmp / "posts" / f"{day}.json").read_text(encoding="utf-8"))
check(len(prompts) == 3, "項目不足・URL入りの出力は作り直す（3回目で成功）")
check("絶対に守ること" in prompts[0] and "（まだなし）" in prompts[0], "brand.md と過去テーマをプロンプトに入れる")
check(platforms.x_weight(saved["x"]) <= 280 and saved["x"].endswith("…"), "Xの本文は280以内に切り詰め")
img = tmp / "images" / f"{day}.jpg"
check(img.exists() and img.read_bytes()[:3] == b"\xff\xd8\xff", "画像はJPEGで保存（InstagramはPNG不可）")
from PIL import Image  # noqa: E402
check(Image.open(img).size == (1080, 1350), "画像サイズ 1080x1350")

# ---------------------------------------------------------------- 投稿（APIは差し替え）
calls = []
platforms.post_x = lambda text: calls.append(("x", text)) or "111"


def ig_fail(url, caption):
    calls.append(("instagram", url))
    raise platforms.PostError("Instagram画像登録 失敗 (400)")


platforms.post_instagram = ig_fail
for k in platforms.X_KEYS + platforms.IG_KEYS:
    os.environ[k] = "dummy"
os.environ.pop("LI_ACCESS_TOKEN", None)
os.environ["GITHUB_REPOSITORY"] = "owner/golfsensei-landing"
os.environ["GITHUB_WORKSPACE"] = str(tmp.parent)  # このフォルダがリポジトリのサブフォルダにある状態
try:
    main.cmd_publish()
    exited = None
except SystemExit as e:
    exited = str(e)
res = json.loads((tmp / "posts" / f"{day}.json").read_text(encoding="utf-8"))["results"]
check(res["x"] == "ok:111" and res["instagram"].startswith("error:") and res["linkedin"] == "skipped",
      "成功・失敗・キー未設定を記録")
check(("instagram", f"https://raw.githubusercontent.com/owner/golfsensei-landing/main/{tmp.name}/images/{day}.jpg")
      in calls, "Instagramにはサブフォルダ込みの公開URLのJPEGを渡す")
check(exited and "instagram" in exited, "失敗があれば終了コードで知らせる")
check(json.loads(main.HISTORY.read_text(encoding="utf-8"))[-1]["theme"] == POST["theme"], "テーマを履歴に残す")

calls.clear()
platforms.post_instagram = lambda url, caption: calls.append(("instagram", url)) or "222"
main.cmd_publish()
res = json.loads((tmp / "posts" / f"{day}.json").read_text(encoding="utf-8"))["results"]
check([c[0] for c in calls] == ["instagram"] and res["instagram"] == "ok:222", "再実行では失敗分だけ投稿")
check(len(json.loads(main.HISTORY.read_text(encoding="utf-8"))) == 1, "履歴は1日1件")

# ---------------------------------------------------------------- LinkedIn の本文変換
check(platforms.linkedin_text("費用(税別) #営業代行") == "費用\\(税別\\) {hashtag|\\#|営業代行}", "LinkedIn: 記号エスケープとハッシュタグ")

print(f"\n{'全テスト成功' if not failures else f'{len(failures)} 件失敗'}")
sys.exit(1 if failures else 0)
