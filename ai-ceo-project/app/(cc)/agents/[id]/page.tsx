import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { AGENTS, COMMON_AGENT_RULES } from "@/lib/ai/agents";
import { MODEL_PRICING_USD_PER_MTOK, PRICING_AS_OF } from "@/lib/ai/models";
import { yen } from "@/lib/finance/calc";
import { formatDateTimeJst, jstMonth } from "@/lib/time";
import { Button, Card, Empty, Notice, PageHeader, StatusPill, TableWrap, td, th } from "@/components/common/ui";
import { Flash, type FlashParams } from "@/components/common/Flash";
import { runAgentTask } from "@/app/actions";
import { hasApiKey } from "@/lib/ai/llm";
import { getTask, failStaleRuns } from "@/lib/ai/runner";
import { DEFAULT_THEME } from "@/lib/ai/tasks/market-research";
import "@/lib/ai/tasks/index";

const TASKS_OF: Record<string, string[]> = { ceo: ["ceo.meeting"], research: ["research.ideas"] };
const RESULT_LINK: Record<string, [string, string]> = { "ceo.meeting": ["/reports", "経営会議を見る"], "research.ideas": ["/business", "事業開発で見る"] };

export default async function AgentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: FlashParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  await failStaleRuns(db);
  const agent = await repo.getAgent(db, id);
  const def = AGENTS.find((a) => a.id === id);
  if (!agent || !def) notFound();
  const runs = await repo.agentRuns(db, id);
  const errors = runs.filter((r) => r.status === "error" || r.status === "blocked_budget");
  const price = MODEL_PRICING_USD_PER_MTOK[agent.model];
  const settings = await repo.getSettings(db);
  const tasks = (TASKS_OF[id] ?? []).map((t) => getTask(t)!).filter(Boolean);
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  const keyOk = hasApiKey();

  return (
    <>
      <PageHeader
        title={agent.name}
        en={`AI EMPLOYEE / ${agent.id.toUpperCase()}`}
        description={agent.role}
        actions={<Link href="/agents" className="text-sm text-gold hover:underline">← 一覧へ</Link>}
      />
      {active && <meta httpEquiv="refresh" content="8" />}
      <Flash {...sp} />

      <Card title="仕事を頼む" className="mb-4">
        {tasks.length === 0 ? (
          <p className="text-sm text-fg-subtle">このAI社員の仕事は、これから順番に追加します（現在動かせるのは AI CEO と 市場調査AI）。</p>
        ) : (
          <div className="space-y-4">
            {!keyOk && <Notice tone="warn">Claude API のキーが未設定のため実行できません（Netlify の環境変数 ANTHROPIC_API_KEY）。</Notice>}
            {active && <Notice>実行中です。この画面は8秒ごとに自動で更新されます。</Notice>}
            {tasks.map((t) => (
              <form key={t.name} action={runAgentTask} className="space-y-2 rounded-md border border-line p-3">
                <input type="hidden" name="task" value={t.name} />
                <p className="text-sm font-medium">{t.label}</p>
                {t.name === "research.ideas" && (
                  <div>
                    <label htmlFor="theme">調べるテーマ（空欄なら下の例で調べます）</label>
                    <textarea id="theme" name="theme" rows={2} maxLength={300} placeholder={DEFAULT_THEME} />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button disabled={!keyOk || active || agent.status === "paused"}>実行する</Button>
                  <span className="text-xs text-fg-subtle">
                    費用の上限 約{yen(t.estimateJpy(settings))}（推計。実際はこれより少ない見込み）
                    {t.name === "research.ideas" && "・Web検索は最大5回"}
                  </span>
                </div>
              </form>
            ))}
            <p className="text-xs text-fg-subtle">実行前に予算（月間・AI API・このAI社員の上限）を確認し、超えそうなら実行しません。結果は「AIの判断」と「実際に行われたこと」を分けて記録します。</p>
          </div>
        )}
      </Card>
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
              <thead><tr><th className={th}>開始</th><th className={th}>状態</th><th className={th}>仕事</th><th className={th}>実際に行われたこと</th><th className={`${th} text-right`}>使用量</th><th className={`${th} text-right`}>費用（推計）</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className={`${td} num whitespace-nowrap`}>{formatDateTimeJst(r.started_at)}</td>
                    <td className={td}><StatusPill status={r.status} /></td>
                    <td className={td}>{r.summary}</td>
                    <td className={`${td} text-fg-muted`}>
                      {r.execution_result ?? (r.error ? <span className="text-bad">{r.error}</span> : "—")}
                      {r.status === "success" && RESULT_LINK[r.task] && (
                        <Link href={RESULT_LINK[r.task][0]} className="ml-2 text-xs text-gold hover:underline">{RESULT_LINK[r.task][1]}</Link>
                      )}
                    </td>
                    <td className={`${td} num whitespace-nowrap text-right text-xs text-fg-subtle`}>
                      {r.input_tokens + r.output_tokens > 0 ? `${(r.input_tokens / 1000).toFixed(1)}k / ${(r.output_tokens / 1000).toFixed(1)}k` : "—"}
                      {r.web_searches > 0 && <><br />検索 {r.web_searches}回</>}
                    </td>
                    <td className={`${td} num text-right`}>{yen(r.cost_jpy)}{r.estimate_jpy > 0 && <p className="text-[11px] text-fg-subtle">上限 {yen(r.estimate_jpy)}</p>}</td>
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
