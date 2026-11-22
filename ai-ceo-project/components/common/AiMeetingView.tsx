import type { CeoMeeting } from "@/lib/ai/tasks/ceo-meeting";
import type { MeetingReport } from "@/lib/analytics/meeting";
import { ownerLabel } from "@/lib/ai/agents";
import { Card, Notice } from "./ui";
import { MeetingView } from "./MeetingView";

export type AiMeetingContent = { date: string; model: string; note: string; warnings: string[]; ai: CeoMeeting; base: MeetingReport };

export function AiMeetingView({ c }: { c: AiMeetingContent }) {
  const a = c.ai;
  const blocks: [string, string[]][] = [
    ["1. 現状分析", a.situation],
    ["2. 売上・利益分析", a.revenue_analysis],
    ["3. 市場の変化", a.market],
    ["4. 問題点", a.problems],
    ["5. 改善案", a.improvements],
    ["6. 次の事業候補", a.next_businesses],
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gold-dim bg-navy-900 p-4">
        <p className="text-[11px] tracking-[0.2em] text-gold">AI CEO</p>
        <p className="mt-1 text-lg font-semibold">{a.headline}</p>
        <p className="mt-2 text-xs text-fg-subtle">{c.note}（モデル：{c.model}）</p>
      </div>
      {c.warnings.length > 0 && (
        <Notice tone="warn">
          元データに見当たらない数字があります。正しいか確認してください：{c.warnings.join("、")}
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {blocks.map(([title, lines]) => (
          <Card key={title} title={title}>
            <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {lines.length === 0 ? <li>（記載なし）</li> : lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </Card>
        ))}
      </div>
      <Card title="7. 翌日の行動計画">
        <ol className="space-y-2 text-sm">
          {a.actions.map((x, i) => (
            <li key={i} className="flex flex-col gap-0.5 border-l-2 border-gold-dim pl-3">
              <span>
                {x.title}
                {x.requires_approval && <span className="ml-2 text-[11px] text-warn">要承認</span>}
              </span>
              <span className="text-xs text-fg-subtle">担当：{ownerLabel(x.owner)}／{x.detail}</span>
            </li>
          ))}
        </ol>
      </Card>
      {a.uncertainties.length > 0 && (
        <Card title="AI CEO が分からなかったこと・不確かなこと">
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {a.uncertainties.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </Card>
      )}
      <details className="rounded-lg border border-line bg-navy-900 p-4">
        <summary className="cursor-pointer text-sm text-gold">AIが読んだ元データ（ルールベース版）を見る</summary>
        <div className="mt-4">
          <MeetingView report={c.base} />
        </div>
      </details>
    </div>
  );
}
