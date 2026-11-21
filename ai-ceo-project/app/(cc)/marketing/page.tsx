import Link from "next/link";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { getView } from "@/lib/view";
import { addInquiry, addMetric, createDraft, deleteRecord, transitionContent, updateInquiry } from "@/app/actions";
import { allowedContentTransitions, type ContentStatus } from "@/lib/rules";
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

type SP = Promise<{ ok?: string; err?: string; status?: string; platform?: string }>;

export default async function MarketingPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = getDb();
  const view = await getView();
  const status = STATUSES.includes(sp.status ?? "") ? sp.status : undefined;
  const platform = PL[sp.platform ?? ""] ? sp.platform : undefined;
  const queue = repo.listContent(db, view, { limit: 1000 }).filter((c) => ["draft", "pending_approval", "approved", "scheduled"].includes(c.status));
  const posts = repo.listContent(db, view, { status, platform, limit: 100 });
  const metrics = repo.recentMetrics(db, view, 20);
  const inquiries = db
    .prepare(`SELECT * FROM inquiries WHERE data_kind IN (${view.kinds.map(() => "?").join(",")}) ORDER BY received_at DESC, id DESC LIMIT 30`)
    .all(...view.kinds) as { id: number; received_at: string; channel: string; category: string; status: string; summary: string; data_kind: string }[];
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
      <PageHeader title="コンテンツ管理" en="CONTENT" description="下書き → 承認 → 予約 → 投稿。承認していない投稿は予約・投稿できません。" />
      <Flash ok={sp.ok} err={sp.err} />

      <Card title={`承認・予約の待ち行列（${queue.length}件）`}>
        {queue.length === 0 ? (
          <Empty>下書き・承認待ち・予約済みの投稿はありません。</Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {queue.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusPill status={c.status} />
                    <span className="text-xs text-fg-subtle">{PL[c.platform]}</span>
                    {c.data_kind === "sample" && <DataBadge kind="sample" />}
                    <span className="font-medium">{c.title}</span>
                  </div>
                  {c.body && <p className="mt-1 line-clamp-2 text-xs whitespace-pre-line text-fg-muted">{c.body}</p>}
                  <p className="mt-0.5 text-[11px] text-fg-subtle">予定日：{c.scheduled_at ?? "未定"}</p>
                </div>
                {c.data_kind === "actual" && (
                  <form action={transitionContent} className="flex shrink-0 flex-wrap gap-1.5">
                    <input type="hidden" name="id" value={c.id} />
                    {allowedContentTransitions(c.status as ContentStatus).map((to) => (
                      <Button key={to} name="to" value={to} variant={to === "approved" || to === "pending_approval" || to === "scheduled" ? "primary" : "ghost"}>
                        {to === "pending_approval" ? "承認依頼" : to === "approved" ? "承認" : to === "draft" ? "下書きに戻す" : to === "scheduled" ? "予約" : statusLabel(to)}
                      </Button>
                    ))}
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="下書きを作る" className="mt-4">
        <form action={createDraft} className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr]">
          <div><label htmlFor="platform">投稿先</label><select id="platform" name="platform">{PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label htmlFor="title">タイトル（必須）</label><input id="title" name="title" required maxLength={200} /></div>
          <div><label htmlFor="scheduled_at">予定日</label><input id="scheduled_at" name="scheduled_at" type="date" /></div>
          <div className="sm:col-span-3"><label htmlFor="body">本文</label><textarea id="body" name="body" rows={4} /></div>
          <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
            <Button>下書きを保存</Button>
            <p className="text-xs text-fg-subtle">投稿前に確認：事実関係／誤情報／著作権／誤解を生む表現／誇大広告／個人情報／代表者のプライバシー</p>
          </div>
        </form>
      </Card>

      <Card title="投稿一覧" className="mt-4">
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
            <table className="w-full min-w-[720px]">
              <thead><tr><th className={th}>日付</th><th className={th}>投稿先</th><th className={th}>状態</th><th className={th}>テーマ</th><th className={`${th} text-right`}>閲覧数</th><th className={`${th} text-right`}>反応率</th><th className={`${th} text-right`}>フォロワー増減</th><th className={th}>出所</th></tr></thead>
              <tbody>
                {posts.map((c) => (
                  <tr key={c.id}>
                    <td className={`${td} num whitespace-nowrap`}>{c.posted_at ?? c.scheduled_at ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap`}>{PL[c.platform]}</td>
                    <td className={td}><StatusPill status={c.status} /></td>
                    <td className={td}>
                      {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="hover:text-gold">{c.title}</a> : c.title}
                      {c.error && <p className="text-xs text-bad">{c.error}</p>}
                    </td>
                    <td className={`${td} num text-right`}>{c.views ?? "—"}</td>
                    <td className={`${td} num text-right`}>{c.views && c.engagements != null ? `${((c.engagements / c.views) * 100).toFixed(1)}%` : "—"}</td>
                    <td className={`${td} num text-right`}>{c.follower_delta ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap text-xs`}>{c.data_kind === "sample" ? <DataBadge kind="sample" /> : c.source === "axion-autopost" ? "自動投稿" : "手動"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="mt-3 text-xs text-fg-subtle">閲覧数・反応率は SNS の公式API連携（PHASE 4）で取り込む予定です。連携までは「—」と表示します。</p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="数値を記録する（フォロワー数など）">
          <div id="metrics" />
          <form action={addMetric} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div><label htmlFor="m-metric">指標</label><select id="m-metric" name="metric">{Object.entries(METRICS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="m-platform">SNS</label><select id="m-platform" name="platform">{PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="m-value">数値</label><input id="m-value" name="value" inputMode="numeric" required /></div>
            <div><label htmlFor="m-date">日付</label><input id="m-date" name="date" type="date" defaultValue={today} /></div>
            <div className="col-span-2 sm:col-span-4"><Button>記録する</Button></div>
          </form>
          <ul className="mt-4 divide-y divide-line/60 text-sm">
            {metrics.length === 0 && <li className="py-2 text-fg-subtle">まだ記録がありません。</li>}
            {metrics.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-fg-muted">{m.date} {PL[m.platform]} {METRICS[m.metric] ?? m.metric} {m.data_kind === "sample" && <DataBadge kind="sample" />}</span>
                <span className="flex items-center gap-2">
                  <span className="num">{m.value.toLocaleString("ja-JP")}</span>
                  {m.data_kind === "actual" && (
                    <form action={deleteRecord}><input type="hidden" name="table" value="metrics" /><input type="hidden" name="id" value={m.id} /><button className="text-xs text-fg-subtle hover:text-bad" aria-label="削除">削除</button></form>
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
