import type { MeetingReport } from "@/lib/analytics/meeting";
import { Card } from "./ui";
import { ownerLabel } from "@/lib/ai/agents";

export function MeetingView({ report }: { report: MeetingReport }) {
  const s = report.sections;
  const blocks: [string, string[]][] = [
    ["1. 現状分析", s.situation],
    ["2. 売上・利益分析", s.revenue],
    ["3. 市場の変化", s.market],
    ["4. 問題点", s.problems],
    ["5. 改善案", s.improvements],
    ["6. 次の事業候補", s.nextBusinesses],
  ];
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-subtle">{report.note}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {blocks.map(([title, lines]) => (
          <Card key={title} title={title}>
            <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </Card>
        ))}
      </div>
      <Card title="7. 翌日の行動計画">
        {s.actions.length === 0 ? <p className="text-sm text-fg-subtle">追加の行動はありません。</p> : (
          <ol className="space-y-2 text-sm">
            {s.actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-0.5 border-l-2 border-gold-dim pl-3">
                <span>{a.title}{a.requiresApproval && <span className="ml-2 text-[11px] text-warn">要承認</span>}</span>
                <span className="text-xs text-fg-subtle">担当：{ownerLabel(a.owner)}／{a.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
