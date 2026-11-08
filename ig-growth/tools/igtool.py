#!/usr/bin/env python3
"""ig-growth の制作・管理ツール（すべて無料・オフラインで動く。insights だけ任意で公式 API を使う）

使い方（ig-growth フォルダで）:
  python tools/igtool.py all                 # 画像・字幕・キャプション一覧・投稿実績の行・管理シートをまとめて作る＋検査
  python tools/igtool.py render [C03 R01…]   # カルーセル・リール表紙・字幕・ストーリーズ背景・アイコンを作る
  python tools/igtool.py check               # 文字数・ハッシュタグ数・テロップ・文字のはみ出し・プロンプト番号を検査
  python tools/igtool.py captions            # content/captions.csv（キャプション管理）を作る
  python tools/igtool.py calendar --start 2026-11-16   # カレンダーの日付を運用開始日に合わせて振り直す
  python tools/igtool.py sync-log            # カレンダーの投稿を data/posts_log.csv に行として追加（数字は空欄）
  python tools/igtool.py report [--start YYYY-MM-DD --end YYYY-MM-DD]   # 週次レポート（既定：直近7日）
  python tools/igtool.py workbook            # data/管理シート.xlsx（Google スプレッドシート用）を作る
  python tools/igtool.py import-sheet FILE.xlsx        # スプレッドシートから落とした xlsx を data/*.csv に取り込む
  python tools/igtool.py insights [--days 30]          # （任意）公式 API でインサイトを取得（要 IG_GROWTH_TOKEN）
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (CALENDAR_CSV, CAPTIONS_CSV, OUTPUT, POSTS_LOG_COLUMNS, POSTS_LOG_CSV, ROOT, load_brand,  # noqa: E402
                    read_csv, write_csv)
import content  # noqa: E402

CAPTION_MAX = 2200
HASHTAG_MAX = 5
RISKY = re.compile(r"(\d+\s*(分|時間|%|％)\s*(短縮|削減|カット))|月\s*\d+\s*万|必ず稼|絶対|最強|神ツール")


# ---------------------------------------------------------------- 制作
def cmd_render(ids: list[str] | None = None, quiet: bool = False) -> list[str]:
    import render
    brand = load_brand()
    made = []
    for it in content.load_items(ids=ids or None):
        if it.kind == "carousel" and it.slides:
            paths = render.Carousel(it.id, it.slides, brand).render(OUTPUT / "carousels" / it.id)
            made.append(f"{it.id}: カルーセル {len(paths)}枚")
        if it.kind == "reel":
            if it.cover:
                render.render_reel_cover(it.id, it.cover, brand, OUTPUT / "reels" / f"{it.id}_cover.jpg")
            if it.telops:
                (OUTPUT / "reels").mkdir(parents=True, exist_ok=True)
                (OUTPUT / "reels" / f"{it.id}.srt").write_text(content.to_srt(it.telops), encoding="utf-8")
            made.append(f"{it.id}: 表紙＋字幕")
        # 投稿のお知らせストーリーズ（自動投稿用）
        if it.kind == "reel" and it.cover:
            cover_img, story_title = OUTPUT / "reels" / f"{it.id}_cover.jpg", it.cover.get("title", "")
        elif it.kind == "carousel" and it.slides:
            cover_img, story_title = OUTPUT / "carousels" / it.id / "01.jpg", it.slides[0].get("title", "")
        else:
            continue
        render.render_story_announce(it.id, story_title, cover_img, brand, OUTPUT / "stories" / "auto" / f"{it.id}.jpg")
    if not ids:
        render.render_story_templates(brand, OUTPUT / "stories")
        render.render_brand(brand, OUTPUT / "brand")
        made.append("ストーリーズ背景・アイコン・ハイライト表紙")
    write_gallery()
    import prompts_page
    made.append("プロンプト集ページ " + prompts_page.write_page())
    if not quiet:
        print("\n".join(made))
        for w in render.warnings:
            print("⚠", w)
    return render.warnings


def cmd_captions() -> Path:
    cal = {r["ID"]: r for r in read_csv(CALENDAR_CSV)}
    rows = []
    for it in content.load_items():
        c = cal.get(it.id, {})
        full = it.full_caption()
        rows.append({"ID": it.id, "形式": "リール" if it.kind == "reel" else "カルーセル",
                     "投稿予定": f"{c.get('日付', '')} {c.get('時刻', '')}".strip(), "タイトル": it.title,
                     "キャプション": it.caption, "ハッシュタグ": " ".join(it.hashtags),
                     "文字数（全文）": len(full), "全文": full, "状態": c.get("状態", "")})
    write_csv(CAPTIONS_CSV, rows, ["ID", "形式", "投稿予定", "タイトル", "キャプション", "ハッシュタグ", "文字数（全文）",
                                   "全文", "状態"])
    print(f"{CAPTIONS_CSV.relative_to(ROOT)}：{len(rows)}件")
    return CAPTIONS_CSV


def cmd_calendar(start: str) -> None:
    d0 = dt.date.fromisoformat(start)
    rows = read_csv(CALENDAR_CSV)
    for r in rows:
        d = d0 + dt.timedelta(days=int(r["Day"]) - 1)
        r["日付"], r["曜日"] = d.isoformat(), "月火水木金土日"[d.weekday()]
    write_csv(CALENDAR_CSV, rows, list(rows[0].keys()))
    brand_path = ROOT / "brand.json"
    brand_path.write_text(re.sub(r'"start_date":\s*"[^"]*"', f'"start_date": "{start}"',
                                 brand_path.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"Day1 = {start} で {len(rows)} 行の日付を振り直しました（brand.json の start_date も更新）")
    print("投稿実績の日付も直すには data/posts_log.csv の未投稿の行を消してから sync-log を実行してください")


def cmd_sync_log() -> int:
    logs = read_csv(POSTS_LOG_CSV)
    have = {r["投稿ID"] for r in logs}
    items = {it.id: it for it in content.load_items()}
    added = 0
    for r in logs:  # 台本があとから書かれた行は、フック型・尺を埋める
        it = items.get(r["投稿ID"])
        if it and not r.get("フック型"):
            r["フック型"] = it.meta.get("フック型", "")
        if it and it.telops and not r.get("尺(秒)"):
            r["尺(秒)"] = str(int(round(it.telops[-1].end)))
    for r in read_csv(CALENDAR_CSV):
        if r["形式"] not in ("リール", "カルーセル") or r["ID"] in have:
            continue
        it = items.get(r["ID"])
        dur = ""
        if it and it.telops:
            dur = str(int(round(it.telops[-1].end)))
        elif it is None and r["形式"] == "リール":
            dur = "20"
        logs.append({"投稿ID": r["ID"], "投稿日": r["日付"], "時刻": r["時刻"] if ":" in r["時刻"] else "",
                     "形式": r["形式"], "柱": r["柱"], "テーマ": r["テーマ"],
                     "フック型": (it.meta.get("フック型", "") if it else ""), "尺(秒)": dur,
                     "トライアル": r.get("トライアル", "")})
        added += 1
    logs.sort(key=lambda r: (r.get("投稿日", ""), r.get("時刻", "")))
    write_csv(POSTS_LOG_CSV, logs, POSTS_LOG_COLUMNS)
    print(f"data/posts_log.csv：{added}行を追加（合計 {len(logs)} 行）。数字の列は空欄＝未取得のまま")
    return added


def cmd_workbook() -> None:
    import sheets
    p = sheets.export_workbook()
    print(f"{p.relative_to(ROOT)} を作りました（Google ドライブにアップロードしてスプレッドシートで開く）")


# ---------------------------------------------------------------- 検査
def cmd_check() -> int:
    problems, notes = [], []
    prompts = content.prompt_numbers()
    cal_ids = {r["ID"] for r in read_csv(CALENDAR_CSV)}
    for it in content.load_items():
        where = f"{it.id}（{it.path.name}）"
        full = it.full_caption()
        if not it.caption:
            problems.append(f"{where}：キャプションがありません")
        if len(full) > CAPTION_MAX:
            problems.append(f"{where}：キャプションが {len(full)} 字（上限 {CAPTION_MAX}）")
        tags = it.hashtags
        if not 1 <= len(tags) <= HASHTAG_MAX:
            problems.append(f"{where}：ハッシュタグが {len(tags)} 個（1〜{HASHTAG_MAX} 個）")
        if any(not t.startswith("#") for t in tags) or len(set(tags)) != len(tags):
            problems.append(f"{where}：ハッシュタグの書式か重複に問題があります")
        if RISKY.search(it.caption):
            notes.append(f"{where}：誇大・未計測に見える表現があります → docs/facts.md と照合（{RISKY.search(it.caption).group(0)}）")
        for num in re.findall(r"#(\d{2})", it.caption + " " + it.meta.get("プロンプト集", "")):
            if num not in prompts:
                problems.append(f"{where}：プロンプト集に #{num} がありません（assets/プロンプト集_無料配布.md）")
        if it.id not in cal_ids:
            notes.append(f"{where}：カレンダーに載っていません")
        if it.kind == "reel":
            if not it.cover:
                problems.append(f"{where}：表紙（```cover```）がありません")
            if not it.telops:
                problems.append(f"{where}：テロップ（```telop```）がありません")
            prev_end = 0.0
            for t in it.telops:
                if t.end <= t.start or t.start < prev_end - 1e-6:
                    problems.append(f"{where}：テロップの時間がおかしい（{t.start}-{t.end}）")
                prev_end = t.end
                for line in t.text.split("\n"):
                    if len(line) > 18:
                        notes.append(f"{where}：テロップ1行が{len(line)}字（18字以内が読みやすい）「{line}」")
            m = re.search(r"(\d+)", it.meta.get("尺", ""))
            if m and it.telops and abs(it.telops[-1].end - int(m.group(1))) > 3:
                problems.append(f"{where}：テロップの長さ {it.telops[-1].end}秒 と尺 {m.group(1)}秒 が合いません")
        if it.kind == "carousel":
            if not 2 <= len(it.slides) <= 20:
                problems.append(f"{where}：スライドが {len(it.slides)} 枚（2〜20 枚）")
            if it.slides and it.slides[0]["type"] != "cover":
                notes.append(f"{where}：1枚目が表紙（cover）ではありません")
    # 文字のはみ出し（実際に描いて確かめる。output は作り直される）
    problems += [f"画像：{w}" for w in cmd_render(quiet=True)]
    print("■ 要修正" if problems else "■ 要修正：なし")
    for p in problems:
        print("  ✗", p)
    print("■ 確認推奨" if notes else "■ 確認推奨：なし")
    for n in notes:
        print("  △", n)
    return 1 if problems else 0


# ---------------------------------------------------------------- ギャラリー（スマホで画像を保存する用）
def write_gallery() -> None:
    brand = load_brand()
    cal = {r["ID"]: r for r in read_csv(CALENDAR_CSV)}
    parts = []

    def imgs(folder: Path, pattern: str):
        return sorted(folder.glob(pattern)) if folder.exists() else []

    sec = ["<h2>カルーセル</h2>"]
    for d in sorted((OUTPUT / "carousels").glob("C*")) if (OUTPUT / "carousels").exists() else []:
        c = cal.get(d.name, {})
        sec.append(f"<h3>{d.name}　{html.escape(c.get('テーマ', ''))}　<small>{c.get('日付', '')} {c.get('時刻', '')}</small></h3><div class=row>")
        sec += [f'<a href="carousels/{d.name}/{p.name}"><img loading=lazy src="carousels/{d.name}/{p.name}"></a>'
                for p in imgs(d, "*.jpg")]
        sec.append("</div>")
    parts += sec
    parts.append("<h2>リールの表紙・字幕</h2><div class=row>")
    for p in imgs(OUTPUT / "reels", "*_cover.jpg"):
        rid = p.name.split("_")[0]
        c = cal.get(rid, {})
        parts.append(f'<figure><a href="reels/{p.name}"><img loading=lazy src="reels/{p.name}"></a><figcaption>{rid} '
                     f'{c.get("日付", "")}<br><a href="reels/{rid}.srt">字幕 .srt</a></figcaption></figure>')
    parts.append("</div><h2>リール動画（自動生成）</h2><div class=row>")
    for p in sorted((OUTPUT / "videos").glob("*.mp4")) if (OUTPUT / "videos").exists() else []:
        parts.append(f'<figure><video controls preload=none playsinline poster="reels/{p.stem}_cover.jpg" '
                     f'src="videos/{p.name}" style="height:260px;border-radius:8px"></video><figcaption>{p.stem}</figcaption></figure>')
    parts.append("</div><h2>お知らせストーリーズ（自動投稿用）</h2><div class=row>")
    parts += [f'<a href="stories/auto/{p.name}"><img loading=lazy src="stories/auto/{p.name}"></a>'
              for p in imgs(OUTPUT / "stories" / "auto", "*.jpg")]
    parts.append("</div><h2>ストーリーズ背景</h2><div class=row>")
    parts += [f'<a href="stories/{p.name}"><img loading=lazy src="stories/{p.name}"></a>'
              for p in imgs(OUTPUT / "stories", "*.jpg")]
    parts.append("</div><h2>アイコン・ハイライト表紙</h2><div class=row>")
    parts += [f'<a href="brand/{p.name}"><img loading=lazy src="brand/{p.name}"></a>' for p in imgs(OUTPUT / "brand", "*.jpg")]
    parts.append("</div>")
    page = f"""<!doctype html><html lang=ja><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>投稿素材 {html.escape(brand['handle'])}</title>
