"""
使い方:
  python -m autopost.main generate   今日の投稿文と画像を作る（posts/ と images/ に保存）
  python -m autopost.main publish    作った投稿を各SNSに出す
  python -m autopost.main preview    保存も投稿もせず、今日の投稿文を作って表示する（prompt.md の調整用）
  python -m autopost.main video      今日の投稿からショート動画を作って images/ に置く（確認用）
  python -m autopost.main video_preview  保存も投稿もせず、投稿文と会話を作ってショート動画 preview.mp4 にする（確認用）
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
LP_URL = "https://axionsales.vercel.app"  # LP（axion-sales.html）の短いURL。/youtube などで流入元が付く（vercel.json）
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


# 何の会社か一目でわかるよう、YouTube のタイトルと説明欄の頭に「営業代行」を入れる
YT_INTRO = "名古屋の建設・不動産専門の営業代行「AXION SALES（アクシオンセールス）」です。新規開拓・アポ獲得を代行しています。"


def youtube_title(post) -> str:
    return f"{post['image_title'][:60]}｜営業代行 AXION SALES #Shorts"


def youtube_description(post, credits) -> str:
    """Instagramのキャプションから DM の案内を外し、YouTube から申し込める先（チャンネルのリンク・LP）を書く"""
    body = "\n".join(ln for ln in post["instagram"].splitlines() if "DM" not in ln).strip()
    cta = ("▼御社の業種・商圏に合わせた見込み客リスト20件を、無料で作ってお送りします\n"
           f"チャンネルページのリンク、またはこちらから → {LP_URL}/youtube\n"
           "（X・InstagramのDMで「リスト」と送っていただいてもOKです）")
    voice = "\n\n音声：" + "、".join(credits) if credits else ""
    return f"{YT_INTRO}\n\n{body}\n\n{cta}{voice}"


def post_short(post) -> str:
    """その日の投稿からショート動画を作ってYouTubeに出す（動画はリポジトリに残さない）"""
    import tempfile

    from .video import make_short

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "short.mp4")
        _, credits = make_short(post, path)
        description = youtube_description(post, credits)
        return platforms.post_youtube(path, youtube_title(post), description)


def cmd_video():
    """今日の投稿からショート動画を作って images/ と同じ場所に保存する（確認用。コミットしない）"""
    from .video import make_short

    post_path, img_path = paths(today())
    post = load_json(post_path, None)
    if not post:
        sys.exit("今日の投稿がありません")
    out = img_path.with_suffix(".mp4")
    total, credits = make_short(post, str(out))
    print(f"{out.name}: {total:.1f}秒 {'／'.join(credits) or '（声なし）'}")


def cmd_video_preview():
    """投稿文と会話を作り、ショート動画を preview.mp4 に書き出す（保存・投稿しない）"""
    from .video import make_short

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY が未設定です")
    post = make_post(today())
    print(json.dumps(post, ensure_ascii=False, indent=2))
    total, credits = make_short(post, str(ROOT / "preview.mp4"))
    print(f"preview.mp4: {total:.1f}秒 {'／'.join(credits) or '（声なし）'}")


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
        ("youtube", platforms.YT_KEYS, lambda: post_short(post)),
    ]
    if not post.get("linkedin"):  # prompt.md はX・Instagram用。LinkedIn用の本文は作らない
        jobs = [j for j in jobs if j[0] != "linkedin"]
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
    {"generate": cmd_generate, "publish": cmd_publish, "preview": cmd_preview, "video": cmd_video,
     "video_preview": cmd_video_preview}.get(
        sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__)
    )()
