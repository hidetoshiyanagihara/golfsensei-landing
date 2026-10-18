"""ローカル疑似サイトを使った通しテスト:  python tests/run_e2e.py
実際の会社には一切アクセス・送信しない（127.0.0.x のみ）。"""
import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.0/8,localhost," + os.environ.get("NO_PROXY", "")

import config  # noqa: E402
import fixture_server  # noqa: E402

tmp = Path(tempfile.mkdtemp())
for name in ("COMPANIES_CSV", "NG_LIST_CSV", "RESULT_CSV", "COLLECT_STATE"):
    setattr(config, name, tmp / getattr(config, name).name)
config.SCREENSHOT_DIR = tmp / "screenshots"
shutil.copy(HERE.parent / "ng_list.csv", config.NG_LIST_CSV)
config.WAIT_MIN_SEC = config.WAIT_MAX_SEC = 0
config.NAGOYA_WARDS = ["中区"]
config.INDUSTRY_QUERIES = {"工務店": ["工務店"]}

import collect  # noqa: E402
import common  # noqa: E402
import main  # noqa: E402

collect.DDG_URL = f"http://127.0.0.2:{fixture_server.PORT}/html/"
collect.SEARCH_SLEEP = collect.SITE_SLEEP = (0, 0)

fixture_server.serve()
P = fixture_server.PORT
failures = []


def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        failures.append(msg)


print("== 1. リスト作成")
found = collect.collect(100, log=lambda m: print("   ", m))
rows = common.load_companies()
names = {r["社名"] for r in rows}
check("有限会社みどり設備" in names, "小規模・名古屋市の会社を追加")
check("株式会社ちくさリフォーム" in names, "コピーライト表記から社名を特定")
check("株式会社テスト工務店" in names, "会社概要から社名を特定")
check(not any("大手" in n or "トヨタ外" in n or "なかむら" in n for n in names), "上場/名古屋市外/従業員100名超を除外")
check(all(r["所在地"].startswith("愛知県名古屋市") for r in rows), "所在地を取得")
check(rows[0]["社名"] in ("有限会社みどり設備", "株式会社テスト工務店"), "従業員数が判明している会社を優先")
again = collect.collect(100, log=lambda m: None)
check(len(again) == 0 and len(common.load_companies()) == len(rows), "2回目の実行で重複追加しない")

# 送信テスト用の会社を追加
common.append_rows(config.COMPANIES_CSV, common.COMPANY_FIELDS, [
    {"社名": "お断り建設", "URL": f"http://127.0.0.12:{P}/"},
    {"社名": "キャプチャ設備", "URL": f"http://127.0.0.13:{P}/"},
    {"社名": "フォーム無し電気", "URL": f"http://127.0.0.14:{P}/"},
    {"社名": "必須多すぎ不動産", "URL": f"http://127.0.0.15:{P}/"},
    {"社名": "株式会社ディブ空調", "URL": f"http://127.0.0.16:{P}/"},
    {"社名": "見えない認証住宅", "URL": f"http://127.0.0.17:{P}/"},
    {"社名": "NG登録株式会社", "URL": "http://ng.example.invalid/"},
])
common.append_rows(config.NG_LIST_CSV, common.NG_FIELDS, [{"社名": "NG登録", "URL": "", "理由": "test"}])
# 検索で拾った 127.0.0.21/25 は送信対象から外す（フォームが無い疑似サイト）
common.append_rows(config.NG_LIST_CSV, common.NG_FIELDS, [
    {"社名": "", "URL": f"http://127.0.0.21:{P}/"}, {"社名": "", "URL": f"http://127.0.0.25:{P}/"}])

args = SimpleNamespace(mode="test", count=10, retest=False, no_wait=True, headed=False, yes=True)
print("== 2. テストモード")
main.cmd_send(args)
res = {r["社名"]: r for r in common.load_results() if r["モード"] == "テスト"}
for k, v in res.items():
    print(f"     {k}: {v['結果']} / {v['理由']}")
