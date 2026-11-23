import Link from "next/link";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { addTask, runAgentTask, runMeeting, updateTask } from "@/app/actions";
import { hasApiKey } from "@/lib/ai/llm";
import { ceoMeetingTask } from "@/lib/ai/tasks/ceo-meeting";
import { yen } from "@/lib/finance/calc";
import { formatDateTimeJst } from "@/lib/time";
import { ownerLabel } from "@/lib/ai/agents";
import { Button, Card, Empty, PageHeader, StatusPill } from "@/components/common/ui";
import { Flash, type FlashParams } from "@/components/common/Flash";

export const metadata = { title: "経営会議" };

export default async function ReportsPage({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const db = await getDb();
  const reports = await repo.listReports(db);
  const tasks = await repo.openTasks(db);
  const settings = await repo.getSettings(db);
  const keyOk = hasApiKey();

  return (
    <>
      <PageHeader
        title="経営会議"
        en="MANAGEMENT MEETING"
        description="AI CEO が経営状況を確認し、問題点・改善案・翌日の行動計画をまとめます。"
        actions={
          <>
            <form action={runMeeting}><Button variant="ghost">ルールで集計（0円）</Button></form>
            <form action={runAgentTask}>
              <input type="hidden" name="task" value="ceo.meeting" />
              <Button disabled={!keyOk} title={keyOk ? undefined : "Claude API のキーが未設定です"}>AI CEO に会議を頼む（上限 約{yen(ceoMeetingTask.estimateJpy(settings))}）</Button>
            </form>
          </>
        }
      />
      <Flash {...sp} />
      <p className="mb-4 text-xs text-fg-subtle">
        「ルールで集計」はAIを使わず、DBの実データだけで作ります（0円）。「AI CEO に会議を頼む」は、その集計をAI CEOが読んで7項目の議事録と翌日の行動計画を作ります（Claude API を使用。上限の金額を超えそうなら実行しません）。毎日の自動実行は PHASE 5 で追加します。
      </p>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="行動計画・タスク（未完了）">
          {tasks.length === 0 ? <Empty>未完了のタスクはありません。</Empty> : (
            <ul className="divide-y divide-line/60">
              {tasks.map((t) => (
                <li key={t.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><StatusPill status={t.status} /><span>{t.title}</span>{t.requires_approval ? <span className="text-[11px] text-warn">要承認</span> : null}</div>
                    <p className="text-xs text-fg-subtle">担当：{ownerLabel(t.owner)}／期限：{t.due_date ?? "なし"}{t.detail && `／${t.detail}`}</p>
                  </div>
                  <form action={updateTask} className="flex shrink-0 gap-1.5">
                    <input type="hidden" name="id" value={t.id} />
                    {t.status === "todo" && <Button name="status" value="doing" variant="ghost">着手</Button>}
                    <Button name="status" value="done">完了</Button>
                    <Button name="status" value="cancelled" variant="ghost">中止</Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form action={addTask} className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[2fr_1fr_auto]">
            <div><label htmlFor="t-title">タスクを追加</label><input id="t-title" name="title" required maxLength={200} /></div>
            <div><label htmlFor="t-due">期限</label><input id="t-due" name="due_date" type="date" /></div>
            <div className="flex items-end"><Button variant="ghost">追加</Button></div>
          </form>
        </Card>

        <Card title="過去の経営会議">
          {reports.length === 0 ? <Empty>まだ実行されていません。</Empty> : (
            <ul className="divide-y divide-line/60 text-sm">
              {reports.map((r) => (
                <li key={r.id} className="py-2">
                  <Link href={`/reports/${r.id}`} className="hover:text-gold">{r.period} の経営会議</Link>
                  <p className="text-xs text-fg-subtle">{formatDateTimeJst(r.created_at)}／{r.generated_by === "rule" ? "ルールで集計" : <span className="text-gold">AI CEO</span>}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
