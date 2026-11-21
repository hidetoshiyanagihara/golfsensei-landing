import Link from "next/link";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { MODEL_PRICING_USD_PER_MTOK } from "@/lib/ai/models";
import { yen } from "@/lib/finance/calc";
import { formatDateTimeJst, jstMonth } from "@/lib/time";
import { Card, Notice, PageHeader, StatusPill, TableWrap, td, th } from "@/components/common/ui";

export const metadata = { title: "AI社員管理" };

export default async function AgentsPage() {
  const db = getDb();
  const agents = repo.listAgents(db);
  const month = jstMonth();
  const errorCount = db.prepare("SELECT agent_id, COUNT(*) AS n FROM agent_runs WHERE status = 'error' GROUP BY agent_id").all() as { agent_id: string; n: number }[];
  const errors = Object.fromEntries(errorCount.map((e) => [e.agent_id, e.n]));
  const runCount = db.prepare("SELECT agent_id, COUNT(*) AS n FROM agent_runs GROUP BY agent_id").all() as { agent_id: string; n: number }[];
  const runs = Object.fromEntries(runCount.map((e) => [e.agent_id, e.n]));

  return (
    <>
      <PageHeader title="AI社員管理" en="AI EMPLOYEES" description="AI社員の担当業務・稼働状況・実行履歴・利用料金" />
      <div className="mb-5">
        <Notice tone="warn">
          AI社員は全員「未接続」です（PHASE 1）。PHASE 2 で Anthropic API に接続し、最初は代表者がボタンを押したときだけ実行します。予算の上限に達すると自動で停止します。
        </Notice>
      </div>

      <Card>
        <TableWrap>
          <table className="w-full min-w-[760px]">
            <thead>
              <tr>
                <th className={th}>名前</th>
                <th className={th}>担当業務</th>
                <th className={th}>稼働状況</th>
                <th className={th}>最終実行</th>
                <th className={th}>実行／エラー</th>
                <th className={th}>使用モデル</th>
                <th className={`${th} text-right`}>今月の利用料金</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-navy-800/50">
                  <td className={td}>
                    <Link href={`/agents/${a.id}`} className="font-medium text-fg hover:text-gold">
                      {a.name}
                    </Link>
                    <p className="text-xs text-fg-subtle">{a.title}</p>
                  </td>
                  <td className={`${td} text-fg-muted`}>{a.role}</td>
                  <td className={td}>
                    <StatusPill status={a.status} />
                  </td>
                  <td className={`${td} num whitespace-nowrap text-fg-muted`}>{formatDateTimeJst(a.last_run_at)}</td>
                  <td className={`${td} num whitespace-nowrap`}>
                    {runs[a.id] ?? 0}回 / <span className={errors[a.id] ? "text-bad" : "text-fg-subtle"}>{errors[a.id] ?? 0}件</span>
                  </td>
                  <td className={`${td} whitespace-nowrap text-xs text-fg-muted`}>{MODEL_PRICING_USD_PER_MTOK[a.model]?.label ?? a.model}</td>
                  <td className={`${td} num whitespace-nowrap text-right`}>
                    {yen(repo.agentCostInMonth(db, month, a.id))}
                    <p className="text-[11px] text-fg-subtle">上限 {yen(a.monthly_cap_jpy)}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="mt-3 text-xs text-fg-subtle">利用料金はトークン数からの推計です。正確な請求額は Anthropic Console で確認し、財務画面に記録してください。</p>
      </Card>
    </>
  );
}
