"""問い合わせフォーム営業ツール（名古屋市 建設・設備・リフォーム・不動産）

使い方:
  python main.py collect [--max 100]            # 1. リスト作成（検索）→ companies.csv
  python main.py import 名簿.csv [--max 100]     # 1. 企業名簿CSVから取り込み → companies.csv
  python main.py send --mode test [--count 10]  # テスト: 入力のみ・送信しない・スクショ保存
  python main.py send --mode live [--count 50]  # 本番: 実際に送信
  python main.py status                         # 件数の確認
"""
import argparse
import random
import re
import sys
import time

import config
from common import (
    MODE_LIVE, MODE_TEST, REJECTED_PREFIX, RESULT_FAIL, STALLED_PREFIX, RESULT_SKIP, SUBMITTED_PREFIX, Registry, build_message,
    is_sent_row, launch_chromium, load_companies, now_jst, send_window_status, load_ng, load_results, record_result, sent_registry, sent_today_count,
)


def log(msg: str) -> None:
    print(f"[{now_jst():%H:%M:%S}] {msg}", flush=True)


def cmd_collect(args) -> None:
    from collect import collect
    found = collect(args.max, log=log)
    log(f"完了: {len(found)} 社を companies.csv に追加しました")


def cmd_import(args) -> None:
    from collect import import_list
    found = import_list(args.path, args.max, log=log)
    log(f"完了: {len(found)} 社を companies.csv に追加しました")


def _targets(mode: str, retest: bool, industries: list[str] | None = None) -> list[dict]:
    """送信対象の会社を companies.csv の順に返す（送信済み・NG・処理済みは除く）。"""
    results = load_results()
    sent = sent_registry(results)
    ng = load_ng()
    if mode == MODE_LIVE:
        # 本番でスキップ済み/送信済みの会社は対象外（送信前の失敗のみ再試行）
        done = Registry([r for r in results if r.get("モード") == MODE_LIVE and (
            is_sent_row(r) or r.get("結果") == RESULT_SKIP
            or r.get("理由", "").startswith((REJECTED_PREFIX, STALLED_PREFIX)))])
    else:
        done = Registry([] if retest else [r for r in results if r.get("モード") == MODE_TEST])
    ng_recorded = Registry([r for r in results if r.get("理由") == "NGリスト"])
    out = []
    for c in load_companies():
        if industries and c.get("業種", "") not in industries:
            continue
        name, url = c.get("社名", ""), c.get("URL", "")
        if not url:
            continue
        if sent.contains(name, url) or done.contains(name, url):
            continue
        if ng.contains(name, url):
            if not ng_recorded.contains(name, url):
                record_result(name, url, RESULT_SKIP, "NGリスト", mode)
                ng_recorded.add(name, url)
            continue
        out.append(c)
    return out


def _safe(s: str) -> str:
    return re.sub(r"[\\/:*?\"<>|\s]+", "_", s)[:40]


