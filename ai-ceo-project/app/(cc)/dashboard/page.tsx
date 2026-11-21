import Link from "next/link";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { buildOverview, type Overview } from "@/lib/analytics/overview";
import { getView } from "@/lib/view";
import { yen } from "@/lib/finance/calc";
import { daysBetween } from "@/lib/time";
import { Card, Empty, Notice, PageHeader, StatTile, StatusPill, type Kind } from "@/components/common/ui";
import { BarList } from "@/components/dashboard/BarList";
import { ownerLabel } from "@/lib/ai/agents";
import { ACCOUNTS } from "@/lib/marketing/launch-kit";

const ACC: Record<string, string> = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a.label]));
import { Flash, type FlashParams } from "@/components/common/Flash";

export const metadata = { title: "ダッシュボード" };

const PLATFORM: Record<string, string> = { x: "X", instagram: "Instagram", youtube: "YouTube", note: "note", linkedin: "LinkedIn", other: "その他" };

export default async function DashboardPage({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const db = await getDb();
  const view = await getView();
  const o = await buildOverview(db, view);
  // サンプル表示中は、実データだけの値と比べて「サンプルを含む数字」を見分ける
  const a: Overview = view.showSample ? await buildOverview(db, repo.ACTUAL_ONLY) : o;
  const k = (x: number, y: number): Kind => (x === y ? "actual" : "sample");
  const goals = await repo.listGoals(db);
  const tasks = await repo.openTasks(db, 5);
  const connected = o.agents.total - (o.agents.byStatus.not_connected ?? 0);
  const pendingTotal = o.pending.ideas + o.pending.contentApproval + o.pending.productsAwaitingApproval + o.pending.inquiriesNeedOwner;

  return (
    <>
      <PageHeader title="ダッシュボード" en="DASHBOARD" description={`${o.month.replace("-", "年")}月の経営状況（今日：${o.today}）`} />
      <Flash {...sp} />

      <div className="mb-6 space-y-2">
        {o.budget.level === "stop" && <Notice tone="bad">月間運営予算の上限に達しました。AIの自動実行は停止されます。</Notice>}
        {o.budget.level === "warn" && <Notice tone="warn">月間運営予算の {Math.round(o.budget.ratio * 100)}% を使いました。</Notice>}
        {o.aiBudget.level !== "ok" && <Notice tone={o.aiBudget.level === "stop" ? "bad" : "warn"}>AI API の月間上限の {Math.round(o.aiBudget.ratio * 100)}% を使いました。</Notice>}
        {pendingTotal > 0 && (
          <Notice tone="warn">
            代表者の確認待ち：
            {o.pending.ideas > 0 && <Link className="ml-2 underline" href="/business">事業アイデア {o.pending.ideas}件</Link>}
            {o.pending.productsAwaitingApproval > 0 && <Link className="ml-2 underline" href="/products">販売承認 {o.pending.productsAwaitingApproval}件</Link>}
            {o.pending.contentApproval > 0 && <Link className="ml-2 underline" href="/marketing">投稿 {o.pending.contentApproval}件</Link>}
            {o.pending.inquiriesNeedOwner > 0 && <Link className="ml-2 underline" href="/marketing#inquiries">問い合わせ {o.pending.inquiriesNeedOwner}件</Link>}
          </Notice>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <StatTile label="今月の売上（純売上）" value={yen(o.pnl.netSales)} kind={k(o.pnl.netSales, a.pnl.netSales)} sub={`売上総額 ${yen(o.pnl.grossSales)}／返金 ${yen(o.pnl.refunds)}`} />
        <StatTile
          label="今月の利益（営業利益）"
          value={yen(o.pnl.operatingProfit)}
          kind={k(o.pnl.operatingProfit, a.pnl.operatingProfit)}
          tone={o.pnl.operatingProfit < 0 ? "bad" : undefined}
          sub={`粗利益 ${yen(o.pnl.grossProfit)}`}
        />
        <StatTile label="販売件数" value={`${o.pnl.salesCount}件`} kind={k(o.pnl.salesCount, a.pnl.salesCount)} sub="全額返金は除く" />
        <StatTile
          label="今月のAPI利用料金"
          value={yen(o.aiApiJpy)}
          kind={k(o.aiApiJpy, a.aiApiJpy)}
          sub={<>記録した請求額＋AI社員の推計 {yen(o.agentCostJpy)}<br />上限 {yen(o.aiBudget.capJpy)}</>}
        />
        <StatTile
          label="月間予算残額"
          value={yen(o.budget.remainingJpy)}
          kind={k(o.budget.remainingJpy, a.budget.remainingJpy)}
          tone={o.budget.level === "stop" ? "bad" : o.budget.level === "warn" ? "warn" : undefined}
          sub={`予算 ${yen(o.budget.capJpy)}（設定値）のうち ${yen(o.budget.usedJpy)} 使用`}
        />
        <StatTile label="問い合わせ件数（今月）" value={`${o.inquiries.total}件`} kind={k(o.inquiries.total, a.inquiries.total)} sub={`未対応 ${o.inquiries.open}件`} />
        <StatTile
          label="記事閲覧数（今月）"
          value={o.articleViews.rows === 0 ? "—" : o.articleViews.value.toLocaleString("ja-JP")}
          kind={o.articleViews.rows === 0 ? "none" : k(o.articleViews.value, a.articleViews.value)}
          sub={o.articleViews.rows === 0 ? "まだ記録がありません" : `${o.articleViews.rows}件の記録の合計`}
        />
        <StatTile
          label="AIの稼働状況"
          value={`${connected} / ${o.agents.total}名`}
          kind="actual"
          tone={connected === 0 ? "warn" : undefined}
          sub={connected === 0 ? "全員未接続（PHASE 2 で接続）" : `自動実行 ${o.automationEnabled ? "ON" : "OFF"}`}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="商品別売上（今月・純売上）">
          {o.productSales.length === 0 ? (
            <Empty>今月の売上はまだありません（実績 0円）</Empty>
          ) : (
            <BarList unit="商品別売上" format={yen} rows={o.productSales.map((r) => ({ label: r.name, value: r.net, detail: `${r.count}件`, kind: r.kind }))} />
          )}
        </Card>

        <Card title="SNSフォロワー（最新の記録）" aside={<Link href="/marketing#metrics" className="text-xs text-gold hover:underline">記録する</Link>}>
          {o.followers.length === 0 ? (
            <Empty>まだ記録がありません。コンテンツ画面でフォロワー数を記録してください。</Empty>
          ) : (
            <ul className="divide-y divide-line/60">
              {o.followers.map((f) => (
                <li key={f.account + f.platform + f.data_kind} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 truncate text-fg-muted">
                    {ACC[f.account] ?? "未指定"}・{PLATFORM[f.platform] ?? f.platform} {f.data_kind === "sample" && <span className="text-warn">（サンプル）</span>}
                  </span>
                  <span className="num">
                    {f.value.toLocaleString("ja-JP")}人 <span className="text-xs text-fg-subtle">{f.date}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="今月の投稿実績" aside={<Link href="/marketing" className="text-xs text-gold hover:underline">一覧</Link>}>
          {o.content.posted + o.content.failed === 0 ? (
            <Empty>今月の投稿記録はありません。<code className="text-gold">npm run db:import</code> で自動投稿の結果を取り込めます。</Empty>
          ) : (
            <>
              <BarList
                unit="投稿成功数"
                format={(n) => `${n}件`}
                rows={Object.entries(o.content.byPlatform).filter(([, s]) => s.posted + s.failed > 0).map(([p, s]) => ({ label: PLATFORM[p] ?? p, value: s.posted, detail: `失敗 ${s.failed}件` }))}
              />
              <p className="mt-3 text-xs text-fg-subtle">
                成功 {o.content.posted}件／失敗 <span className={o.content.failed > 0 ? "text-bad" : ""}>{o.content.failed}件</span>（AXION SALES の自動投稿の結果を取り込んだ実績）
              </p>
            </>
          )}
        </Card>

        <Card title="目標（30日・90日）" aside={<span className="text-[11px] text-fg-subtle">目標値は実績ではありません</span>}>
          <ul className="divide-y divide-line/60">
            {goals.map((g) => {
              const left = daysBetween(o.today, g.deadline);
              return (
                <li key={g.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="mr-2 text-[11px] text-gold">{g.horizon === "30d" ? "30日" : "90日"}</span>
                    {g.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className={`num text-xs ${left < 0 ? "text-bad" : "text-fg-subtle"}`}>{left < 0 ? `期限切れ` : `残り${left}日`}</span>
                    <StatusPill status={g.status} />
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title="次にやること" className="mt-4" aside={<Link href="/reports" className="text-xs text-gold hover:underline">経営会議へ</Link>}>
        {tasks.length === 0 ? (
          <Empty>タスクはありません。経営会議を実行すると、翌日の行動計画がここに出ます。</Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  {t.title}
                  {t.requires_approval ? <span className="ml-2 text-[11px] text-warn">要承認</span> : null}
                </span>
                <span className="shrink-0 text-xs text-fg-subtle">{ownerLabel(t.owner)}／{t.due_date ?? "期限なし"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
