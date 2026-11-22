import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { AGENTS, COMMON_AGENT_RULES } from "@/lib/ai/agents";
import { MODEL_PRICING_USD_PER_MTOK, PRICING_AS_OF } from "@/lib/ai/models";
import { yen } from "@/lib/finance/calc";
import { formatDateTimeJst, jstMonth } from "@/lib/time";
import { Card, Empty, PageHeader, StatusPill, TableWrap, td, th } from "@/components/common/ui";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const agent = await repo.getAgent(db, id);
  const def = AGENTS.find((a) => a.id === id);
  if (!agent || !def) notFound();
  const runs = await repo.agentRuns(db, id);
  const errors = runs.filter((r) => r.status === "error" || r.status === "blocked_budget");
  const price = MODEL_PRICING_USD_PER_MTOK[agent.model];

  return (
    <>
      <PageHeader
        title={agent.name}
        en={`AI EMPLOYEE / ${agent.id.toUpperCase()}`}
        description={agent.role}
        actions={<Link href="/agents" className="text-sm text-gold hover:underline">← 一覧へ</Link>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="基本情報">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-fg-muted">稼働状況</dt><dd><StatusPill status={agent.status} /></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-fg-muted">使用モデル</dt><dd>{price?.label ?? agent.model}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-fg-muted">料金（100万トークン）</dt><dd className="num text-xs">入力 ${price?.input}／出力 ${price?.output}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-fg-muted">今月の利用料金</dt><dd className="num">{yen(await repo.agentCostInMonth(db, jstMonth(), id))}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-fg-muted">月間上限</dt><dd className="num">{yen(agent.monthly_cap_jpy)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-fg-muted">最終実行</dt><dd className="num">{formatDateTimeJst(agent.last_run_at)}</dd></div>
          </dl>
          <p className="mt-3 text-[11px] text-fg-subtle">料金は {PRICING_AS_OF} 時点の公式価格。モデルの変更は代表者の判断で行います。</p>
        </Card>
        <Card title="担当業務">
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {def.responsibilities.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Card>
        <Card title="守るルール">
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {def.rules.map((r) => <li key={r} className="text-fg">{r}</li>)}
            {COMMON_AGENT_RULES.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Card>
      </div>

      <Card title="実行履歴" className="mt-4">
        {runs.length === 0 ? (
          <Empty>まだ実行されていません。</Empty>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[720px]">
              <thead><tr><th className={th}>開始</th><th className={th}>結果</th><th className={th}>内容</th><th className={th}>AIの判断</th><th className={th}>実際の実行結果</th><th className={`${th} text-right`}>費用（推計）</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className={`${td} num whitespace-nowrap`}>{formatDateTimeJst(r.started_at)}</td>
                    <td className={td}><StatusPill status={r.status} /></td>
                    <td className={td}>{r.summary}</td>
                    <td className={`${td} text-fg-muted`}>{r.ai_output?.slice(0, 200) ?? "—"}</td>
                    <td className={`${td} text-fg-muted`}>{r.execution_result?.slice(0, 200) ?? "—"}</td>
                    <td className={`${td} num text-right`}>{yen(r.cost_jpy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="エラー履歴" className="mt-4">
        {errors.length === 0 ? <Empty>エラーはありません。</Empty> : (
          <ul className="space-y-2 text-sm">
            {errors.map((r) => <li key={r.id} className="text-bad">{formatDateTimeJst(r.started_at)}：{r.error ?? r.summary}</li>)}
          </ul>
        )}
      </Card>
    </>
  );
}
