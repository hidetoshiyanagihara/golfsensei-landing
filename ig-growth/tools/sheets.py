"""管理シート（data/管理シート.xlsx）の書き出し・読み込み。

Google スプレッドシートで使う手順：
  Google ドライブにアップロード → 右クリック「アプリで開く」→ Google スプレッドシート →「ファイル」→「Google スプレッドシートとして保存」
数字を入れたあと、レポートを作るときは「ファイル」→「ダウンロード」→「Microsoft Excel（.xlsx）」で落とし、
`python tools/igtool.py import-sheet ダウンロードしたファイル.xlsx` で data/*.csv に取り込む。
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from common import (CALENDAR_CSV, CAPTIONS_CSV, FOLLOWERS_COLUMNS, FOLLOWERS_CSV, IDEAS_CSV, IMPROVEMENTS_CSV,
                    POSTS_LOG_COLUMNS, POSTS_LOG_CSV, ROOT, WORKBOOK_XLSX, load_brand, read_csv, to_number,
                    write_csv)

HEAD_FILL = PatternFill("solid", fgColor="1B2333")
HEAD_FONT = Font(color="FFFFFF", bold=True)
INPUT_FILL = PatternFill("solid", fgColor="FFF8E1")
CALC_FILL = PatternFill("solid", fgColor="EEF2F7")
PILLARS = ["A コピペ1発", "B 営業のAI", "C 言いにくいをAIに", "D AIのやらかし注意", "E 頼み方の型", "自己紹介（固定）", "—（実績まとめ）"]
HOOKS = ["場面直撃", "結果先出し", "一言だけ", "損失回避", "常識破壊", "あるある", "比較", "実験", "数字", "質問",
         "告白・失敗", "対象指名", "禁止", "続き物", "POV"]
CALC_COLS = [  # (見出し, 分子の列名, 倍率)
    ("保存率(%)", "保存", 100), ("シェア率(%)", "シェア", 100),
    ("プロフィール遷移率(%)", "プロフィールアクセス", 100), ("フォロー率(/1000リーチ)", "フォロー数", 1000),
]


def _header(ws, cols, widths=None):
    ws.append(cols)
    for i, _ in enumerate(cols, 1):
        c = ws.cell(row=1, column=i)
        c.fill, c.font = HEAD_FILL, HEAD_FONT
        c.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[get_column_letter(i)].width = (widths or {}).get(cols[i - 1], 14)
    ws.freeze_panes = "B2"


def _sheet_from_csv(wb, title, path, widths=None):
    rows = read_csv(path)
    if not rows:
        return
    ws = wb.create_sheet(title)
    cols = list(rows[0].keys())
    _header(ws, cols, widths)
    for r in rows:
        ws.append([r.get(c, "") for c in cols])
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = Alignment(wrap_text=True, vertical="top")


def export_workbook(path: Path = WORKBOOK_XLSX) -> Path:
    brand = load_brand()
    wb = Workbook()
    ws = wb.active
    ws.title = "使い方"
    guide = [
        "Instagram 運用 管理シート（ig-growth）",
        "",
        "黄色の列＝自分で入力する／青い列＝自動計算（触らない）。空欄＝未取得（0 と区別する。推測で埋めない）",
        "投稿実績：投稿の 24〜48 時間後に、アプリの「インサイトを見る」から書き写す",
        "フォロワー推移：毎朝フォロワー数だけ入れる。目標ラインと差が自動で出る",
        "週次集計：柱・フック型ごとのフォロー率などが自動で出る（docs/07 の判断ルールで使う）",
        "レポートを作るとき：ファイル → ダウンロード → Microsoft Excel → igtool.py import-sheet で取り込み",
        f"アカウント：{brand['handle']}　運用開始日：{brand['start_date']}",
    ]
    for g in guide:
        ws.append([g])
    ws.column_dimensions["A"].width = 110
    ws["A1"].font = Font(bold=True, size=14)

    _sheet_from_csv(wb, "投稿カレンダー", CALENDAR_CSV, {"テーマ": 34, "台本・構成": 50, "フック": 28, "CTA": 28,
                                                     "素材・ファイル": 30})

    # 投稿実績
    ws = wb.create_sheet("投稿実績")
    cols = POSTS_LOG_COLUMNS + [c[0] for c in CALC_COLS]
    _header(ws, cols, {"テーマ": 34, "投稿URL": 30, "メモ": 30})
    idx = {c: get_column_letter(i + 1) for i, c in enumerate(cols)}
    logs = read_csv(POSTS_LOG_CSV)
    n_rows = max(len(logs), 1) + 60
    for i in range(n_rows):
        r = logs[i] if i < len(logs) else {}
        row = i + 2
        vals = []
        for c in POSTS_LOG_COLUMNS:
            v = r.get(c, "")
            num = to_number(v) if c in POSTS_LOG_COLUMNS[11:22] or c == "尺(秒)" else None
            vals.append(num if (num is not None and str(v).strip() != "") else v)
        reach = idx["リーチ数"]
        for name, src, mult in CALC_COLS:
            s = idx[src]
            vals.append(f'=IF(OR({reach}{row}="",{s}{row}="",{reach}{row}=0),"未取得",{s}{row}/{reach}{row}*{mult})')
        ws.append(vals)
        for j, c in enumerate(cols, 1):
            cell = ws.cell(row=row, column=j)
            if c in POSTS_LOG_COLUMNS[10:22]:
                cell.fill = INPUT_FILL
            if c in [x[0] for x in CALC_COLS]:
                cell.fill = CALC_FILL
                cell.number_format = "0.00"
    for col_name, options in (("形式", ["リール", "カルーセル", "ストーリーズ"]), ("柱", PILLARS), ("フック型", HOOKS),
                              ("トライアル", ["する", ""])):
        dv = DataValidation(type="list", formula1='"' + ",".join(o for o in options if o) + '"', allow_blank=True)
        ws.add_data_validation(dv)
        dv.add(f"{idx[col_name]}2:{idx[col_name]}{n_rows + 1}")

    # フォロワー推移（運用開始日の前日から 90 日分）
    ws = wb.create_sheet("フォロワー推移")
    fcols = FOLLOWERS_COLUMNS + ["運用日数", "前日比", "目標ライン", "目標との差"]
    _header(ws, fcols, {"メモ": 30})
    start = dt.date.fromisoformat(brand["start_date"])
    existing = {r.get("日付", ""): r for r in read_csv(FOLLOWERS_CSV)}
    goals = [(0, 0)] + [tuple(g) for g in brand["goals"]]
    for i in range(0, 92):
        d = start + dt.timedelta(days=i - 1)
        row = i + 2
        e = existing.get(d.isoformat(), {})
        day_n = i  # 開始前日＝0日目
        # 目標ライン：(0,0)→(30,1000)→(60,3000)→(90,5000) を直線でつなぐ
        target = None
        for (d0, g0), (d1, g1) in zip(goals, goals[1:]):
            if d0 <= day_n <= d1:
                target = round(g0 + (g1 - g0) * (day_n - d0) / (d1 - d0))
                break
        vals = [d.isoformat()] + [to_number(e.get(c)) if c != "メモ" and to_number(e.get(c)) is not None
                                  else e.get(c, "") for c in FOLLOWERS_COLUMNS[1:]]
        vals += [day_n, f'=IF(OR(B{row}="",B{row - 1}="",ROW()=2),"",B{row}-B{row - 1})' if row > 2 else "",
                 target if target is not None else "", f'=IF(OR(B{row}="",H{row}=""),"",B{row}-H{row})']
        ws.append(vals)
        for j in range(2, 5):
            ws.cell(row=row, column=j).fill = INPUT_FILL
        for j in range(6, 10):
            ws.cell(row=row, column=j).fill = CALC_FILL

    # 週次集計（柱・フック型ごと）
    ws = wb.create_sheet("集計")
    _header(ws, ["区分", "値", "本数（数字あり）", "平均フォロー率(/1000)", "平均保存率(%)", "平均シェア率(%)", "判断"],
            {"値": 22, "判断": 30})
    L = {c: idx[c] for c in cols}
    last = n_rows + 1
    rng = lambda c: f"投稿実績!${L[c]}$2:${L[c]}${last}"
    for kind, values in (("柱", PILLARS[:5]), ("フック型", HOOKS), ("形式", ["リール", "カルーセル"])):
        for v in values:
            row = ws.max_row + 1
            fr, sr, shr = rng("フォロー率(/1000リーチ)"), rng("保存率(%)"), rng("シェア率(%)")
            ws.append([kind, v,
                       f'=COUNTIFS({rng(kind)},B{row},{fr},">=0")',
                       f'=IFERROR(AVERAGEIFS({fr},{rng(kind)},B{row}),"未取得")',
                       f'=IFERROR(AVERAGEIFS({sr},{rng(kind)},B{row}),"未取得")',
                       f'=IFERROR(AVERAGEIFS({shr},{rng(kind)},B{row}),"未取得")',
                       f'=IF(C{row}<2,"サンプル不足（判断しない）","")'])
            for j in range(4, 7):
                ws.cell(row=row, column=j).number_format = "0.00"

    _sheet_from_csv(wb, "改善案", IMPROVEMENTS_CSV, {"根拠（データ・出典）": 30, "気づき・仮説": 40, "施策": 40})
    _sheet_from_csv(wb, "次回候補", IDEAS_CSV, {"テーマ案": 40, "フック案": 34})
    _sheet_from_csv(wb, "キャプション", CAPTIONS_CSV, {"キャプション": 60, "全文": 60})
    _sheet_from_csv(wb, "競合調査", ROOT / "docs" / "competitor_research_sheet.csv")
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def import_workbook(path: Path) -> tuple[int, int]:
    """Google スプレッドシートから書き出した xlsx の「投稿実績」「フォロワー推移」を CSV に取り込む。"""
    wb = load_workbook(path, data_only=True)
    n_posts = n_fol = 0
    if "投稿実績" in wb.sheetnames:
        ws = wb["投稿実績"]
        head = [c.value for c in ws[1]]
        rows = []
        for vals in ws.iter_rows(min_row=2, values_only=True):
            r = {h: ("" if v is None else v) for h, v in zip(head, vals) if h}
            if not str(r.get("投稿ID", "")).strip():
                continue
            for k, v in r.items():
                if isinstance(v, float) and v.is_integer():
                    r[k] = int(v)
                if isinstance(v, (dt.date, dt.datetime)):
                    r[k] = v.strftime("%Y-%m-%d")
            rows.append({k: str(v) for k, v in r.items()})
        write_csv(POSTS_LOG_CSV, rows, POSTS_LOG_COLUMNS)
        n_posts = len(rows)
    if "フォロワー推移" in wb.sheetnames:
        ws = wb["フォロワー推移"]
        head = [c.value for c in ws[1]]
        rows = []
        for vals in ws.iter_rows(min_row=2, values_only=True):
            r = dict(zip(head, vals))
            if r.get("フォロワー数") in (None, ""):
                continue
            d = r.get("日付")
            d = d.strftime("%Y-%m-%d") if isinstance(d, (dt.date, dt.datetime)) else str(d)
            row = {"日付": d}
            for c in FOLLOWERS_COLUMNS[1:]:
                v = r.get(c)
                row[c] = "" if v is None else str(int(v) if isinstance(v, float) and v.is_integer() else v)
            rows.append(row)
        write_csv(FOLLOWERS_CSV, rows, FOLLOWERS_COLUMNS)
        n_fol = len(rows)
    return n_posts, n_fol
