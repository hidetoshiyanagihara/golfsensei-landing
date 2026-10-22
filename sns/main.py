"""SNS 予約投稿ツール（X / Instagram / LinkedIn）

使い方:
  python main.py check                             # posts.csv の検査（文字数・日時・画像URL）
  python main.py post --mode test [--platform x]   # テスト: API を呼ばず、投稿予定の内容を表示・記録
  python main.py post --mode live [--yes]          # 本番: 予定日時を過ぎた未投稿分を投稿
  python main.py status                            # 媒体ごとの件数の確認
  python main.py verify                            # .env の認証情報を確認し、URN・IG ユーザーID等を自動で埋める
  python main.py images                            # cards.csv から Instagram 用画像を生成し画像URLを埋める

タスクスケジューラ / cron で 30 分おきに `python main.py post --mode live --yes` を実行する想定。
"""
import argparse
import sys
from datetime import datetime

import config
from common import (
    MODE_LIVE, MODE_TEST, RESULT_FAIL, RESULT_SKIP, RESULT_SUCCESS, build_text, done_keys, due_posts,
    load_env, load_posts, load_results, posted_today, record_result, text_length, validate,
)


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def cmd_check(args) -> int:
    posts = load_posts()
    if not posts:
        log(f"{config.POSTS_CSV.name} に投稿がありません")
        return 1
    bad, seen = 0, set()
    for p in posts:
        errors = validate(p)
        key = (p.get("ID"), p.get("媒体"))
        if key in seen:
            errors.append("ID と媒体の組み合わせが重複")
        seen.add(key)
        if errors:
            bad += 1
            log(f"NG  {p.get('ID')} [{p.get('媒体')}] " + " / ".join(errors))
    log(f"検査完了: {len(posts)} 件中 {bad} 件に問題あり")
    return 1 if bad else 0


def _record(results: list[dict], post: dict, result: str, detail: str, mode: str) -> None:
    """結果を記録する。定期実行で同じスキップ・失敗が並ばないよう、直前と同じ内容なら記録しない。"""
    last = [r for r in results if (r.get("ID"), r.get("媒体"), r.get("モード")) ==
            (post.get("ID"), post.get("媒体"), mode)]
    if last and (last[-1].get("結果"), last[-1].get("投稿ID・理由")) == (result, detail):
        return
    record_result(post, result, detail, mode)


def cmd_post(args) -> int:
    from platforms import REQUIRED_ENV, PostError, missing_env, publish

    mode = MODE_LIVE if args.mode == "live" else MODE_TEST
    now = datetime.now()
    results = load_results()
    due, late = due_posts(load_posts(), results, mode, now, args.platform)
    for p, reason in late:
        log(f"見送り {p['ID']} [{p['媒体']}] {reason}（出す場合は予定日時を直してください）")
    if not due:
        log("投稿予定の時刻を過ぎた未投稿分はありません")
        return 0

    if mode == MODE_LIVE:
        load_env()
        if not args.yes:
            print(f"{len(due)} 件を実際に投稿します。よろしければ yes と入力してください: ", end="")
            if input().strip().lower() != "yes":
                log("中止しました")
                return 1

    failed = 0
    for p in due:
        platform, label = p["媒体"], f"{p['ID']} [{p['媒体']}]"
        errors = validate(p)
        if errors:
            _record(results, p, RESULT_SKIP, " / ".join(errors), mode)
            log(f"スキップ {label} {' / '.join(errors)}")
            continue
        text = build_text(p)
        if mode == MODE_TEST:
            record_result(p, RESULT_SUCCESS, "テスト（未投稿）", mode)
            log(f"テスト {label} {text_length(platform, text)}字\n{text}\n" + "-" * 40)
            continue
        if posted_today(results, platform, now) >= config.DAILY_POST_LIMIT[platform]:
            log(f"保留 {label} 本日の上限 {config.DAILY_POST_LIMIT[platform]} 件に達しています")
            continue
        missing = missing_env(platform)
        if len(missing) == len(REQUIRED_ENV[platform]):
            log(f"保留 {label} {config.PLATFORM_LABELS[platform]} の認証情報が未設定です")
            continue
        if missing:
            _record(results, p, RESULT_FAIL, "認証情報なし: " + ", ".join(missing), mode)
            log(f"失敗 {label} 認証情報なし: {', '.join(missing)}")
            failed += 1
            continue
        try:
            post_id = publish(platform, text, p.get("画像URL", ""))
        except PostError as e:
            _record(results, p, RESULT_FAIL, str(e), mode)
            log(f"失敗 {label} {e}")
            failed += 1
            continue
        record_result(p, RESULT_SUCCESS, post_id, mode)
        results = load_results()
        log(f"成功 {label} 投稿ID {post_id}")
    return 1 if failed else 0


def cmd_status(args) -> int:
    posts, results = load_posts(), load_results()
    done = done_keys(results, MODE_LIVE)
    now = datetime.now()
    for platform in config.PLATFORMS:
        mine = [p for p in posts if p.get("媒体") == platform]
        posted = sum(1 for p in mine if (p.get("ID"), platform) in done)
        fails = sum(1 for r in results if r.get("媒体") == platform and r.get("モード") == MODE_LIVE
                    and r.get("結果") == RESULT_FAIL)
        log(f"{config.PLATFORM_LABELS[platform]:<9} 予定 {len(mine)} / 投稿済み {posted} / "
            f"失敗記録 {fails} / 本日 {posted_today(results, platform, now)}")
    return 0


def cmd_verify(args) -> int:
    from platforms import REQUIRED_ENV, VERIFIERS, PostError, missing_env

    load_env()
    ng = 0
    for platform in config.PLATFORMS:
        label = config.PLATFORM_LABELS[platform]
        # URN と IG ユーザー ID は verify で自動取得できるので、未設定でも確認に進む
        missing = [k for k in missing_env(platform) if k not in ("LINKEDIN_AUTHOR_URN", "IG_USER_ID")]
        if missing:
            log(f"未設定 {label}: {', '.join(missing)} を .env に記入してください")
            ng += 1
            continue
        try:
            log(f"OK     {label}: {VERIFIERS[platform]()}")
        except (PostError, KeyError) as e:
            log(f"NG     {label}: {e}")
            ng += 1
    log(f"確認完了: {len(REQUIRED_ENV) - ng}/{len(REQUIRED_ENV)} 媒体で投稿の準備ができています")
    return 1 if ng else 0


def cmd_images(args) -> int:
    from images import fill_image_urls, load_cards, render

    cards = load_cards()
    if args.id:
        cards = [c for c in cards if c.get("ID") in args.id]
    if not cards:
        log(f"{config.CARDS_CSV.name} に対象の行がありません")
        return 1
    made = render(cards, log=log)
    n = fill_image_urls(made)
    log(f"完了: {len(made)} 枚を生成、posts.csv の画像URLを {n} 件記入しました")
    log("images/ を main ブランチにマージすると公開され、Instagram に投稿できるようになります")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="SNS 予約投稿ツール")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").set_defaults(func=cmd_check)
    p = sub.add_parser("post")
    p.add_argument("--mode", choices=["test", "live"], required=True)
    p.add_argument("--platform", choices=config.PLATFORMS, default="")
    p.add_argument("--yes", action="store_true", help="確認なしで投稿（定期実行用）")
    p.set_defaults(func=cmd_post)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("verify").set_defaults(func=cmd_verify)
    p = sub.add_parser("images")
    p.add_argument("id", nargs="*", help="生成する ID（省略時はすべて）")
    p.set_defaults(func=cmd_images)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
