import Link from "next/link";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { getView } from "@/lib/view";
import {
  addInquiry,
  addMetric,
  createDraft,
  deleteRecord,
  importAutopostNow,
  markPostedManually,
  runAgentTask,
  transitionContent,
  updateContent,
  updateInquiry,
} from "@/app/actions";
import { CopyButton } from "@/components/common/CopyButton";
import { RichCopyButton } from "@/components/common/RichCopyButton";
import { markdownToHtml, markdownToPlain, parseExtra } from "@/lib/marketing/note-format";
import { DEFAULT_POST_TIME } from "@/lib/automation/publisher";
import { xWeightedLength } from "@/lib/social/x";
import { hasApiKey } from "@/lib/ai/llm";
import { marketingDraftsTask } from "@/lib/ai/tasks/marketing-drafts";
import { yen } from "@/lib/finance/calc";
import { allowedContentTransitions, type ContentStatus } from "@/lib/rules";
import { ACCOUNTS, PROFILES, SETUP_CHECKLIST } from "@/lib/marketing/launch-kit";
import { jstDate } from "@/lib/time";
import { Button, Card, DataBadge, Empty, PageHeader, StatusPill, TableWrap, statusLabel, td, th } from "@/components/common/ui";
import { Flash } from "@/components/common/Flash";

export const metadata = { title: "コンテンツ管理" };

const PLATFORMS = [
  ["x", "X"],
  ["instagram", "Instagram"],
  ["youtube", "YouTube"],
  ["note", "note"],
  ["linkedin", "LinkedIn"],
  ["other", "その他"],
] as const;
const PL: Record<string, string> = Object.fromEntries(PLATFORMS);
const STATUSES = ["draft", "pending_approval", "approved", "scheduled", "posted", "failed", "skipped"];
const METRICS: Record<string, string> = { followers: "フォロワー数", article_views: "記事閲覧数", profile_visits: "プロフィール訪問", link_clicks: "リンククリック" };
const INQ: Record<string, string> = { purchase: "購入前の質問", usage: "使い方", bug: "不具合", refund: "返金", partnership: "提携・取材", other: "その他" };
const BIZ: Record<string, string> = { "ai-ceo-project": "AI CEO PROJECT", "ai-business-lab": "AI BUSINESS LAB", "axion-sales": "AXION SALES", "copipe-ai": "コピペAI仕事術" };
const ACC: Record<string, string> = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a.label]));

type SP = Promise<{ ok?: string; err?: string; status?: string; platform?: string }>;

