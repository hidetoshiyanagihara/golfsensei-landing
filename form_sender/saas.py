"""【SaaS向け 自動営業】送り先を探す → 送れるか確かめる → 事前調査 → 営業文 → 送信 → 記録 を1回で行う。

GitHub Actions から平日1日1回動かす（.github/workflows/form_sales.yml）。
リポジトリは公開なので、ログには会社名や文面を出さない（記録は暗号化した state.enc に残す）。
"""
import json
import os
import random
import time
from datetime import datetime

import ai
import config
from common import (
    COMPANY_FIELDS, MODE_LIVE, MODE_TEST, RESULT_FAIL, RESULT_SKIP, RESULT_SUCCESS, SUBMITTED_PREFIX,
    Registry, append_rows, is_sent_row, load_companies, load_ng, load_results, record_result, sent_today_count,
)


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def build_letter(company: str, body: str) -> str:
    text = config.MESSAGE_SAAS_TXT.read_text(encoding="utf-8")
    return text.replace("{社名}", company).replace("{本文}", body.strip()).strip() + "\n"


def save_research(row: dict) -> None:
    with open(config.RESEARCH_JSONL, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def saved_letter(url: str) -> dict | None:
    """前に（テストで）作った、送る判断の文面があれば使い回す。調べ直しの費用をかけず、確認した文面をそのまま送るため"""
    if not config.RESEARCH_JSONL.exists():
        return None
    found = None
    for line in config.RESEARCH_JSONL.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row.get("URL") == url and row.get("送った文面"):
            found = row
    return found


def _load_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def pending(mode: str) -> list[dict]:
    """まだ処理していない候補（送信済み・スキップ済み・調査で対象外・2回失敗・NGは除く）"""
    results = load_results()
    done = Registry([r for r in results if is_sent_row(r) or r.get("理由", "").startswith("対象外") or (
        r.get("モード") == mode and r.get("結果") in (RESULT_SKIP, RESULT_SUCCESS))])
    fails = {}
    for r in results:
        if r.get("結果") == RESULT_FAIL:
            fails[(r["社名"], r["URL"])] = fails.get((r["社名"], r["URL"]), 0) + 1
    for (n, u), k in fails.items():
        if k >= 2:
            done.add(n, u)
    ng = load_ng()
    return [c for c in load_companies()
            if c.get("URL") and not done.contains(c["社名"], c["URL"]) and not ng.contains(c["社名"], c["URL"])]


def discover_more(mode: str) -> int:
    """候補が足りなければ、切り口を変えながらWeb検索で探して companies.csv に足す"""
    added = 0
    state = _load_json(config.DISCOVER_STATE, {"next_focus": 0})
    for _ in range(config.SAAS_DISCOVER_ROUNDS):
        if len(pending(mode)) >= config.SAAS_POOL_MIN:
            break
        focus = ai.FOCUSES[state["next_focus"] % len(ai.FOCUSES)]
        state["next_focus"] += 1
        known = load_companies()
        reg = Registry(known)
        try:
            found = ai.discover(focus, [c["社名"] for c in known])
        except Exception as e:  # 探すのに失敗しても、手元の候補で続ける
            log(f"送り先探し：失敗（{str(e)[:120]}）")
            continue
        rows = []
        for c in found:
            if reg.contains(c["name"], c["url"]):
                continue
            reg.add(c["name"], c["url"])
            rows.append({"社名": c["name"], "URL": c["url"], "所在地": "", "業種": f"SaaS：{c['product']}"[:80]})
            save_research({"日時": f"{datetime.now():%Y-%m-%d %H:%M}", "社名": c["name"], "URL": c["url"],
                           "段階": "候補", "切り口": focus, "見つけたときのメモ": c})
        append_rows(config.COMPANIES_CSV, COMPANY_FIELDS, rows)
        added += len(rows)
        log(f"送り先探し：{len(rows)}社を候補に追加（切り口{state['next_focus']}）")
    config.DISCOVER_STATE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    return added


def run(count: int, live: bool, headed: bool = False, wait: bool = True) -> None:
    from playwright.sync_api import sync_playwright

    from form_engine import _goto, page_text, precheck, process_company

    mode = MODE_LIVE if live else MODE_TEST
    if live:
        count = min(count, config.DAILY_SEND_LIMIT - sent_today_count(load_results()))
        if count <= 0:
            log("本日の送信上限に達しています")
            return
    discover_more(mode)
    targets = pending(mode)
    log(f"{mode}モード：候補 {len(targets)}社 / 今回 最大{count}件")
    config.SCREENSHOT_DIR.mkdir(exist_ok=True)

    sent = researched = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not headed, executable_path=os.environ.get("CHROMIUM_PATH") or None)
        ctx = browser.new_context(locale="ja-JP", user_agent=config.USER_AGENT, viewport={"width": 1280, "height": 900})
        ctx.set_default_timeout(config.PAGE_TIMEOUT_MS)
        try:
            for i, c in enumerate(targets, 1):
                if sent >= count or researched >= config.SAAS_RESEARCH_PER_RUN:
                    break
                name, url = c["社名"], c["URL"]
                page = ctx.new_page()
                page.on("dialog", lambda d: d.accept())
                try:
                    # 1. 送れる会社か（AIを使う前に確かめる）
                    out = precheck(page, url)
                    if out:
                        record_result(name, url, out.result, out.reason, mode)
                        log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                        continue
                    prev = saved_letter(url)
                    if prev:
                        subject, message = prev["件名"], prev["送った文面"]
                    else:
                        # 2. 事前調査
                        site = page_text(page) if _goto(page, url) else ""
                        researched += 1
                        notes = ai.research(name, url, site)
                        # 3. 送るか判断して営業文
                        letter = ai.write(name, notes)
                        entry = {"日時": f"{datetime.now():%Y-%m-%d %H:%M}", "社名": name, "URL": url, "段階": "調査",
                                 "調査メモ": notes, "判断": letter["fit"], "対象外の理由": letter["skip_reason"],
                                 "分析": letter["analysis"]}
                        if letter["fit"] == "skip":
                            save_research(entry)
                            record_result(name, url, RESULT_SKIP, f"対象外：{letter['skip_reason']}"[:200], mode)
                            log(f"{i}社目：対象外（調査の結果）")
                            continue
                        subject, message = letter["subject"], build_letter(name, letter["body"])
                        entry.update({"件名": subject, "送った文面": message})
                        save_research(entry)
                    # 4. 送信（テストは入力まで）
                    if sent and wait:
                        time.sleep(random.uniform(config.WAIT_MIN_SEC, config.WAIT_MAX_SEC))
                    shot = str(config.SCREENSHOT_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{mode}_{i}.png")
                    out = process_company(page, name, url, message, live, shot, subject=subject)
                    record_result(name, url, out.result, out.reason, mode)
                    log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                    if out.result == RESULT_SUCCESS or out.reason.startswith(SUBMITTED_PREFIX):
                        sent += 1
                except ai.AIError as e:
                    record_result(name, url, RESULT_FAIL, f"AI：{e}"[:200], mode)
                    log(f"{i}社目：失敗（AI：{str(e)[:60]}）")
                except Exception as e:  # 想定外のエラーでも記録して次へ
                    first = (str(e).splitlines() or [type(e).__name__])[0]
                    record_result(name, url, RESULT_FAIL, f"予期しないエラー: {first[:150]}", mode)
                    log(f"{i}社目：失敗（{type(e).__name__}）")
                finally:
                    page.close()
        finally:
            ctx.close()
            browser.close()
    log(f"終了：調査 {researched}社 / {'送信' if live else 'テスト入力'} {sent}件")
