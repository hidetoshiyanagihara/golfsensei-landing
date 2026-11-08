"""週次レポート：data/posts_log.csv と data/followers_daily.csv から reports/weekly_開始日.md を作る。

方針
- 取れていない数字は「未取得」。推測・補完はしない
- 比べる相手は「自分の他の投稿」（中央値）。他人の平均や業界平均とは比べない
- 2 本未満のグループは「サンプル不足」として判断しない
"""
from __future__ import annotations

import datetime as dt
import statistics

from common import FOLLOWERS_CSV, POSTS_LOG_CSV, REPORTS, load_brand, read_csv, to_number

NA = "未取得"


def rates(r: dict) -> dict:
    """1 投稿の率を計算する。分母・分子のどちらかが未取得なら None。"""
    reach = to_number(r.get("リーチ数"))
    out = {}
    for name, col, mult in (("保存率(%)", "保存", 100), ("シェア率(%)", "シェア", 100),
                            ("プロフィール遷移率(%)", "プロフィールアクセス", 100),
                            ("フォロー率(/1000リーチ)", "フォロー数", 1000)):
        v = to_number(r.get(col))
        out[name] = (v / reach * mult) if (v is not None and reach) else None
    prof, fol = to_number(r.get("プロフィールアクセス")), to_number(r.get("フォロー数"))
    out["プロフィール→フォロー(%)"] = (fol / prof * 100) if (fol is not None and prof) else None
    return out


def fmt(v, digits=1) -> str:
    if v is None:
        return NA
    if abs(v - round(v)) < 1e-9 and digits <= 1:
        return f"{int(round(v)):,}"
    return f"{v:,.{digits}f}"