export default async function MarketingPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const view = await getView();
  const status = STATUSES.includes(sp.status ?? "") ? sp.status : undefined;
  const platform = PL[sp.platform ?? ""] ? sp.platform : undefined;
  const [queue, posts, metrics, inquiries, newAccountFollowers] = await Promise.all([
    repo.listContent(db, view, { statuses: ["draft", "pending_approval", "approved", "scheduled", "failed"], limit: 100, oldestFirst: true }),
    repo.listContent(db, view, { status, platform, limit: 100 }),
    repo.recentMetrics(db, view, 20),
    repo.listInquiries(db, view),
    repo.latestMetrics(db, "followers", repo.ACTUAL_ONLY),
  ]);
  const settings = await repo.getSettings(db);
  const playbook = await repo.latestPlaybook(db);
  const startedPlatforms = new Set(newAccountFollowers.filter((m) => m.account === "ai-ceo").map((m) => m.platform));
  const today = jstDate();
  const filterHref = (s?: string, p?: string) => {
    const q = new URLSearchParams();
    if (s) q.set("status", s);
    if (p) q.set("platform", p);
    const qs = q.toString();
    return `/marketing${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <PageHeader title="コンテンツ管理" en="CONTENT" description="下書き → 承認依頼 → 承認 → 予約 → 投稿。承認していない投稿は予約・投稿できません。" />
      <Flash ok={sp.ok} err={sp.err} />

      <Card title="新アカウント開設（AI CEO PROJECT）" aside={<span className="text-[11px] text-fg-subtle">開設後、フォロワー数を記録すると「開設済み」になります</span>}>
        <div className="grid gap-3 md:grid-cols-2">
          {PROFILES.map((p) => {
            const steps = SETUP_CHECKLIST.find((c) => c.platform === p.platform)?.steps ?? [];
            const started = startedPlatforms.has(p.platform);
            return (
              <details key={p.platform} className="group rounded-md border border-line bg-navy-950/40 p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                  <span className="text-sm font-medium">{p.label}</span>
                  <span className={`text-xs ${started ? "text-good" : "text-fg-subtle"}`}>{started ? "✓ 開設済み" : "未開設"} <span className="text-gold group-open:hidden">▼</span></span>
                </summary>
                <div className="mt-3 space-y-3 text-sm">
                  <div>
                    <p className="text-[11px] text-fg-subtle">アカウント名の候補（空いているかは登録画面で確認）</p>
                    <p className="font-mono text-xs text-gold">{p.handles.map((h) => `@${h}`).join("　")}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-fg-subtle">表示名</p>
                    <p>{p.name}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-fg-subtle">
                      自己紹介（{[...p.bio].length}／{p.limit}文字）
                    </p>
                    <p className="whitespace-pre-line rounded bg-navy-800 p-2 text-xs leading-6 select-all">{p.bio}</p>
                  </div>
                  <ol className="list-decimal space-y-1 pl-5 text-xs text-fg-muted">
                    {steps.map((s) => <li key={s}>{s}</li>)}
                  </ol>
                </div>
              </details>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-fg-subtle">最初の投稿の下書き（X 3本・note 1本・Instagram 1本・YouTube 1本）は、下の待ち行列に入っています。【 】の部分はご自身の言葉で書いてください。発信名は「HIDE」です。</p>
      </Card>

      <PlaybookCard pb={playbook} />

      <Card
        title={`承認・予約の待ち行列（${queue.length}件）`}
        className="mt-4"
        aside={
          <form action={runAgentTask}>
            <input type="hidden" name="task" value="marketing.drafts" />
            <Button disabled={!hasApiKey()} variant="ghost" title="マーケティングAIが、X 5本と note 1本の下書きを作ります">
              AIに下書きを頼む（上限 約{yen(marketingDraftsTask.estimateJpy(settings))}）
            </Button>
          </form>
        }
      >
        <p className="mb-3 text-xs text-fg-subtle">
          流れ：下書き → 承認 → 予約。AI CEO PROJECT の X は、予約すると予定の時刻に自動で投稿されます（設定画面で自動投稿をONにしたとき）。note は自動投稿できない（公式の投稿APIがない）ため、「本文をコピー」して note の予約投稿で公開してください。
        </p>
        {queue.length === 0 ? (
          <Empty>下書き・承認待ち・予約済みの投稿はありません。</Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {queue.map((c) => (
              <li key={c.id} className="py-3">
                {(() => {
                  const autoX = c.platform === "x" && c.business_id === "ai-ceo-project";
                  const autoIg = c.platform === "instagram" && c.business_id === "ai-ceo-project";
                  const auto = autoX || autoIg;
                  const slides = c.platform === "instagram" ? parseExtra(c.extra).slides ?? [] : [];
                  const when = c.scheduled_at ? `${c.scheduled_at} ${c.post_time ?? DEFAULT_POST_TIME}` : "未定";
                  const xLen = c.platform === "x" ? Math.ceil(xWeightedLength(c.body) / 2) : null;
                  const editable = c.data_kind === "actual" && ["draft", "pending_approval", "approved", "scheduled", "failed"].includes(c.status);
                  return (
                    <>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <StatusPill status={c.status} />
                            <span className="text-xs text-fg-subtle">
                              {BIZ[c.business_id ?? ""] ?? "—"}・{PL[c.platform]}
                            </span>
                            {c.source === "ai-marketing" && <span className="text-[11px] text-gold">AI下書き</span>}
                            {c.data_kind === "sample" && <DataBadge kind="sample" />}
                          </div>
                          <p className="mt-1 font-medium">{c.title}</p>
                          {c.status === "failed" && c.error && <p className="mt-1 text-xs text-bad">失敗の理由：{c.error}（直して「保存して予約」を押すと、もう一度投稿します）</p>}
                          <p className="mt-0.5 text-[11px] text-fg-subtle">
                            予定：{when}／{auto ? <span className="text-gold">{autoX ? "X" : "Instagram"} に自動投稿</span> : "手で投稿"}
                            {xLen !== null && <span className={xLen > 140 ? "text-bad" : ""}>／{xLen}字</span>}
                          </p>
                          {c.review_note && <p className="mt-1 whitespace-pre-line text-[11px] text-warn">{c.review_note}</p>}
                        </div>
                        {c.data_kind === "actual" && (
                          <form action={transitionContent} className="flex shrink-0 flex-wrap gap-1.5">
                            <input type="hidden" name="id" value={c.id} />
                            {allowedContentTransitions(c.status as ContentStatus).map((to) => (
                              <Button key={to} name="to" value={to} variant={to === "approved" || to === "pending_approval" || to === "scheduled" ? "primary" : "ghost"}>
                                {to === "pending_approval" ? "承認依頼" : to === "approved" ? "承認" : to === "draft" ? "下書きに戻す" : to === "scheduled" ? (auto ? "予約（自動投稿）" : "予約") : statusLabel(to)}
                              </Button>
                            ))}
                          </form>
                        )}
                      </div>
                      {c.body && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-gold">本文を見る・直す（{[...c.body].length}文字）</summary>
                          {editable && <p className="mt-2 text-[11px] text-fg-subtle">直したら、下の「保存して予約」か「保存だけ」を押してください（押さずに上の「予約」を押すと、直した内容は保存されません）。</p>}
                          {editable ? (
                            <form action={updateContent} className="mt-2 space-y-2">
                              <input type="hidden" name="id" value={c.id} />
                              <div><label htmlFor={`t-${c.id}`}>タイトル</label><input id={`t-${c.id}`} name="title" defaultValue={c.title} required maxLength={200} /></div>
                              <div><label htmlFor={`b-${c.id}`}>{c.platform === "instagram" ? "キャプション" : "本文"}</label><textarea id={`b-${c.id}`} name="body" defaultValue={c.body} rows={c.platform === "note" ? 14 : 5} /></div>
                              {slides.length > 0 && (
                                <div className="space-y-2 rounded border border-line p-2">
                                  <p className="text-[11px] text-fg-subtle">スライドの文字（1枚目は表紙）</p>
                                  {slides.map((sl, i) => (
                                    <div key={i} className="grid gap-1 sm:grid-cols-[1fr_2fr]">
                                      <input name={`slide_heading_${i}`} defaultValue={sl.heading} aria-label={`${i + 1}枚目の見出し`} maxLength={40} />
                                      <input name={`slide_text_${i}`} defaultValue={sl.text} aria-label={`${i + 1}枚目の文`} maxLength={160} />
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="grid grid-cols-2 gap-2">
                                <div><label htmlFor={`d-${c.id}`}>予定日</label><input id={`d-${c.id}`} name="scheduled_at" type="date" defaultValue={c.scheduled_at ?? ""} /></div>
                                <div><label htmlFor={`h-${c.id}`}>時刻</label><input id={`h-${c.id}`} name="post_time" type="time" defaultValue={c.post_time ?? DEFAULT_POST_TIME} /></div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {(c.status === "approved" || c.status === "scheduled") && (
                                  <Button name="then" value="schedule">{auto ? "保存して予約（自動投稿）" : "保存して予約"}</Button>
                                )}
                                <Button variant="ghost">保存だけ</Button>
                                {!auto && c.platform !== "note" && <CopyButton text={c.body} />}
                              </div>
                            </form>
                          ) : null}
                          {c.platform === "note" && c.body && (
                            <NoteKit id={c.id} title={c.title} body={c.body} extra={c.extra} />
                          )}
                          {slides.length > 0 && (
                            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                              {slides.map((_, i) => (
                                <a key={i} href={`/api/note-image/${c.id}?kind=slide&n=${i + 1}&download=1`} title="保存">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={`/api/note-image/${c.id}?kind=slide&n=${i + 1}`} alt={`${i + 1}枚目`} loading="lazy" className="w-full rounded border border-line" />
                                </a>
                              ))}
                            </div>
                          )}
                          {editable ? null : (
                            <p className="mt-2 whitespace-pre-line rounded bg-navy-800 p-3 text-sm leading-7 select-all">{c.body}</p>
                          )}
                        </details>
                      )}
                      {c.data_kind === "actual" && !auto && (c.status === "approved" || c.status === "scheduled") && (
                        <form action={markPostedManually} className="mt-2 flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={c.id} />
                          <div className="min-w-48 flex-1">
                            <label htmlFor={`url-${c.id}`}>手で投稿したら、URLを貼って記録（任意）</label>
                            <input id={`url-${c.id}`} name="url" placeholder="https://..." />
                          </div>
                          <Button variant="ghost">投稿した</Button>
                        </form>
                      )}
                    </>
                  );
                })()}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="下書きを作る" className="mt-4">
        <form action={createDraft} className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr_1fr]">
          <div>
            <label htmlFor="business">アカウント</label>
            <select id="business" name="business" defaultValue="ai-ceo-project">
              {Object.entries(BIZ).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div><label htmlFor="platform">投稿先</label><select id="platform" name="platform">{PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label htmlFor="title">タイトル（必須）</label><input id="title" name="title" required maxLength={200} /></div>
          <div><label htmlFor="scheduled_at">予定日・時刻</label><input id="scheduled_at" name="scheduled_at" type="date" /><input aria-label="時刻" name="post_time" type="time" defaultValue={DEFAULT_POST_TIME} className="mt-1" /></div>
          <div className="sm:col-span-4"><label htmlFor="body">本文</label><textarea id="body" name="body" rows={4} /></div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-4">
            <Button>下書きを保存</Button>
            <p className="text-xs text-fg-subtle">投稿前に確認：事実関係／誤情報／著作権／誤解を生む表現／誇大広告／個人情報／代表者のプライバシー</p>
          </div>
        </form>
      </Card>

      <Card
        title="投稿一覧"
        className="mt-4"
        aside={
          <form action={importAutopostNow}>
            <Button variant="ghost" title="GitHub に保存された AXION SALES の自動投稿の結果を読み込みます（読むだけ・費用0円）">自動投稿の結果を取り込む</Button>
          </form>
        }
      >
        <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
          <Link href={filterHref(undefined, platform)} className={`rounded border px-2 py-0.5 ${!status ? "border-gold-dim text-gold" : "border-navy-700 text-fg-muted"}`}>すべて</Link>
          {STATUSES.map((s) => (
            <Link key={s} href={filterHref(s, platform)} className={`rounded border px-2 py-0.5 ${status === s ? "border-gold-dim text-gold" : "border-navy-700 text-fg-muted"}`}>{statusLabel(s)}</Link>
          ))}
          <span className="mx-1 text-fg-subtle">|</span>
          <Link href={filterHref(status, undefined)} className={`rounded border px-2 py-0.5 ${!platform ? "border-gold-dim text-gold" : "border-navy-700 text-fg-muted"}`}>全SNS</Link>
          {PLATFORMS.map(([v, l]) => (
            <Link key={v} href={filterHref(status, v)} className={`rounded border px-2 py-0.5 ${platform === v ? "border-gold-dim text-gold" : "border-navy-700 text-fg-muted"}`}>{l}</Link>
          ))}
        </div>
        {posts.length === 0 ? (
          <Empty>該当する投稿はありません。</Empty>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[760px]">
              <thead><tr><th className={th}>日付</th><th className={th}>アカウント</th><th className={th}>投稿先</th><th className={th}>状態</th><th className={th}>テーマ</th><th className={`${th} text-right`}>閲覧数</th><th className={`${th} text-right`}>反応率</th><th className={th}>出所</th></tr></thead>
              <tbody>
                {posts.map((c) => (
                  <tr key={c.id}>
                    <td className={`${td} num whitespace-nowrap`}>{c.posted_at ?? c.scheduled_at ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap text-xs text-fg-muted`}>{BIZ[c.business_id ?? ""] ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap`}>{PL[c.platform]}</td>
                    <td className={td}><StatusPill status={c.status} /></td>
                    <td className={td}>
                      {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="hover:text-gold">{c.title}</a> : c.title}
                      {c.error && <p className="text-xs text-bad">{c.error}</p>}
                    </td>
                    <td className={`${td} num text-right`}>{c.views ?? "—"}</td>
                    <td className={`${td} num text-right`}>{c.views && c.engagements != null ? `${((c.engagements / c.views) * 100).toFixed(1)}%` : "—"}</td>
                    <td className={`${td} whitespace-nowrap text-xs`}>{c.data_kind === "sample" ? <DataBadge kind="sample" /> : c.source === "axion-autopost" ? "自動投稿" : c.source === "launch-kit" ? "開設キット" : "手動"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="mt-3 text-xs text-fg-subtle">閲覧数・反応率は、各SNSの公式APIとの連携（PHASE 4）で取り込む予定です。連携するまでは「—」と表示します。</p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="数値を記録する（フォロワー数など）">
          <div id="metrics" />
          <form action={addMetric} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div><label htmlFor="m-account">アカウント</label><select id="m-account" name="account">{ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></div>
            <div><label htmlFor="m-platform">SNS</label><select id="m-platform" name="platform">{PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="m-metric">指標</label><select id="m-metric" name="metric">{Object.entries(METRICS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="m-value">数値</label><input id="m-value" name="value" inputMode="numeric" required /></div>
            <div><label htmlFor="m-date">日付</label><input id="m-date" name="date" type="date" defaultValue={today} /></div>
            <div className="flex items-end"><Button>記録する</Button></div>
          </form>
          <ul className="mt-4 divide-y divide-line/60 text-sm">
            {metrics.length === 0 && <li className="py-2 text-fg-subtle">まだ記録がありません。</li>}
            {metrics.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate text-fg-muted">
                  {m.date} {ACC[m.account] ?? "（アカウント未指定）"}・{PL[m.platform]} {METRICS[m.metric] ?? m.metric} {m.data_kind === "sample" && <DataBadge kind="sample" />}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="num">{m.value.toLocaleString("ja-JP")}</span>
                  {m.data_kind === "actual" && (
                    <form action={deleteRecord}><input type="hidden" name="table" value="metrics" /><input type="hidden" name="id" value={m.id} /><button className="text-xs text-fg-subtle hover:text-bad">削除</button></form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="問い合わせ">
          <div id="inquiries" />
          <form action={addInquiry} className="grid grid-cols-2 gap-2">
            <div><label htmlFor="i-date">受信日</label><input id="i-date" name="received_at" type="date" defaultValue={today} /></div>
            <div><label htmlFor="i-cat">分類</label><select id="i-cat" name="category">{Object.entries(INQ).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="i-ch">経路</label><input id="i-ch" name="channel" placeholder="note / メール など" /></div>
            <div className="col-span-2"><label htmlFor="i-sum">要約（氏名・メールアドレスなどの個人情報は書かない）</label><input id="i-sum" name="summary" maxLength={500} /></div>
            <div className="col-span-2"><Button>記録する</Button></div>
          </form>
          <ul className="mt-4 divide-y divide-line/60 text-sm">
            {inquiries.length === 0 && <li className="py-2 text-fg-subtle">問い合わせはまだありません。</li>}
            {inquiries.map((q) => (
              <li key={q.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0">
                  <span className="text-xs text-fg-subtle">{q.received_at}・{INQ[q.category]}</span> {q.data_kind === "sample" && <DataBadge kind="sample" />}
                  <span className="block truncate">{q.summary || "（要約なし）"}</span>
                </span>
                {q.data_kind === "actual" ? (
                  <form action={updateInquiry} className="flex shrink-0 gap-1">
                    <input type="hidden" name="id" value={q.id} />
                    <select name="status" defaultValue={q.status} className="w-auto py-1 text-xs" aria-label="状態">
                      {["new", "in_progress", "needs_owner", "closed"].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select>
                    <Button variant="ghost">更新</Button>
                  </form>
                ) : <StatusPill status={q.status} />}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-subtle">返金・契約変更・個人情報に関わる問い合わせは、必ず代表者が判断します。</p>
        </Card>
      </div>
    </>
  );
}

/** note の記事用：書式つきコピー・見出し画像・図解画像・note を開く */
function NoteKit({ id, title, body, extra }: { id: number; title: string; body: string; extra: string | null }) {
  const ex = parseExtra(extra);
  const figures = ex.figures ?? [];
  const img = (q: string) => `/api/note-image/${id}?${q}`;
  return (
    <div className="mt-3 space-y-3 rounded-md border border-gold-dim/50 bg-navy-950/40 p-3">
      <p className="text-xs font-medium text-gold">note に投稿する手順</p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-fg-muted">
        <li>「書式つきでコピー」を押して、note の本文に貼る（見出し・太字・箇条書きが残ります）</li>
        <li>見出し画像を保存して、note の「見出し画像」に設定する</li>
        <li>本文の「▼ここに図◯の画像を入れる」の場所に、図解画像を入れて、その行は消す</li>
        <li>note の公開設定で日時を選んで予約投稿 → ここで「投稿した」を押す</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <RichCopyButton html={markdownToHtml(body)} plain={markdownToPlain(body)} />
        <a href="https://note.com/notes/new" target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border border-navy-700 px-3 py-1.5 text-sm text-gold hover:border-gold-dim">
          note で書く
        </a>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <figure className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img("kind=header")} alt={`見出し画像：${title}`} loading="lazy" className="w-full rounded border border-line" />
          <figcaption className="flex items-center justify-between text-[11px] text-fg-subtle">
            見出し画像（1280×670）
            <a href={img("kind=header&download=1")} className="text-gold hover:underline">保存</a>
          </figcaption>
        </figure>
        {figures.map((f, i) => (
          <figure key={i} className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img(`kind=fig&n=${i + 1}`)} alt={`図${i + 1}：${f.title}`} loading="lazy" className="w-full rounded border border-line" />
            <figcaption className="flex items-center justify-between text-[11px] text-fg-subtle">
              図{i + 1}：{f.title}
              <a href={img(`kind=fig&n=${i + 1}&download=1`)} className="text-gold hover:underline">保存</a>
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="text-[11px] text-fg-subtle">iPhone では、画像を長押しして「写真に保存」でも保存できます。{figures.length === 0 && "この記事には図解がありません（AIに下書きを頼むと、図解つきの記事を作ります）。"}</p>
    </div>
  );
}

/** 投稿の型の手本帳（競合研究の結果） */
function PlaybookCard({ pb }: { pb: repo.PlaybookRow | undefined }) {
  if (!pb) {
    return (
      <Card title="投稿の型の手本帳" className="mt-4">
        <div id="playbook" />
        <p className="text-sm text-fg-subtle">
          まだありません。<Link href="/agents/research" className="text-gold underline">市場調査AI</Link>の「競合研究・投稿の型の手本帳」を実行すると、伸びている発信者の型（書き出し・構成・頻度）をまとめ、マーケティングAIが下書きに使います。
        </p>
      </Card>
    );
  }
  const c = JSON.parse(pb.content) as {
    summary: string;
    accounts: { name: string; platform: string; strengths: string; source_url: string }[];
    patterns: { name: string; platform: string; structure: string; why: string }[];
    hooks: string[];
    cadence: string;
    differentiation: string;
    avoid: string[];
    researched_at?: string;
  };
  return (
    <Card title="投稿の型の手本帳" className="mt-4" aside={<span className="text-[11px] text-fg-subtle">{c.researched_at} 調査・マーケティングAIが参考にします</span>}>
      <div id="playbook" />
      <p className="text-sm text-fg-muted">{c.summary}</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-gold">型 {c.patterns.length}個・書き出し {c.hooks.length}個・参考にした発信者 {c.accounts.length}件を見る</summary>
        <div className="mt-2 space-y-3 text-sm">
          <ul className="space-y-1">
            {c.patterns.map((p, i) => (
              <li key={i}><span className="text-gold">{p.platform}</span>｜<b>{p.name}</b>：{p.structure}<span className="block text-xs text-fg-subtle">{p.why}</span></li>
            ))}
          </ul>
          <div><p className="text-xs text-fg-subtle">書き出しの型</p><ul className="list-disc pl-5">{c.hooks.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
          <p><span className="text-xs text-fg-subtle">投稿の頻度：</span>{c.cadence}</p>
          <p><span className="text-xs text-fg-subtle">HIDE が勝てる点：</span>{c.differentiation}</p>
          <div><p className="text-xs text-fg-subtle">やらないこと</p><ul className="list-disc pl-5">{c.avoid.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
          <div><p className="text-xs text-fg-subtle">参考にした発信者（型だけを参考にし、文章は写しません）</p>
            <ul className="space-y-0.5 text-xs">{c.accounts.map((a, i) => <li key={i}><a href={a.source_url} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline">{a.name}</a>（{a.platform}）：{a.strengths}</li>)}</ul>
          </div>
        </div>
      </details>
    </Card>
  );
}
