"""無料版フォーム営業の通しテスト:  python tests/run_free.py
PR TIMES の読み取りは保存した見本で、送信はローカルの疑似サイトだけで確かめる（実在の会社・AIにはアクセスしない）。"""
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

import common  # noqa: E402
import free  # noqa: E402
import prtimes  # noqa: E402

fixture_server.serve()
P = fixture_server.PORT
failures = []
FX = HERE / "fixtures"


def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        failures.append(msg)


print("== PR TIMES の読み取り")
rss = prtimes.parse_rss((FX / "prtimes_index.rdf").read_text(encoding="utf-8"))
check([(r.company, r.title) for r in rss] == [("株式会社テストSaaS", "テストSaaS、シリーズAで3億円の資金調達を実施"),
                                             ("テスト食堂", "秋の新メニューが登場")],
      "新着RSSから見出しと社名を読む")
kw = prtimes.parse_list((FX / "prtimes_keyword.html").read_text(encoding="utf-8"))
check(len(kw) == 1 and kw[0].title == "業務管理クラウドの新機能を提供開始", "キーワード一覧から見出しを読む（同じリンクは1回）")
info = prtimes.parse_company((FX / "prtimes_release.html").read_text(encoding="utf-8"))
check(info["社名"] == "株式会社テストSaaS" and info["URL"] == "https://example-saas.test" and info["業種"] == "情報通信"
      and info["上場"] == "未上場" and info["代表者名"] == "山田 太郎", "ニュースのページから会社情報を読む")
check(prtimes.capital_yen("1億2,000万円") == 120_000_000 and prtimes.capital_yen("7152万円") == 71_520_000, "資本金を円に直す")
check([prtimes.signal_of(t) for t in ("シリーズAで資金調達", "新機能を提供開始", "営業組織を強化", "秋の新メニュー")]
      == ["funding", "launch", "sales", ""], "見出しから動きを見分ける")
R = prtimes.Release
base = dict(url="u", site="https://a.test", industry="情報通信", listed="未上場", capital="1億円", signal="funding")
check(prtimes.judge(R(title="シリーズAで資金調達", company="株式会社A", **base)) == "", "未上場のIT企業の資金調達は送り先にする")
check(prtimes.judge(R(title="シリーズAで資金調達", company="株式会社A", **{**base, "listed": "東証グロース"})) == "上場企業", "上場企業は外す")
check(prtimes.judge(R(title="営業代行サービスを開始", company="株式会社B", **base)) != "", "同業（営業代行）は外す")
check(prtimes.judge(R(title="新サービス提供開始", company="NTTテスト株式会社", **base)) == "大手グループの会社", "大手グループは外す")
check(prtimes.judge(R(title="旅行アプリに新機能", company="株式会社C", **{**base, "signal": "launch"})) != "",
      "個人向けアプリの新機能は外す")

print("== 送り先探し→テスト→本番（疑似サイト）")
releases = [
    R(url="https://prtimes.jp/r/1", title="テスト工務店、シリーズAで3億円の資金調達を実施", company="株式会社テスト工務店",
      site=f"http://127.0.0.11:{P}/", industry="情報通信", listed="未上場", capital="1億円", signal="funding"),
    R(url="https://prtimes.jp/r/2", title="営業お断りの会社、新サービスを提供開始", company="お断り建設",
      site=f"http://127.0.0.12:{P}/", industry="情報通信", listed="未上場", capital="1億円", signal="launch"),
    R(url="https://prtimes.jp/r/3", title="大手の新サービス", company="上場株式会社",
      site=f"http://127.0.0.16:{P}/", industry="情報通信", listed="東証プライム", capital="100億円", signal="launch"),
]
seen = []
prtimes.find = lambda known, log=print: (seen.append(set(known)), releases)[1]
free.run(5, live=False, wait=False)
res = {r["社名"]: r for r in common.load_results() if r["モード"] == "テスト"}
for k, v in res.items():
    print(f"     {k}: {v['結果']} / {v['理由']}")
check(res["株式会社テスト工務店"]["結果"] == "成功", "決まった文面でフォームに入力（テスト）")
check("営業お断り" in res["お断り建設"]["理由"], "営業お断りの会社は送らない")
check("上場株式会社" not in res and len(common.load_companies()) == 2, "上場企業は候補に入れない")
posts = json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())
check(posts == [], "テストでは送信しない")

free.run(5, live=True, wait=False)
check({"https://prtimes.jp/r/1", "https://prtimes.jp/r/3"} <= seen[-1] and len(common.load_companies()) == 2,
      "見たニュース（見送った分も）は二度候補にしない")
posts = json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())
body = next((p["data"] for p in posts if p["host"] == "127.0.0.11"), {}).get("body", [""])[0].replace("\r\n", "\n")
check(body.startswith("株式会社テスト工務店\nご担当者様") and "「テスト工務店、シリーズAで3億円の資金調達を実施」のニュースを拝見" in body
      and free.OPENINGS["funding"] in body and "リスト20件" in body and "ご放念ください" in body,
      "社名・ニュースの見出し・動きに合わせた書き出しを入れて送る")
n = len(posts)
free.run(5, live=True, wait=False)
check(len(json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())) == n, "送信済みの会社には再送しない")
long_title = "あ" * 80
check("「" + "あ" * (free.TITLE_MAX - 1) + "…」" in free.build_letter("株式会社X", long_title, "")[1], "長い見出しは途中で切る")

print(f"\n結果: {'すべて成功' if not failures else str(len(failures)) + ' 件失敗'}  (作業ディレクトリ: {tmp})")
sys.exit(1 if failures else 0)