def cmd_send(args) -> None:
    from playwright.sync_api import sync_playwright
    from form_engine import process_company

    live = args.mode == "live"
    mode = MODE_LIVE if live else MODE_TEST
    if args.no_wait and live:
        sys.exit("--no-wait はテストモードでのみ使用できます")

    if live:
        remaining = config.DAILY_SEND_LIMIT - sent_today_count(load_results())
        if remaining <= 0:
            log(f"本日の送信上限（{config.DAILY_SEND_LIMIT}件）に達しています")
            return
        count = min(args.count or config.DAILY_SEND_LIMIT, remaining)
        if not args.yes:
            ans = input(f"本番モードで最大 {count} 件、実際に送信します。よろしいですか？ [yes/no]: ").strip().lower()
            if ans not in ("y", "yes"):
                log("中止しました")
                return
    else:
        count = args.count or config.TEST_DEFAULT_COUNT

    targets = _targets(mode, args.retest, args.industry)
    if not targets:
        log("対象の会社がありません（companies.csv を確認してください）")
        return
    log(f"{mode}モード: 対象候補 {len(targets)} 社 / 今回の上限 {count} 件")
    config.SCREENSHOT_DIR.mkdir(exist_ok=True)

    sent = processed = 0
    with sync_playwright() as pw:
        browser = launch_chromium(pw, headless=not args.headed)
        ctx = browser.new_context(locale="ja-JP", user_agent=config.USER_AGENT,
                                  viewport={"width": 1280, "height": 900})
        ctx.set_default_timeout(config.PAGE_TIMEOUT_MS)
        try:
            for c in targets:
                if (live and sent >= count) or (not live and processed >= count):
                    break
                if processed > 0 and not args.no_wait:
                    wait = random.uniform(config.WAIT_MIN_SEC, config.WAIT_MAX_SEC)
                    log(f"待機 {wait:.0f} 秒")
                    time.sleep(wait)
                if live and not args.any_time:
                    state, secs = send_window_status()
                    if state == "wait":
                        log(f"送信開始時刻（{config.SEND_HOURS[0]}時）まで {secs / 60:.0f} 分待機")
                        time.sleep(secs)
                    elif state == "closed":
                        log(f"送信時間外（平日{config.SEND_HOURS[0]}〜{config.SEND_HOURS[1]}時）のため終了します")
                        break
                name, url = c["社名"], c["URL"]
                log(f"処理中: {name} {url}")
                shot = str(config.SCREENSHOT_DIR / f"{now_jst():%Y%m%d_%H%M%S}_{mode}_{_safe(name)}.png")
                page = ctx.new_page()
                page.on("dialog", lambda d: d.accept())  # 「送信しますか？」等の確認ダイアログ
                try:
                    subject, message = build_message(c)
                    out = process_company(page, name, url, message, live, shot, subject)
                except Exception as e:  # 想定外のエラーでも記録して次へ
                    first = (str(e).splitlines() or [type(e).__name__])[0]
                    out_result, out_reason = RESULT_FAIL, f"予期しないエラー: {first[:150]}"
                    record_result(name, url, out_result, out_reason, mode)
                    log(f"  → {out_result}: {out_reason}")
                else:
                    record_result(name, url, out.result, out.reason, mode)
                    log(f"  → {out.result}: {out.reason}" + (f"  [{out.screenshot}]" if out.screenshot else ""))
                    if live and (out.result == "成功" or out.reason.startswith(SUBMITTED_PREFIX)):
                        sent += 1
                finally:
                    page.close()
                processed += 1
        except KeyboardInterrupt:
            log("中断しました")
        finally:
            ctx.close()
            browser.close()
    log(f"終了: 処理 {processed} 社" + (f" / 送信 {sent} 件（本日計 {sent_today_count(load_results())} 件）" if live else ""))


def cmd_calllist(args) -> None:
    from calllist import CALL_LIST_CSV, build
    n = build(log=log)
    log(f"完了: {n} 社を {CALL_LIST_CSV.name} に書き出しました")


def cmd_status(args) -> None:
    results = load_results()
    companies = load_companies()
    print(f"companies.csv: {len(companies)} 社")
    print(f"送信済み（累計）: {sum(1 for r in results if is_sent_row(r))} 件")
    print(f"本日の送信: {sent_today_count(results)} / {config.DAILY_SEND_LIMIT} 件")
    for mode in (MODE_TEST, MODE_LIVE):
        rows = [r for r in results if r.get("モード") == mode]
        if rows:
            counts = {}
            for r in rows:
                counts[r["結果"]] = counts.get(r["結果"], 0) + 1
            print(f"{mode}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))


def main() -> None:
    ap = argparse.ArgumentParser(description="問い合わせフォーム営業ツール")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("collect", help="検索で会社リストを作成")
    p.add_argument("--max", type=int, default=config.COLLECT_MAX_PER_RUN, help="追加する最大社数（上限100）")
    p.set_defaults(func=cmd_collect)

    p = sub.add_parser("import", help="企業名簿CSV（社名,所在地,業種,URL）を取り込む")
    p.add_argument("path")
    p.add_argument("--max", type=int, default=config.COLLECT_MAX_PER_RUN)
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("send", help="フォーム入力/送信")
    p.add_argument("--mode", choices=["test", "live"], default="test")
    p.add_argument("--count", type=int, default=0, help="テスト: 処理社数（既定10） / 本番: 送信件数（既定・上限は1日50）")
    p.add_argument("--retest", action="store_true", help="テスト済みの会社も再度テストする")
    p.add_argument("--no-wait", action="store_true", help="（テストのみ）1件ごとの待機を省略")
    p.add_argument("--headed", action="store_true", help="ブラウザ画面を表示して実行")
    p.add_argument("--yes", action="store_true", help="本番送信の確認を省略")
    p.add_argument("--industry", nargs="+", help="この業種（companies.csv の業種列）の会社だけに送る 例: --industry 塗装 解体 内装")
    p.add_argument("--any-time", action="store_true", help="（本番）送信時間帯の制限を無視する")
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("calllist", help="送信できた会社のフォロー電話用リスト（call_list.csv）を作る")
    p.set_defaults(func=cmd_calllist)

    p = sub.add_parser("status", help="件数を表示")
    p.set_defaults(func=cmd_status)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
