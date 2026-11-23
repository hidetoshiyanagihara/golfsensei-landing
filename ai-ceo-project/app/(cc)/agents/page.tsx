import Link from "next/link";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { MODEL_PRICING_USD_PER_MTOK } from "@/lib/ai/models";
import { yen } from "@/lib/finance/calc";
import { formatDateTimeJst, jstMonth } from "@/lib/time";
import { Card, Notice, PageHeader, StatusPill, TableWrap, td, th } from "@/components/common/ui";
import { hasApiKey } from "@/lib/ai/llm";

export const metadata = { title: "AI社員管理" };

export default async function AgentsPage() {
  const db = await getDb();
  const agents = await repo.listAgents(db);
  const month = jstMonth();
  const [counts, costs] = await Promise.all([repo.agentRunCounts(db), repo.agentCostsByAgent(db, month)]);
  const runs = Object.fromEntries(counts.map((e) => [e.agent_id, Number(e.runs)]));
  const errors = Object.fromEntries(counts.map((e) => [e.agent_id, Number(e.errors)]));
  const cost = Object.fromEntries(costs.map((e) => [e.agent_id, Number(e.c)]));

  return (
    <>
      <PageHeader title="AI社員管理" en="AI EMPLOYEES" description="AI社員の担当業務・稼働状況・実行履歴・利用料金" />
      <div className="mb-5">
        {hasApiKey() ? (
          <Notice>
            Claude API に接続済みです。いま仕事を頼めるのは <Link href="/agents/ceo" className="text-gold underline">AI CEO（経営会議）</Link> と <Link href="/agents/research" className="text-gold underline">市場調査AI（事業アイデアの調査）</Link>。他のAI社員の仕事は順番に追加します。どの仕事も代表者がボタンを押したときだけ動き、予算の上限に達すると自動で止まります。
          </Notice>
        ) : (
          <Notice tone="warn">Claude API のキーが未設定のため、AI社員は「未接続」です（Netlify の環境変数 ANTHROPIC_API_KEY を設定すると接続されます）。</Notice>
        )}
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
                    {yen(cost[a.id] ?? 0)}
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
