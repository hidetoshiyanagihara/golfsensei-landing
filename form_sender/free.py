"""【無料版のフォーム営業】AIを使わずに、PR TIMES のニュースから送り先を拾い、決まった文面で送る（クレジットを使わない）。

1. 送り先を探す：PR TIMES の新着から、資金調達・新サービス・営業強化を発表した未上場のIT・SaaSの会社（prtimes.py）
2. 送れるか確かめる：フォームなし・営業お断り・画像認証は外す
3. 文面：message_free.txt に、社名・ニュースの見出し・動きに合わせた書き出しを入れる
※ agency=True のときは、営業代行の会社に「下請け（協力会社）として受けます」と送る（message_agency.txt）
4. 送る：1回最大10件。送れない会社（フォームなし等）が多くても10件に届くよう、候補が尽きたら探し足す。記録は暗号化した state.enc（saas.py と同じファイル）に残し、ログに会社名を出さない
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
    finish_company, load_companies, load_results, record_result, sent_today_count, skip_stuck, start_company,
    Browser, COMPANY_LIMIT_SEC, CompanyTimeout, RESULT_SKIP, time_limit,
)
from saas import log, pending, save_research

TITLE_MAX = 60
OPENINGS = {
    "funding": "事業を大きく伸ばしていく時期は、商談の数を増やしたい一方で、営業の採用や立ち上げには時間がかかるものだと思います。",
    "launch": "新しいサービスを広げていく時期は、まず使ってほしい会社に、早く・数多く知ってもらうことが大切だと思います。",
    "sales": "営業を強めていく時期は、商談の数を増やす仕組みづくりと、そのための人手の確保が悩みどころだと思います。",
}
SUBJECT = "{社名}さまの新規商談づくりについて（見込み客リスト20件無料）"
SUBJECT_AGENCY = "{社名}さまの協力会社（テレアポ・フォーム営業の委託先）について"
AGENCY_TAG = "営業代行"   # 調査メモの「種類」。下請けの売り込み先として見たニュース
POOL_PER_SEND = 4    # 送れる会社はおよそ3社に1社なので、送りたい件数の4倍の候補をそろえる
MAX_ROUNDS = 4       # 候補が尽きたときに探し足す回数の上限


def known_release_urls(agency: bool = False) -> set[str]:
    """もう見たニュース。候補にしたものはどちらでも二度見ない。見送ったものは、同じ種類の探し方でだけ二度見ない
    （お客さま探しで「同業」として見送った営業代行の会社も、下請けの売り込み先としては見る）"""
    if not config.RESEARCH_JSONL.exists():
        return set()
    urls = set()
    for line in config.RESEARCH_JSONL.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row.get("ニュース") and (row.get("段階") == "候補" or (row.get("種類") == AGENCY_TAG) == agency):
            urls.add(row["ニュース"])
    return urls


def news_index() -> dict[str, dict]:
    """会社のURL → その会社を候補にしたときのニュース（見出し・動き）"""
    if not config.RESEARCH_JSONL.exists():
        return {}
    index = {}
    for line in config.RESEARCH_JSONL.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row.get("URL") and row.get("見出し"):
            index[row["URL"]] = row
    return index


def news_for(url: str) -> dict | None:
    return news_index().get(url)


def still_ok(news: dict, agency: bool = False) -> bool:
    """候補にしたときのニュースを、いまの条件でもう一度見る（条件を厳しくしたら、前に入れた候補にも効かせる）"""
    r = prtimes.Release(url=news.get("ニュース", ""), title=news.get("見出し", ""), company=news.get("社名", ""),
                        site=news.get("URL", ""), industry=news.get("業種", ""), listed=news.get("上場", ""),
                        capital=news.get("資本金", ""), signal=news.get("動き", ""))
    return (prtimes.judge_agency if agency else prtimes.judge)(r) == ""


def build_letter(company: str, title: str, signal: str, agency: bool = False) -> tuple[str, str]:
    title = title if len(title) <= TITLE_MAX else title[:TITLE_MAX - 1] + "…"
    text = (config.MESSAGE_AGENCY_TXT if agency else config.MESSAGE_FREE_TXT).read_text(encoding="utf-8")
    body = (text.replace("{社名}", company).replace("{見出し}", title)
            .replace("{書き出し}", OPENINGS.get(signal, OPENINGS["sales"])))
    return (SUBJECT_AGENCY if agency else SUBJECT).replace("{社名}", company)[:60], body.strip() + "\n"


def ready(mode: str, agency: bool = False) -> list[dict]:
    """まだ試していない候補のうち、いまの条件でも送り先にしてよいもの（お客さま向けと営業代行向けは混ざらない）"""
    index = news_index()
    return [c for c in pending(mode) if (n := index.get(c["URL"])) and still_ok(n, agency)]


def discover_more(mode: str, want: int, feed, agency: bool = False) -> int:
    """PR TIMES から、新しい候補を want 社まで足す（feed は prtimes.find の続き）"""
    if want <= 0:
        return 0
    known = load_companies()
    reg = Registry(known)
    added = 0
    for r in feed:
        why = (prtimes.judge_agency if agency else prtimes.judge)(r)
        entry = {"日時": f"{datetime.now():%Y-%m-%d %H:%M}", "社名": r.company, "URL": r.site, "段階": "候補",
                 "ニュース": r.url, "見出し": r.title, "動き": r.signal, "業種": r.industry, "上場": r.listed,
                 "資本金": r.capital, "代表者名": r.ceo, "対象外の理由": why}
        if agency:
            entry["種類"] = AGENCY_TAG
        if why or not r.company or reg.contains(r.company, r.site):
            entry["段階"] = "見送り"
            save_research(entry)
            continue
        reg.add(r.company, r.site)
        save_research(entry)
        append_rows(config.COMPANIES_CSV, COMPANY_FIELDS,
                    [{"社名": r.company, "URL": r.site, "所在地": "",
                      "業種": f"{AGENCY_TAG if agency else r.industry}（PR TIMES）"}])
        added += 1
        if added >= want:
            break
    log(f"送り先探し：{added}社を候補に追加")
    return added


def run(count: int, live: bool, headed: bool = False, wait: bool = True, agency: bool = False) -> None:
    from playwright.sync_api import sync_playwright

    from form_engine import precheck, process_company

    mode = MODE_LIVE if live else MODE_TEST
    skip_stuck(log)
    if live:
        count = min(count, config.DAILY_SEND_LIMIT - sent_today_count(load_results()))
        if count <= 0:
            log("本日の送信上限に達しています")
            return
    if agency:
        log("営業代行の会社に、下請け（協力会社）の売り込み")
        feed = iter(prtimes.find(known_release_urls(True), log=log, keywords=prtimes.AGENCY_KEYWORDS,
                                 check=prtimes.precheck_agency))
    else:
        feed = iter(prtimes.find(known_release_urls(), log=log))
    discover_more(mode, count * POOL_PER_SEND - len(ready(mode, agency)), feed, agency)
    log(f"{mode}モード：候補 {len(ready(mode, agency))}社 / 今回 最大{count}件")
    config.SCREENSHOT_DIR.mkdir(exist_ok=True)

    sent, tried, rounds, i = 0, set(), 0, 0
    with sync_playwright() as pw:
        b = Browser(pw, headed)
        try:
            while sent < count:
                c = next((x for x in ready(mode, agency) if x["URL"] not in tried), None)
                if c is None:   # 候補を使い切った → 探し足す
                    if rounds >= MAX_ROUNDS or not discover_more(mode, (count - sent) * POOL_PER_SEND, feed, agency):
                        log("候補が見つからないため、今日はここまで")
                        break
                    rounds += 1
                    continue
                i += 1
                tried.add(c["URL"])
                name, url = c["社名"], c["URL"]
                start_company(name, url, mode)
                page = b.new_page()
                timed_out = False
                try:
                    with time_limit(COMPANY_LIMIT_SEC):
                        out = precheck(page, url)
                    if out:
                        record_result(name, url, out.result, out.reason, mode)
                        log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                        continue
                    news = news_for(url)
                    subject, message = build_letter(name, news["見出し"], news.get("動き", ""), agency)
                    if sent and wait:
                        time.sleep(random.uniform(config.WAIT_MIN_SEC, config.WAIT_MAX_SEC))
                    shot = str(config.SCREENSHOT_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{mode}_{i}.png")
                    with time_limit(COMPANY_LIMIT_SEC):
                        out = process_company(page, name, url, message, live, shot, subject=subject)
                    record_result(name, url, out.result, out.reason, mode)
                    save_research({"日時": f"{datetime.now():%Y-%m-%d %H:%M}", "社名": name, "URL": url, "段階": "送信",
                                   "モード": mode, "件名": subject, "送った文面": message, "結果": out.result})
                    log(f"{i}社目：{out.result}（{out.reason[:40]}）")
                    if out.result == RESULT_SUCCESS or out.reason.startswith(SUBMITTED_PREFIX):
                        sent += 1
                except CompanyTimeout:
                    record_result(name, url, RESULT_SKIP, f"時間切れ（{COMPANY_LIMIT_SEC}秒で打ち切り）", mode)
                    log(f"{i}社目：スキップ（時間切れ）")
                    timed_out = True
                except Exception as e:  # 想定外のエラーでも記録して次へ
                    first = (str(e).splitlines() or [type(e).__name__])[0]
                    record_result(name, url, RESULT_FAIL, f"予期しないエラー: {first[:150]}", mode)
                    log(f"{i}社目：失敗（{type(e).__name__}）")
                finally:
                    if timed_out:
                        b.restart()
                    else:
                        b.close_page(page)
                    finish_company()
        finally:
            b.close()
    log(f"終了：{'送信' if live else 'テスト入力'} {sent}件")
