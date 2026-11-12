"""スターストラックのフォーム営業のテスト（ネットにはつながない）:  python tests/run_starstruck.py"""
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import config  # noqa: E402
import starstruck  # noqa: E402
from common import COMPANY_FIELDS, MODE_LIVE, RESULT_FIELDS, append_rows  # noqa: E402

failures = []


def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        failures.append(msg)


tmp = Path(tempfile.mkdtemp())
starstruck.PATHS = {k: tmp / v.name for k, v in starstruck.PATHS.items()}

print("== 送らない会社")
# 実際に外す会社の名前はリポジトリに書かない（公開のため）。ここでは仮の会社で仕組みを確かめる
real = set(starstruck.EXCLUDE)
check(len(real) >= 2, "指示のあった会社の指紋（社名・ドメイン）が入っている")
starstruck.EXCLUDE |= {starstruck.fingerprint("外す管理"), starstruck.fingerprint("skip.example.jp")}
check(starstruck.excluded("外す管理株式会社", ""), "社名で外す")
check(starstruck.excluded("(株)外す管理", ""), "(株) の書き方でも外す")
check(starstruck.excluded("", "https://www.skip.example.jp/contact/"), "ドメインでも外す")
check(not starstruck.excluded("株式会社アイホーム", "http://www.kk-aihome.co.jp"), "ほかの会社は外さない")

print("== 文面")
subject, body = starstruck.build_letter({"社名": "株式会社テスト管理", "所在地": "支店:名古屋支店"})
check(body.startswith("株式会社テスト管理\n名古屋支店　ご担当者様"), "支店には支店名で宛てる")
check("株式会社スターストラック" in body and "AXION" not in body and "アクシオン" not in body, "AXION の名前は出さない")
check(starstruck.SENDER["email"] in body and "{" not in body, "差し込み漏れがない")
check(len(subject) <= 60, "件名は60字以内")
_, body = starstruck.build_letter({"社名": "株式会社テスト管理", "所在地": "本社:"})
check("\nご担当者様" in body, "本社は「ご担当者様」")
check(starstruck.branch_of("(株)穴吹コミュニティ　名古屋営業部") == "名古屋営業部", "一覧の名前から支店名を取り出す")
check(starstruck.branch_of("(株)アイホーム") == "", "本社には支店名がない")

print("== 送り先の順番と再送")
with starstruck.own_files():
    check(config.RESULT_CSV.name == "ss_result.csv", "記録は AXION とは別のファイル")
    append_rows(config.COMPANIES_CSV, COMPANY_FIELDS, [
        {"社名": "支店の会社", "URL": "https://a.example.jp/", "所在地": "支店:名古屋支店", "業種": ""},
        {"社名": "本社の会社", "URL": "https://b.example.jp/", "所在地": "本社:", "業種": ""},
        {"社名": "外す管理株式会社", "URL": "https://skip.example.jp/", "所在地": "本社:", "業種": ""},
        {"社名": "送った会社", "URL": "https://c.example.jp/", "所在地": "本社:", "業種": ""},
        {"社名": "賃貸の管理会社", "URL": "https://d.example.jp/", "所在地": "本社:", "業種": starstruck.INDUSTRY_JPM},
    ])
    append_rows(config.RESULT_CSV, RESULT_FIELDS, [
        {"社名": "送った会社", "URL": "https://c.example.jp/", "結果": "成功", "理由": "", "日時": "2026-11-08 10:00", "モード": MODE_LIVE}])
    names = [c["社名"] for c in starstruck.pending(MODE_LIVE)]
    check(names == ["本社の会社", "支店の会社"], f"本社が先、送った会社と送らない会社は出さない（{names}）")
print("== 途中で止まった会社")
with starstruck.own_files():
    import common
    common.start_company("支店の会社", "https://a.example.jp/", MODE_LIVE)
    check(config.INFLIGHT_JSON.exists(), "処理中の会社を書いておく")
    common.skip_stuck(log=lambda m: None)
    check(not config.INFLIGHT_JSON.exists(), "次の回の始めに印を消す")
    names = [c["社名"] for c in starstruck.pending(MODE_LIVE)]
    check(names == ["本社の会社"], f"止まった会社は二度と試さない（{names}）")
    common.skip_stuck(log=lambda m: None)
    check(len(common.load_results()) == 2, "印がなければ何もしない")
check(config.RESULT_CSV.name == "result.csv", "終わったら AXION のファイルに戻す")

print("\n結果: " + ("すべて成功" if not failures else f"{len(failures)}件 失敗"))
sys.exit(1 if failures else 0)