<style>body{{font-family:sans-serif;margin:16px;background:#FAF8F3;color:#1B2333}}h2{{border-left:6px solid #FF6B2C;padding-left:8px}}
.row{{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}}img{{height:260px;border-radius:8px;border:1px solid #E8E4DA}}
figure{{margin:0;text-align:center;font-size:12px}}small{{color:#6B7280;font-weight:normal}}</style>
<h1>投稿素材 {html.escape(brand['handle'])}</h1>
<p>投稿は自動で行われます（tools/publish.py）。手で投稿したいときは、画像をタップ → 長押しで「写真に保存」。<a href="prompts.html">プロンプト集ページ</a></p>
{''.join(parts)}</html>"""
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "index.html").write_text(page, encoding="utf-8")


# ---------------------------------------------------------------- メイン
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ig-growth 制作・管理ツール")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("render"); p.add_argument("ids", nargs="*")
    sub.add_parser("check"); sub.add_parser("captions"); sub.add_parser("sync-log"); sub.add_parser("workbook")
    sub.add_parser("all")
    p = sub.add_parser("calendar"); p.add_argument("--start", required=True)
    p = sub.add_parser("report"); p.add_argument("--start"); p.add_argument("--end")
    p = sub.add_parser("import-sheet"); p.add_argument("file")
    p = sub.add_parser("insights"); p.add_argument("--days", type=int, default=30)
    a = ap.parse_args(argv)

    if a.cmd == "render":
        cmd_render(a.ids)
    elif a.cmd == "check":
        return cmd_check()
    elif a.cmd == "captions":
        cmd_captions()
    elif a.cmd == "calendar":
        cmd_calendar(a.start)
    elif a.cmd == "sync-log":
        cmd_sync_log()
    elif a.cmd == "workbook":
        cmd_workbook()
    elif a.cmd == "report":
        import report
        end = dt.date.fromisoformat(a.end) if a.end else dt.date.today()
        start = dt.date.fromisoformat(a.start) if a.start else end - dt.timedelta(days=6)
        print(report.write_report(start, end))
    elif a.cmd == "import-sheet":
        import sheets
        n1, n2 = sheets.import_workbook(Path(a.file))
        print(f"投稿実績 {n1} 行・フォロワー推移 {n2} 行を data/ に取り込みました")
    elif a.cmd == "insights":
        import insights
        print(insights.run(a.days))
    elif a.cmd == "all":
        cmd_captions()
        cmd_sync_log()
        cmd_workbook()
        return cmd_check()   # check の中で render も行う
    return 0


if __name__ == "__main__":
    sys.exit(main())
