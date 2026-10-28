"""【SaaS向け・手作業の調査つき】事前に調べて書いた営業文（letters.jsonl）を、問い合わせフォームから送る。

letters.jsonl は1行1社の JSON：{"社名", "URL", "件名", "本文", ...調査メモ}。
本文は message_saas.txt の {本文} に入り、宛名・自己紹介・無料リスト・連絡先・結びが付く。
送信済み・NG・スキップ済み・2回失敗の会社は送らない。見えない reCAPTCHA があるフォームにも送らない。

  python letters.py --mode test             # 入力までで送らない（スクリーンショットで確認）
  python letters.py --mode live --count 10  # 平日9〜18時に送る
"""
import argparse
import json
import random
import time
from collections import Counter
from datetime import datetime

import config
from common import (
    MODE_LIVE, MODE_TEST, RESULT_FAIL, RESULT_SKIP, SUBMITTED_PREFIX, RESULT_SUCCESS,
    Registry, is_sent_row, launch_chromium, load_ng, load_results, now_jst, record_result,
    send_window_status, sent_registry,
)

LETTERS = config.BASE_DIR / "letters.jsonl"
MESSAGE_SAAS_TXT = config.BASE_DIR / "message_saas.txt"


def log(msg: str) -> None:
    print(f"[{now_jst():%H:%M:%S}] {msg}", flush=True)


def build_letter(company: str, body: str) -> str:
    text = MESSAGE_SAAS_TXT.read_text(encoding="utf-8")
    return text.replace("{社名}", company).replace("{本文}", body.strip()).strip() + "\n"


def load_letters() -> list[dict]:
    if not LETTERS.exists():
        return []
    return [json.loads(line) for line in LETTERS.read_text(encoding="utf-8").splitlines() if line.strip()]


def targets(mode: str) -> list[dict]:
    results = load_results()
    sent = sent_registry(results)
    ng = load_ng()
    same_mode = [r for r in results if r.get("モード") == mode]
    fails = Counter(r.get("URL", "") for r in same_mode if r.get("結果") == RESULT_FAIL)
    done = Registry([r for r in same_mode if r.get("結果") == RESULT_SKIP or fails[r.get("URL", "")] >= 2
                     or (mode == MODE_TEST and r.get("結果") == RESULT_SUCCESS)])
    return [c for c in load_letters()
            if not sent.contains(c["社名"], c["URL"]) and not done.contains(c["社名"], c["URL"])
            and not ng.contains(c["社名"], c["URL"])]


def today_count(mode: str) -> int:
    today = now_jst().strftime("%Y-%m-%d")
    names = {c["URL"] for c in load_letters()}
    return sum(1 for r in load_results() if r.get("モード") == mode and r.get("日時", "").startswith(today)
               and r.get("URL") in names and is_sent_row(r))


def main() -> None:
    from playwright.sync_api import sync_playwright

    from form_engine import process_company

    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "live"], default="test")
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--no-wait", action="store_true")
    args = ap.parse_args()
    live = args.mode == "live"
    mode = MODE_LIVE if live else MODE_TEST
    config.SKIP_INVISIBLE_CAPTCHA = True

    count = args.count - (today_count(mode) if live else 0)
    todo = targets(mode)
    log(f"{mode}モード：候補 {len(todo)}社 / 今回 最大{max(count, 0)}件")
    if count <= 0 or not todo:
        return
    config.SCREENSHOT_DIR.mkdir(exist_ok=True)
    sent = 0
    with sync_playwright() as pw:
        browser = launch_chromium(pw)
        ctx = browser.new_context(locale="ja-JP", user_agent=config.USER_AGENT, viewport={"width": 1280, "height": 900})
        ctx.set_default_timeout(config.PAGE_TIMEOUT_MS)
        try:
            for c in todo:
                if sent >= count:
                    break
                if live:
                    status, wait_s = send_window_status()
                    if status == "closed":
                        log("送信できる時間外のため終了します（平日9〜18時）")
                        break
                    if status == "wait":
                        log(f"送信開始時刻まで {int(wait_s // 60)} 分待機")
                        time.sleep(wait_s)
                name, url = c["社名"], c["URL"]
                log(f"処理中: {name} {url}")
                page = ctx.new_page()
                page.on("dialog", lambda d: d.accept())
                shot = str(config.SCREENSHOT_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{mode}_{name[:20]}.png")
                try:
                    out = process_company(page, name, url, build_letter(name, c["本文"]), live, shot, subject=c["件名"])
                except Exception as e:  # 想定外のエラーでも記録して次へ
                    first = (str(e).splitlines() or [type(e).__name__])[0]
                    out = None
                    record_result(name, url, RESULT_FAIL, f"予期しないエラー: {first[:150]}", mode)
                    log(f"  → 失敗: 予期しないエラー: {first[:80]}")
                finally:
                    page.close()
                if out:
                    record_result(name, url, out.result, out.reason, mode)
                    log(f"  → {out.result}: {out.reason}  [{out.screenshot or ''}]")
                    if out.result == RESULT_SUCCESS or out.reason.startswith(SUBMITTED_PREFIX):
                        sent += 1
                        if live and not args.no_wait and sent < count:
                            w = random.uniform(config.WAIT_MIN_SEC, config.WAIT_MAX_SEC)
                            log(f"待機 {int(w)} 秒")
                            time.sleep(w)
        finally:
            ctx.close()
            browser.close()
    log(f"終了：{'送信' if live else 'テスト入力'} {sent}件")


if __name__ == "__main__":
    main()
