"""SaaS向け自動営業の通しテスト:  python tests/run_saas.py
AI（Claude）は差し替え、送信先はローカルの疑似サイトだけ。実在の会社やAIにはアクセスしない。"""
import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.0/8,localhost," + os.environ.get("NO_PROXY", "")

import config  # noqa: E402
import fixture_server  # noqa: E402

tmp = Path(tempfile.mkdtemp())
for name in ("COMPANIES_CSV", "NG_LIST_CSV", "RESULT_CSV", "COLLECT_STATE", "RESEARCH_JSONL", "DISCOVER_STATE"):
    setattr(config, name, tmp / getattr(config, name).name)
config.SCREENSHOT_DIR = tmp / "screenshots"
shutil.copy(HERE.parent / "ng_list.csv", config.NG_LIST_CSV)

import ai  # noqa: E402
import common  # noqa: E402
import saas  # noqa: E402
import vault  # noqa: E402

fixture_server.serve()
P = fixture_server.PORT
failures = []


def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        failures.append(msg)


def posts():
    return json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())


BODY = ("御社の勤怠クラウドは、従業員30名前後の飲食店や小売店を主なお客さまにされていると拝読しました。"
        "直近では資金調達を発表され、インサイドセールスの方を募集されています。\n\n"
        "同じ分野には比較サイトで並ぶサービスが多い中、店舗のシフトに強い点が御社の持ち味だと考えました。"
        "そこで、複数店舗を持つ飲食・小売の会社に絞ってリストを作り、問い合わせフォームと電話で商談の機会をつくる形が合うのではないかと考えました。\n\n"
        "量はAIと自動化でこなし、文面と反応はすべて共有します。採用が決まるまでの間の商談づくりにもお役に立てると思います。")
discovered = [
    {"name": "株式会社テスト工務店", "url": f"http://127.0.0.11:{P}/", "product": "勤怠クラウド", "customers": "店舗",
     "signal": "資金調達", "source": "https://example.com/news"},
    {"name": "株式会社ディブ空調", "url": f"http://127.0.0.16:{P}/", "product": "大企業向けERP", "customers": "大企業",
     "signal": "", "source": ""},
    {"name": "お断り建設", "url": f"http://127.0.0.12:{P}/", "product": "予約SaaS", "customers": "店舗",
     "signal": "", "source": ""},
]
calls = {"discover": 0, "research": 0, "write": 0}


def fake_discover(focus, exclude, want=15):
    calls["discover"] += 1
    return [c for c in discovered if c["name"] not in exclude]


def fake_research(name, url, site_text):
    calls["research"] += 1
    return f"{name}の調査メモ（サイト本文 {len(site_text)}字）"


def fake_write(name, notes):
    calls["write"] += 1
    analysis = {k: "メモ" for k in ("product", "stage", "sales_signals", "competitors", "needed_support", "appeal")}
    if "ディブ" in name:
        return {"fit": "skip", "skip_reason": "大企業だけに売っている", "analysis": analysis, "subject": "", "body": ""}
    return {"fit": "send", "skip_reason": "", "analysis": analysis, "subject": "勤怠クラウドの店舗向け商談づくりについて",
            "body": BODY}


ai.discover, ai.research, ai.write = fake_discover, fake_research, fake_write

print("== 営業文のルール")
check(ai.check_letter("件名", BODY) == [], "ルールを守った文面は通す")
check(any("使わない言葉" in e for e in ai.check_letter("件名", BODY + "必ず成果が出ます。")), "「必ず」は書き直させる")
check(any("使わない言葉" in e for e in ai.check_letter("件名", BODY + "月額10万円から")), "料金は書き直させる")
check(any("本文が" in e for e in ai.check_letter("件名", "短い")), "短すぎる本文は書き直させる")

print("== テストモード（入力のみ）")
saas.run(5, live=False, wait=False)
res = {r["社名"]: r for r in common.load_results() if r["モード"] == "テスト"}
for k, v in res.items():
    print(f"     {k}: {v['結果']} / {v['理由']}")
check(calls["discover"] >= 1 and len(common.load_companies()) == 3, "候補を探して companies.csv に追加")
check(res["株式会社テスト工務店"]["結果"] == "成功", "調査→文面→フォーム入力")
check(res["株式会社ディブ空調"]["理由"].startswith("対象外"), "調査で対象外と判断した会社は送らない")
check("営業お断り" in res["お断り建設"]["理由"] and calls["research"] == 2, "営業お断りの会社はAIで調べる前に外す")
check(posts() == [], "テストモードでは送信しない")
rows = [json.loads(x) for x in config.RESEARCH_JSONL.read_text(encoding="utf-8").splitlines()]
sent_row = next(r for r in rows if r.get("送った文面"))
check(sent_row["送った文面"].startswith("株式会社テスト工務店\nご担当者様") and BODY in sent_row["送った文面"]
      and "見込み" not in BODY and "リスト20件" in sent_row["送った文面"] and "ご放念ください" in sent_row["送った文面"],
      "宛名・本文・無料リスト・結びを組み立てる")

print("== 本番モード（疑似サイトへ送信）")
before = dict(calls)
saas.run(5, live=True, wait=False)
live = {r["社名"]: r for r in common.load_results() if r["モード"] == "本番"}
for k, v in live.items():
    print(f"     {k}: {v['結果']} / {v['理由']}")
p = next((x["data"] for x in posts() if x["host"] == "127.0.0.11"), {})
check(live["株式会社テスト工務店"]["結果"] == "成功", "送信して完了を判定")
check(calls["research"] == before["research"], "テストで作った文面を使い回す（調べ直さない）")
check(BODY.split("\n")[0] in p.get("body", [""])[0].replace("\r\n", "\n"), "会社ごとの本文を送る")
check("株式会社ディブ空調" not in live, "対象外の会社は本番でも調べ直さない")
n = len(posts())
saas.run(5, live=True, wait=False)
check(len(posts()) == n, "送信済みの会社には再送しない")

print("== 暗号化して保存")
os.environ["FORM_STATE_KEY"] = "テスト用の合言葉 correct horse battery staple"
vault.STATE_ENC = tmp / "state.enc"
vault.FILES = [config.COMPANIES_CSV, config.NG_LIST_CSV, config.RESULT_CSV, config.RESEARCH_JSONL, config.DISCOVER_STATE]
config.BASE_DIR = tmp
vault.close_state()
enc = vault.STATE_ENC.read_bytes()
check("テスト工務店".encode() not in enc and "テスト工務店".encode("utf-8-sig") not in enc, "保存ファイルに会社名が平文で残らない")
original = config.RESULT_CSV.read_text(encoding="utf-8-sig")
config.RESULT_CSV.unlink()
vault.open_state()
check(config.RESULT_CSV.read_text(encoding="utf-8-sig") == original, "復号すると元に戻る")

print(f"\n結果: {'すべて成功' if not failures else str(len(failures)) + ' 件失敗'}  (作業ディレクトリ: {tmp})")
sys.exit(1 if failures else 0)