check(res["株式会社テスト工務店"]["結果"] == "成功", "表形式フォーム: 入力成功")
check(res["株式会社ディブ空調"]["結果"] == "成功", "div形式フォーム: 入力成功（営業時間の記載は誤検知しない）")
check("営業お断り" in res["お断り建設"]["理由"], "営業お断り → スキップ")
check("reCAPTCHA" in res["キャプチャ設備"]["理由"] or "認証" in res["キャプチャ設備"]["理由"], "reCAPTCHA → スキップ")
check("フォームが見つからない" in res["フォーム無し電気"]["理由"], "フォーム無し → スキップ")
check(res["見えない認証住宅"]["結果"] == "成功", "見えない reCAPTCHA v3 は入力対象")
check("必須欄" in res["必須多すぎ不動産"]["理由"], "埋められない必須欄 → スキップ")
check(res.get("NG登録株式会社", {}).get("理由") == "NGリスト", "NGリスト → スキップ")
posts = json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())
check(posts == [], "テストモードでは送信しない")
shots = list(config.SCREENSHOT_DIR.glob("*.png"))
check(len(shots) == 3, f"スクリーンショット保存 ({len(shots)}枚)")

print("== 3. 本番モード（疑似サイトへ送信）")
args.mode, args.no_wait = "live", False
main.cmd_send(args)
live = {r["社名"]: r for r in common.load_results() if r["モード"] == "本番"}
for k, v in live.items():
    print(f"     {k}: {v['結果']} / {v['理由']}")
posts = json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())
a = next((p["data"] for p in posts if p["host"] == "127.0.0.11"), {})
f = next((p["data"] for p in posts if p["host"] == "127.0.0.16"), {})
check(live["株式会社テスト工務店"]["結果"] == "成功", "確認画面→送信→完了画面を判定")
check(live["株式会社ディブ空調"]["結果"] == "成功", "Ajax送信の完了表示を判定")
check(live["見えない認証住宅"]["結果"] == "成功", "見えない reCAPTCHA v3 のサイトに送信")
v = lambda d, k: d.get(k, [""])[0]
check(v(a, "sei") == "柳原" and v(a, "mei") == "秀俊", "姓/名の分割入力")
check(v(a, "sei_kana") == "ヤナギハラ" and v(a, "mei_kana") == "ヒデトシ", "フリガナ（カタカナ）")
check((v(a, "tel1"), v(a, "tel2"), v(a, "tel3")) == ("090", "6616", "4210"), "電話番号の3分割")
check(v(a, "zip") == "4500002", "郵便番号（ハイフンなし指定）")
check(v(a, "address") == "愛知県名古屋市中村区名駅3-4-10 アルティメイト名駅1st 2階", "住所")
check(v(a, "kind") == "other", "問い合わせ種別で「その他」を選択")
check(v(a, "agree") == "1", "同意チェック")
check(v(a, "email2") == config.SENDER["email"], "確認用メール")
check(v(a, "body").replace("\r\n", "\n").startswith("株式会社テスト工務店\nご担当者様\n\n突然のご連絡"), "本文の{社名}置換（message.txt）")
check(v(a, "company") == config.SENDER["company"], "会社名")
check(v(f, "your-company") == "AXION SALES", "文字数制限のある欄は短縮社名")
check(v(f, "your-kana") == "やなぎはら ひでとし", "ふりがな（ひらがな）")
check(v(f, "your-tel") == "09066164210", "電話番号（桁数制限→ハイフンなし）")
check(v(f, "cat") == "その他のお問い合わせ" and v(f, "pref") == "愛知県", "select の選択")
check(v(f, "addr") == "名古屋市中村区名駅3-4-10 アルティメイト名駅1st 2階", "都道府県欄がある場合の住所")
check(v(f, "your-subject") == config.SENDER["subject"], "件名")
n_posts = len(posts)
main.cmd_send(args)
posts = json.loads(urllib.request.urlopen(f"http://127.0.0.11:{P}/__posts").read())
check(len(posts) == n_posts, "送信済みの会社には再送しない")

print(f"\n結果: {'すべて成功' if not failures else str(len(failures)) + ' 件失敗'}  (作業ディレクトリ: {tmp})")
sys.exit(1 if failures else 0)