def median(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def group_table(rows, key, rate_names) -> list[str]:
    groups: dict[str, list] = {}
    for r in rows:
        groups.setdefault(r.get(key) or "（空欄）", []).append(r)
    lines = [f"| {key} | 本数 | " + " | ".join(f"平均{n}" for n in rate_names) + " | 判断 |",
             "|---|---|" + "---|" * len(rate_names) + "---|"]
    for g, rs in sorted(groups.items()):
        avgs = []
        for n in rate_names:
            vals = [x["_rates"][n] for x in rs if x["_rates"][n] is not None]
            avgs.append(sum(vals) / len(vals) if vals else None)
        measured = sum(1 for x in rs if x["_rates"]["フォロー率(/1000リーチ)"] is not None)
        note = "サンプル不足（判断しない）" if measured < 2 else ""
        lines.append(f"| {g} | {len(rs)} | " + " | ".join(fmt(a, 2) for a in avgs) + f" | {note} |")
    return lines


def follower_section(start: dt.date, end: dt.date, brand: dict) -> list[str]:
    rows = []
    for r in read_csv(FOLLOWERS_CSV):
        try:
            d = dt.date.fromisoformat(r["日付"].strip())
        except (KeyError, ValueError):
            continue
        n = to_number(r.get("フォロワー数"))
        if n is not None:
            rows.append((d, n))
    rows.sort()
    out = ["## 2. フォロワーの推移", ""]
    if not rows:
        return out + [f"- フォロワー数：{NA}（`data/followers_daily.csv` に毎朝記入してください）", ""]
    in_week = [x for x in rows if start <= x[0] <= end]
    before = [x for x in rows if x[0] < start]
    latest = rows[-1]
    out.append(f"- 最新：**{fmt(latest[1])}人**（{latest[0].isoformat()}）")
    if in_week:
        base = before[-1] if before else in_week[0]
        gain = in_week[-1][1] - base[1]
        days = max((in_week[-1][0] - base[0]).days, 1)
        out.append(f"- この期間の純増：{fmt(gain)}人（{base[0].isoformat()} → {in_week[-1][0].isoformat()}、1日平均 {gain / days:.1f}人）")
    else:
        out.append(f"- この期間の純増：{NA}（期間内の記録なし）")
    # 目標ペース
    try:
        launch = dt.date.fromisoformat(brand.get("start_date", ""))
    except ValueError:
        launch = None
    if launch:
        day_n = (latest[0] - launch).days + 1
        out.append(f"- 運用 {day_n} 日目")
        for days, goal in brand.get("goals", []):
            remain_days = days - day_n
            if remain_days < 0:
                status = "達成" if latest[1] >= goal else "未達"
                out.append(f"  - {days}日目標 {goal:,}人：期限を過ぎました（{status}）")
            else:
                need = max(goal - latest[1], 0)
                pace = need / remain_days if remain_days else need
                out.append(f"  - {days}日目標 {goal:,}人：あと {fmt(need)}人／残り {remain_days}日 → 1日 {pace:.1f}人ペースが必要")
    out.append("")
    return out


def build(start: dt.date, end: dt.date) -> str:
    brand = load_brand()
    posts = []
    for r in read_csv(POSTS_LOG_CSV):
        try:
            d = dt.date.fromisoformat((r.get("投稿日") or "").strip())
        except ValueError:
            continue
        if start <= d <= end:
            r["_rates"] = rates(r)
            posts.append(r)
    posted = [r for r in posts if (r.get("投稿URL") or "").strip() or any(to_number(r.get(c)) is not None
                                                                          for c in ("再生数", "リーチ数"))]
    L = [f"# 週次レポート {start.isoformat()} 〜 {end.isoformat()}", "",
         f"作成：{dt.date.today().isoformat()}　／　データ：`data/posts_log.csv` `data/followers_daily.csv`",
         "", "> 空欄の数字は「未取得」と表示し、推測で埋めていません。比べる相手は自分の投稿同士（中央値）です。", ""]
    # 1. 投稿ごと
    L += ["## 1. 投稿ごとの数字", ""]
    if not posted:
        L += [f"この期間に数字が記録された投稿はありません（予定 {len(posts)} 件）。", ""]
    else:
        L += ["| ID | 日付 | 形式 | 柱 | フック型 | 再生 | リーチ | 外部% | 平均視聴(秒) | 保存率% | シェア率% | プロフ遷移% | フォロー/千リーチ | フォロー |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in posted:
            x = r["_rates"]
            L.append(f"| {r['投稿ID']} | {r['投稿日'][5:]} | {r.get('形式', '')} | {r.get('柱', '')} | {r.get('フック型', '')} | "
                     f"{fmt(to_number(r.get('再生数')))} | {fmt(to_number(r.get('リーチ数')))} | "
                     f"{fmt(to_number(r.get('フォロワー外リーチ率(%)')))} | {fmt(to_number(r.get('平均視聴時間(秒)')))} | "
                     f"{fmt(x['保存率(%)'], 2)} | {fmt(x['シェア率(%)'], 2)} | {fmt(x['プロフィール遷移率(%)'], 2)} | "
                     f"{fmt(x['フォロー率(/1000リーチ)'], 2)} | {fmt(to_number(r.get('フォロー数')))} |")
        missing = [r["投稿ID"] for r in posted if r["_rates"]["フォロー率(/1000リーチ)"] is None]
        L.append("")
        if missing:
            L.append(f"- フォロー率を計算できない投稿（リーチ数またはフォロー数が未取得）：{', '.join(missing)}")
        L.append("")
    L += follower_section(start, end, brand)

    # 3. ランキング
    measured = [r for r in posted if r["_rates"]["フォロー率(/1000リーチ)"] is not None]
    L += ["## 3. フォローにつながった順（最重要）", ""]
    if len(measured) < 2:
        L += ["数字のそろった投稿が 2 本未満のため、順位づけしません。", ""]
    else:
        ranked = sorted(measured, key=lambda r: r["_rates"]["フォロー率(/1000リーチ)"], reverse=True)
        med = median([r["_rates"]["フォロー率(/1000リーチ)"] for r in measured])
        L.append(f"フォロー率の中央値：{fmt(med, 2)} / 1000リーチ")
        L.append("")
        k = min(3, len(ranked) // 2 or 1)
        L.append("**上位**")
        for r in ranked[:k]:
            L.append(f"- {r['投稿ID']}「{r.get('テーマ', '')}」 {fmt(r['_rates']['フォロー率(/1000リーチ)'], 2)}"
                     f"（柱 {r.get('柱', '')}／フック {r.get('フック型') or '—'}／尺 {(r.get('尺(秒)') + '秒') if r.get('尺(秒)') else NA}）")
        L.append("")
        L.append("**下位**")
        for r in ranked[-k:]:
            L.append(f"- {r['投稿ID']}「{r.get('テーマ', '')}」 {fmt(r['_rates']['フォロー率(/1000リーチ)'], 2)}"
                     f"（柱 {r.get('柱', '')}／フック {r.get('フック型') or '—'}）— 詰まった段階：{stuck_stage(r, measured)}")
        L.append("")
        # データ上の示唆（ルールは docs/07 の 3 章）
        L += ["### データ上の示唆（docs/07 の判断ルールで自動判定）", ""]
        hints = []
        for r in (measured if len(measured) >= 3 else []):
            x = r["_rates"]
            views = [to_number(m.get("再生数")) for m in measured]
            v = to_number(r.get("再生数"))
            vmed = median(views)
            if v is not None and vmed and v >= vmed * 1.5 and x["フォロー率(/1000リーチ)"] < med:
                hints.append(f"- {r['投稿ID']}：再生は中央値の1.5倍以上なのにフォロー率は中央値未満 → **導線（CTA・プロフィール）を直す**")
        pillar_groups: dict[str, list] = {}
        for r in measured:
            pillar_groups.setdefault(r.get("柱", ""), []).append(r["_rates"]["フォロー率(/1000リーチ)"])
        for p, vals in pillar_groups.items():
            if len(vals) >= 2 and med and sum(vals) / len(vals) >= med * 1.5:
                hints.append(f"- 柱「{p}」：{len(vals)}本の平均フォロー率が中央値の1.5倍以上 → **翌週の40%以上をこの柱に**")
        if len(measured) < 3:
            hints = ["- 数字のそろった投稿が 3 本未満のため、自動判定はしません"]
        L += hints or ["- 自動判定で強い示唆はありません（サンプルが増えると出ます）"]
        L.append("")

    # 4. グループ別
    if measured:
        names = ["フォロー率(/1000リーチ)", "保存率(%)", "シェア率(%)"]
        L += ["## 4. グループ別の平均", "", "### 柱別", ""] + group_table(measured, "柱", names)
        L += ["", "### フック型別", ""] + group_table(measured, "フック型", names)
        L += ["", "### 形式別", ""] + group_table(measured, "形式", names) + [""]

    # 5. 人が考える欄
    L += ["## 5. 今週の振り返り（docs/07 の 6 つの問い）", "",
          "1. **伸びた投稿の共通点**：", "", "2. **伸びなかった投稿の原因**：", "",
          "3. **改善すべきポイント（1つだけ）**：", "", "4. **次週の企画変更**（calendar_30days.csv のどれを何に）：", "",
          "5. **深掘りするテーマ（続編 2〜3 本）**：", "", "6. **廃止する企画**：", "",
          "→ 決めたことは `data/improvements.csv` に追記する", ""]
    return "\n".join(L)


def stuck_stage(r: dict, peers: list[dict]) -> str:
    """自分の投稿の中央値と比べて、最初に下回っている段階を返す。"""
    stages = [
        ("届かない（リーチ）", lambda x: to_number(x.get("リーチ数"))),
        ("見られない（平均視聴時間）", lambda x: to_number(x.get("平均視聴時間(秒)"))),
        ("動かない（保存・シェア率）", lambda x: _sum_none(x["_rates"]["保存率(%)"], x["_rates"]["シェア率(%)"])),
        ("来ない（プロフィール遷移率）", lambda x: x["_rates"]["プロフィール遷移率(%)"]),
        ("残らない（プロフィール→フォロー）", lambda x: x["_rates"]["プロフィール→フォロー(%)"]),
    ]
    for name, get in stages:
        v = get(r)
        med = median([get(p) for p in peers])
        if v is None or med is None:
            continue
        if v < med:
            return name
    return "判定できず（数字不足 or すべて中央値以上）"


def _sum_none(a, b):
    if a is None and b is None:
        return None
    return (a or 0) + (b or 0)


def write_report(start: dt.date, end: dt.date) -> str:
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"weekly_{start.isoformat()}.md"
    path.write_text(build(start, end), encoding="utf-8")
    return str(path)
