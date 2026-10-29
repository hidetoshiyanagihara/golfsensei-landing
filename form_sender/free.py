"""【無料版のフォーム営業】AIを使わずに、PR TIMES のニュースから送り先を拾い、決まった文面で送る（クレジットを使わない）。

1. 送り先を探す：PR TIMES の新着から、資金調達・新サービス・営業強化を発表した未上場のIT・SaaSの会社（prtimes.py）
2. 送れるか確かめる：フォームなし・営業お断り・画像認証は外す
3. 文面：message_free.txt に、社名・ニュースの見出し・動きに合わせた書き出しを入れる
4. 送る：1回最大10件。記録は暗号化した state.enc（saas.py と同じファイル）に残し、ログに会社名を出さない
"""
import json
import os
import random
import time
from datetime import datetime

import config
import prtimes
from common import (
    COMPANY_FIELDS, MODE_LIVE, MODE_TEST, RESULT_FAIL, RESULT_SUCCESS, SUBMITTED_PREFIX, Registry, append_rows,
    load_companies, load_results, record_result, sent_today_count,
)
from saas import log, pending, save_research

TITLE_MAX = 60
OPENINGS = {
    "funding": "事業を大きく伸ばしていく時期は、商談の数を増やしたい一方で、営業の採用や立ち上げには時間がかかるものだと思います。",
    "launch": "新しいサービスを広げていく時期は、まず使ってほしい会社に、早く・数多く知ってもらうことが大切だと思います。",
    "sales": "営業を強めていく時期は、商談の数を増やす仕組みづくりと、そのための人手の確保が悩みどころだと思います。",
}
SUBJECT = "{社名}さまの新規商談づくりについて（見込み客リスト20件無料）"


def known_release_urls() -> set[str]:
    if not config.RESEARCH_JSONL.exists():
        return set()
    urls = set()
    for line in config.RESEARCH_JSONL.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row.get("ニュース"):
            urls.add(row["ニュース"])
    return urls


def news_for(url: str) -> dict | None:
    """その会社を候補にしたときのニュース（見出し・動き）"""
    if not config.RESEARCH_JSONL.exists():
        return None
    found = None
    for line in config.RESEARCH_JSONL.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row.get("URL") == url and row.get("見出し"):
            found = row
    return found


def build_letter(company: str, title: str, signal: str) -> tuple[str, str]:
    title = title if len(title) <= TITLE_MAX else title[:TITLE_MAX - 1] + "…"
    text = config.MESSAGE_FREE_TXT.read_text(encoding="utf-8")
    body = (text.replace("{社名}", company).replace("{見出し}", title)
            .replace("{書き出し}", OPENINGS.get(signal, OPENINGS["sales"])))
    return SUBJECT.replace("{社名}", company)[:60], body.strip() + "\n"


def discover_more(mode: str) -> int:
    if len(pending(mode)) >= config.SAAS_POOL_MIN:
        return 0
    known = load_companies()
    reg = Registry(known)
    rows = []
    for r in prtimes.find(known_release_urls(), log=log):
        why = prtimes.judge(r)
        entry = {"日時": f"{datetime.now():%Y-%m-%d %H:%M}", "社名": r.company, "URL": r.site, "段階": "候補",
                 "ニュース": r.url, "見出し": r.title, "動き": r.signal, "業種": r.industry, "上場": r.listed,
                 "資本金": r.capital, "代表者名": r.ceo, "対象外の理由": why}
        if why or not r.company or reg.contains(r.company, r.site):
            entry["段階"] = "見送り"
            save_research(entry)
            continue
        reg.add(r.company, r.site)
        save_research(entry)
        rows.append({"社名": r.company, "URL": r.site, "所在地": "", "業種": f"{r.industry}（PR TIMES）"})
    append_rows(config.COMPANIES_CSV, COMPANY_FIELDS, rows)
    log(f"送り先探し：{len(rows)}社を候補に追加")
    return len(rows)


def run(count: int, live: bool, headed: bool = False, wait: bool = True) -> None:
    from playwright.sync_api import sync_playwright

    from form_engine import precheck, process_company

    mode = MODE_LIVE if live else MODE_TEST
    if live:
        count = min(count, config.DAILY_SEND_LIMIT - sent_today_count(load_results()))
        if count <= 0:
            log("本日の送信上限に達しています")
            return
    discover_more(mode)
    targets = [c for c in pending(mode) if news_for(c["URL"])]
    log(f"{mode}モード：候補 {len(targets)}社 / 今回 最大{count}件")
    config.SCREENSHOT_DIR.mkdir(exist_ok=True)

    sent = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not headed, executable_path=os.environ.get("CHROMIUM_PATH") or None)
        ctx = browser.new_context(locale="ja-JP", user_agent=config.USER_AGENT, viewport={"width": 1280, "height": 900})
        ctx.set_default_timeout(config.PAGE_TIMEOUT_MS)
        try:
            for i, c in enumerate(targets, 1):
                if sent >= count:
                    break
                name, url = c["社名"], c["URL"]
                page = ctx.new_page()
                page.on("dialog", lambda d: d.accept())
                try:
                    out = precheck(page, url)
                    if out:
                        record_result(name, url, out.result, out.reason, mode)
                        log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                        continue
                    news = news_for(url)
                    subject, message = build_letter(name, news["見出し"], news.get("動き", ""))
                    if sent and wait:
                        time.sleep(random.uniform(config.WAIT_MIN_SEC, config.WAIT_MAX_SEC))
                    shot = str(config.SCREENSHOT_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{mode}_{i}.png")
                    out = process_company(page, name, url, message, live, shot, subject=subject)
                    record_result(name, url, out.result, out.reason, mode)
                    save_research({"日時": f"{datetime.now():%Y-%m-%d %H:%M}", "社名": name, "URL": url, "段階": "送信",
                                   "モード": mode, "件名": subject, "送った文面": message, "結果": out.result})
                    log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                    if out.result == RESULT_SUCCESS or out.reason.startswith(SUBMITTED_PREFIX):
                        sent += 1
                except Exception as e:  # 想定外のエラーでも記録して次へ
                    first = (str(e).splitlines() or [type(e).__name__])[0]
                    record_result(name, url, RESULT_FAIL, f"予期しないエラー: {first[:150]}", mode)
                    log(f"{i}社目：失敗（{type(e).__name__}）")
                finally:
                    page.close()
        finally:
            ctx.close()
            browser.close()
    log(f"終了：{'送信' if live else 'テスト入力'} {sent}件")
