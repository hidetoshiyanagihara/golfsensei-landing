import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { getView } from "@/lib/view";
import { createIdea, decideIdea, scoreIdea } from "@/app/actions";
import { Button, Card, DataBadge, Empty, Notice, PageHeader, StatusPill } from "@/components/common/ui";
import { Flash, type FlashParams } from "@/components/common/Flash";

export const metadata = { title: "事業開発" };

const SCORES = [
  ["demand", "需要"],
  ["competition", "競争率（低いほど高得点）"],
  ["price", "販売価格の妥当性"],
  ["profit", "想定利益"],
  ["difficulty", "開発のしやすさ"],
  ["acquisition", "顧客獲得のしやすさ"],
  ["recurrence", "継続販売の可能性"],
] as const;

const FLOW = ["市場調査", "事業アイデア", "収益性分析", "100点評価", "商品企画", "試作品", "品質検査", "代表者承認", "販売開始", "結果分析", "改善"];

type Source = { title: string; url: string; accessed_at: string; kind: "fact" | "estimate" };

export default async function BusinessPage({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const db = await getDb();
  const view = await getView();
  const ideas = await repo.listIdeas(db, view);

  return (
    <>
      <PageHeader title="事業開発" en="BUSINESS DEVELOPMENT" description="市場調査AIが見つけた事業アイデアと、代表者の承認状況" />
      <Flash {...sp} />

      <Card title="自動事業開発のサイクル（PART 5）" className="mb-4">
        <ol className="flex flex-wrap gap-1.5 text-xs">
          {FLOW.map((s, i) => (
            <li key={s} className={`rounded border px-2 py-1 ${i === 7 ? "border-gold-dim text-gold" : "border-navy-700 text-fg-muted"}`}>
              <span className="num mr-1 text-fg-subtle">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-fg-subtle">
          現在は手動で運用しています。市場調査AI（PHASE 2）が接続されると、STEP 1〜4 の調査・評価案をここに自動で追加します（情報源と調査日付き）。承認（STEP 8）は常に代表者が行います。
        </p>
      </Card>

      <div className="space-y-4">
        {ideas.length === 0 && <Empty>事業アイデアはまだありません。</Empty>}
        {ideas.map((i) => {
          const sources = JSON.parse(i.sources) as Source[];
          const scores = SCORES.map(([key]) => i[`score_${key}` as keyof repo.IdeaRow] as number | null);
          return (
            <Card key={i.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{i.name}</h2>
                    <StatusPill status={i.approval_status} />
                    <DataBadge kind={i.data_kind === "sample" ? "sample" : "actual"} />
                    <span className="text-[11px] text-fg-subtle">提案：{i.origin === "owner" ? "代表者" : "AI"}</span>
                  </div>
                  <p className="mt-1 text-sm text-fg-muted">{i.problem}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[11px] text-fg-subtle">AI評価（100点満点）</p>
                  <p className="num text-2xl font-semibold text-gold">{i.total_score ?? "未評価"}</p>
                </div>
              </div>

              <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["顧客ターゲット", i.target],
                  ["競合", i.competitors],
                  ["価格仮説", i.price_hypothesis],
                  ["収益モデル", i.revenue_model],
                  ["開発コスト", i.dev_cost_note],
                  ["期待利益", i.expected_profit_note],
                  ["リスク", i.risks],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-[11px] text-fg-subtle">{k}</dt>
                    <dd className={v ? "text-fg" : "text-fg-subtle"}>{v || "未調査"}</dd>
                  </div>
                ))}
              </dl>

              {i.evaluation_note && <p className="mt-3 border-l-2 border-gold-dim pl-3 text-sm text-fg-muted">{i.evaluation_note}</p>}

              <div className="mt-3">
                <p className="text-[11px] text-fg-subtle">情報源</p>
                {sources.length === 0 ? (
                  <p className="text-xs text-fg-subtle">なし（市場データは未調査。根拠のない数字は評価に使いません）</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {sources.map((s, n) => (
                      <li key={n}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-gold hover:underline">{s.title}</a>
                        <span className="ml-2 text-fg-subtle">{s.accessed_at} 調査／{s.kind === "fact" ? "事実" : "推測"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {i.data_kind === "actual" && (
                <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 lg:flex-row lg:items-start lg:justify-between">
                  <details className="min-w-0 flex-1">
                    <summary className="cursor-pointer text-sm text-gold">評価と情報源を入力する</summary>
                    <form action={scoreIdea} className="mt-3 space-y-3">
                      <input type="hidden" name="id" value={i.id} />
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {SCORES.map(([key, label], n) => (
                          <div key={key}>
                            <label htmlFor={`s-${i.id}-${key}`}>{label}</label>
                            <input id={`s-${i.id}-${key}`} name={`score_${key}`} inputMode="numeric" defaultValue={scores[n] ?? ""} placeholder="0〜100" />
                          </div>
                        ))}
                      </div>
                      <div>
                        <label htmlFor={`n-${i.id}`}>評価の根拠（事実と推測を分けて書く）</label>
                        <textarea id={`n-${i.id}`} name="evaluation_note" rows={2} defaultValue={i.evaluation_note} />
                      </div>
                      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
                        <div><label>情報源のURL（任意）</label><input name="source_url" placeholder="https://..." /></div>
                        <div><label>タイトル</label><input name="source_title" /></div>
                        <div><label>種類</label><select name="source_kind"><option value="fact">事実</option><option value="estimate">推測</option></select></div>
                      </div>
                      <Button>評価を保存</Button>
                    </form>
                  </details>
                  <form action={decideIdea} className="flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={i.id} />
                    <Button name="decision" value="approved" variant={i.approval_status === "approved" ? "primary" : "ghost"}>承認</Button>
                    <Button name="decision" value="on_hold" variant="ghost">保留</Button>
                    <Button name="decision" value="rejected" variant="danger">却下</Button>
                  </form>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card title="事業アイデアを追加する（代表者の提案）" className="mt-6">
        <form action={createIdea} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><label htmlFor="name">事業名（必須）</label><input id="name" name="name" required maxLength={120} /></div>
          <div><label htmlFor="target">顧客ターゲット</label><input id="target" name="target" /></div>
          <div><label htmlFor="price_hypothesis">価格仮説</label><input id="price_hypothesis" name="price_hypothesis" /></div>
          <div className="sm:col-span-2"><label htmlFor="problem">解決する問題</label><textarea id="problem" name="problem" rows={2} /></div>
          <div><label htmlFor="competitors">競合</label><input id="competitors" name="competitors" /></div>
          <div><label htmlFor="revenue_model">収益モデル</label><input id="revenue_model" name="revenue_model" /></div>
          <div><label htmlFor="dev_cost_note">開発コスト</label><input id="dev_cost_note" name="dev_cost_note" /></div>
          <div><label htmlFor="expected_profit_note">期待利益</label><input id="expected_profit_note" name="expected_profit_note" /></div>
          <div className="sm:col-span-2"><label htmlFor="risks">リスク</label><textarea id="risks" name="risks" rows={2} /></div>
          <div className="sm:col-span-2"><Button>追加する</Button></div>
        </form>
        <div className="mt-3"><Notice>追加したアイデアは「承認待ち」になります。評価点は、根拠（情報源）があるときだけ入力してください。</Notice></div>
      </Card>
    </>
  );
}
