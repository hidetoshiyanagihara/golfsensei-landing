"""
使い方:
  python -m autopost.main generate   今日の投稿文と画像を作る（posts/ と images/ に保存）
  python -m autopost.main publish    作った投稿を各SNSに出す
  python -m autopost.main preview    保存も投稿もせず、今日の投稿文を作って表示する（prompt.md の調整用）
キーが設定されていないSNSは自動でスキップします。
"""
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import platforms
from .platforms import PostError

ROOT = Path(__file__).resolve().parent.parent
POSTS, IMAGES = ROOT / "posts", ROOT / "images"
HISTORY = ROOT / "history.json"
PROMPT, MEMO = ROOT / "prompt.md", ROOT / "memo.md"
RECENT_DAYS = 14


def today():
    return datetime.now(ZoneInfo("Asia/Tokyo"))


def paths(d):
    key = d.strftime("%Y-%m-%d")
    return POSTS / f"{key}.json", IMAGES / f"{key}.jpg"  # InstagramはJPEGのみ対応


def public_url(path):
    """リポジトリに置いたファイルの公開URL（このフォルダがリポジトリのサブフォルダでも可）"""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    branch = os.environ.get("GITHUB_REF_NAME", "main")
    workspace = Path(os.environ.get("GITHUB_WORKSPACE", ROOT)).resolve()
    rel = Path(path).resolve().relative_to(workspace).as_posix()
    return f"https://raw.githubusercontent.com/{repo}/{branch}/{rel}"


def load_json(p, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def save_json(p, data):
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def recent_posts(d) -> str:
    """直近14日分の投稿（今日を除く）を、被り防止のためにプロンプトへ渡す形にまとめる"""
    lines = []
    for i in range(RECENT_DAYS, 0, -1):
        day = d - timedelta(days=i)
        post = load_json(paths(day)[0], None)
        if post:
            lines.append(f"\n- {day:%m/%d}（{'月火水木金土日'[day.weekday()]}）テーマ：{post.get('theme', '')}"
                         f"\n  X：{post.get('x', '')}")
    return "".join(lines)


def make_post(d) -> dict:
    from .generate import generate_post

    memo = MEMO.read_text(encoding="utf-8") if MEMO.exists() else ""
    return generate_post(PROMPT.read_text(encoding="utf-8"), recent_posts(d), memo, d)


def cmd_preview():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY が未設定です")
    print(json.dumps(make_post(today()), ensure_ascii=False, indent=2))


def cmd_generate():
    from .image_card import make_card

    d = today()
    post_path, img_path = paths(d)
    if post_path.exists():
        print(f"今日の投稿はもう作成済み: {post_path.name}")
        return
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY が未設定のため、今日の投稿は作りません（登録すると翌朝から動きます）")
        return
    POSTS.mkdir(exist_ok=True)
    IMAGES.mkdir(exist_ok=True)

    post = make_post(d)
    post["x"] = platforms.fit_x(post["x"])
    make_card(post["image_title"], post["image_sub"], str(img_path))
    post["results"] = {}
    save_json(post_path, post)
    print(json.dumps(post, ensure_ascii=False, indent=2))


def configured(keys):
    return all(os.environ.get(k) for k in keys)


def cmd_publish():
    d = today()
    post_path, img_path = paths(d)
    if not post_path.exists():
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("今日の投稿はありません（ANTHROPIC_API_KEY 未設定）")
            return
        sys.exit("今日の投稿がありません。先に generate を実行してください。")
    post = load_json(post_path, {})
    results = post.setdefault("results", {})

    image_url = public_url(img_path)

    jobs = [
        ("x", platforms.X_KEYS, lambda: platforms.post_x(post["x"])),
        ("instagram", platforms.IG_KEYS, lambda: platforms.post_instagram(image_url, post["instagram"])),
        ("linkedin", platforms.LI_KEYS, lambda: platforms.post_linkedin(post["linkedin"], str(img_path), post["image_title"])),
    ]
    if not post.get("linkedin"):  # prompt.md はX・Instagram用。LinkedIn用の本文は作らない
        jobs = jobs[:2]
    failed = []
    for name, keys, run in jobs:
        if str(results.get(name, "")).startswith("ok:"):
            print(f"[{name}] 投稿済みのためスキップ")
            continue
        if not configured(keys):
            print(f"[{name}] キー未設定のためスキップ")
            results[name] = "skipped"
            continue
        try:
            results[name] = f"ok:{run()}"
            print(f"[{name}] 投稿成功")
        except (PostError, Exception) as e:  # 1つ失敗しても他は続ける
            results[name] = f"error:{e}"[:600]
            failed.append(name)
            print(f"[{name}] 失敗: {e}")
        save_json(post_path, post)
    save_json(post_path, post)

    history = load_json(HISTORY, [])
    if not any(h["date"] == d.strftime("%Y-%m-%d") for h in history):
        history.append({"date": d.strftime("%Y-%m-%d"), "theme": post["theme"]})
        save_json(HISTORY, history[-90:])

    if failed:
        sys.exit(f"失敗したSNS: {', '.join(failed)}（GitHubから失敗通知メールが届きます）")


if __name__ == "__main__":
    {"generate": cmd_generate, "publish": cmd_publish, "preview": cmd_preview}.get(
        sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__)
    )()
