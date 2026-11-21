import type { DB } from "../database/db";
import * as repo from "../database/repo";
import { buildOverview } from "./overview";
import { yen } from "../finance/calc";
import { addDays, daysBetween } from "../time";

/**
 * 経営会議（ルールベース版）。AIを使わず、DBの実データだけから機械的に作る（費用0円）。
 * PHASE 2 で AI CEO がこの結果を読み、文章での分析・提案を追加する。
 * ここで作る文章に、DBにない数字や推測を入れてはいけない。
 */

export type MeetingAction = { title: string; owner: string; detail: string; requiresApproval: boolean };

export type MeetingReport = {
  date: string;
  generatedBy: "rule";
  note: string;
  sections: {
    situation: string[];
    revenue: string[];
    market: string[];
    problems: string[];
    improvements: string[];
    nextBusinesses: string[];
    actions: MeetingAction[];
  };
};

const PLATFORM_LABEL: Record<string, string> = { x: "X", instagram: "Instagram", youtube: "YouTube", note: "note", linkedin: "LinkedIn", other: "その他" };

export async function buildMeetingReport(db: DB, now = new Date()): Promise<MeetingReport> {
  const v = repo.ACTUAL_ONLY; // 経営会議は実データだけで行う
  const [o, products, ideas, goals, settings] = await Promise.all([
    buildOverview(db, v, now),
    repo.listProducts(db, v),
    repo.listIdeas(db, v),
    repo.listGoals(db),
    repo.getSettings(db),
  ]);
  const start = settings.project_start_date ?? o.today;
  const day = daysBetween(start, o.today) + 1;

  const situation: string[] = [];
  const revenue: string[] = [];
  const problems: string[] = [];
  const improvements: string[] = [];
  const actions: MeetingAction[] = [];

  situation.push(`プロジェクト開始（${start}）から${day}日目。`);
  situation.push(
    `商品 ${products.length}件（販売中 ${products.filter((p) => p.sales_status === "on_sale").length}件／品質検査合格 ${products.filter((p) => p.qa_status === "passed").length}件）。`,
  );
  const connected = o.agents.total - (o.agents.byStatus.not_connected ?? 0);
  situation.push(`AI社員 ${o.agents.total}名のうち API 接続済み ${connected}名。自動実行は${o.automationEnabled ? "ON" : "OFF"}。`);
  const platformLines = Object.entries(o.content.byPlatform)
    .filter(([, s]) => s.posted + s.failed > 0)
    .map(([p, s]) => `${PLATFORM_LABEL[p] ?? p} 成功${s.posted}・失敗${s.failed}`)
    .join("／");
  situation.push(`今月の投稿（取り込み済みの実績）：${platformLines || "記録なし"}。`);

  // 売上・利益
  if (o.pnl.grossSales === 0) revenue.push(`今月の売上は 0円（実績）。販売はまだ発生していません。`);
  else
    revenue.push(
      `今月の売上総額 ${yen(o.pnl.grossSales)}、返金 ${yen(o.pnl.refunds)}、純売上 ${yen(o.pnl.netSales)}（実績）。`,
    );
  revenue.push(
    `粗利益 ${yen(o.pnl.grossProfit)}、運営費 ${yen(o.pnl.operatingExpenses)}、営業利益 ${yen(o.pnl.operatingProfit)}（実績）。`,
  );
  revenue.push(`月間予算 ${yen(o.budget.capJpy)} のうち ${yen(o.budget.usedJpy)} を使用、残り ${yen(o.budget.remainingJpy)}。`);
  if (o.pnl.operatingExpenses === 0)
    revenue.push("注意：今月の費用が1件も記録されていません。API・ツールの請求額を財務画面で記録すると、利益が正確になります。");

  // 問題点 → 改善案 → 行動
  const onSale = products.filter((p) => p.sales_status === "on_sale");
  if (onSale.length === 0) {
    problems.push("販売中の商品がありません（売上が発生しない状態）。");
    const first = products.find((p) => p.sales_status !== "on_sale");
    if (first) {
      const cl = repo.parseChecklist(first.qa_checklist);
      const left = cl.filter((i) => !i.done).length;
      improvements.push(`「${first.name}」の制作と品質検査を進める（検査項目の残り ${left}件）。`);
      actions.push({
        title: `「${first.name}」の商品構成と1つ目のテンプレートを作る`,
        owner: "product",
        detail: "PHASE 3。AIが下書きし、代表者が実際に使って確認する。",
        requiresApproval: false,
      });
    }
  }
  const awaiting = products.filter((p) => p.qa_status === "passed" && !p.owner_approved_at);
  for (const p of awaiting) {
    problems.push(`「${p.name}」は品質検査に合格済みだが、代表者の販売承認待ち。`);
    actions.push({ title: `「${p.name}」の販売条件を確認して承認する`, owner: "owner", detail: "商品管理画面から承認", requiresApproval: true });
  }
  if (o.content.failed > 0) {
    problems.push(`今月の投稿で失敗が ${o.content.failed}件あります。`);
    improvements.push("失敗した投稿のエラー内容を確認し、原因（トークン切れ・文字数など）を直す。");
    actions.push({ title: "失敗した投稿のエラー内容を確認する", owner: "owner", detail: "コンテンツ管理画面で「失敗」を絞り込む", requiresApproval: false });
  }
  if (o.followers.length === 0) {
    problems.push("SNSフォロワー数が記録されていないため、集客の効果を測れません。");
    improvements.push("週1回、各SNSのフォロワー数をコンテンツ管理画面で記録する（API連携はPHASE 4）。");
    actions.push({ title: "各SNSの現在のフォロワー数を記録する", owner: "owner", detail: "X・Instagram・YouTube・note", requiresApproval: false });
  }
  const opened = new Set(o.followers.filter((f) => f.account === "ai-ceo").map((f) => f.platform));
  const notOpened = (["x", "note", "instagram", "youtube"] as const).filter((p) => !opened.has(p));
  if (notOpened.length > 0) {
    const names = notOpened.map((p) => PLATFORM_LABEL[p]).join("・");
    problems.push(`AI CEO PROJECT の新アカウント（${names}）が未開設、またはフォロワー数が未記録です。`);
    actions.push({
      title: `AI CEO PROJECT の${names}のアカウントを開設する`,
      owner: "owner",
      detail: "コンテンツ画面の「新アカウント開設」にプロフィール文と手順。開設したらフォロワー数（0でも可）を記録",
      requiresApproval: false,
    });
  }
  if (o.budget.level !== "ok") {
    problems.push(`月間予算の使用率が ${Math.round(o.budget.ratio * 100)}% です。`);
    improvements.push("予算の内訳を確認し、効果の低い支出を止める。");
  }
  if (o.pending.ideas > 0) {
    actions.push({ title: `承認待ちの事業アイデア ${o.pending.ideas}件を判断する`, owner: "owner", detail: "事業開発画面", requiresApproval: true });
  }
  if (o.pending.contentApproval > 0) {
    actions.push({ title: `承認待ちの投稿 ${o.pending.contentApproval}件を確認する`, owner: "owner", detail: "コンテンツ管理画面", requiresApproval: true });
  }
  if (o.inquiries.needsOwner > 0) {
    problems.push(`代表者の判断が必要な問い合わせが ${o.inquiries.needsOwner}件あります。`);
  }
  if (connected === 0) {
    problems.push("AI社員がまだAPIに接続されていません（調査・制作・分析を自動化できない状態）。");
    improvements.push("PHASE 2：AI社員を接続する。最初は代表者がボタンを押したときだけ実行し、予算上限で自動停止させる。");
  }

  // 目標の進み具合（期限が近い・過ぎたものを正直に書く）
  for (const g of goals) {
    if (g.status !== "open") continue;
    const left = daysBetween(o.today, g.deadline);
    if (left < 0) problems.push(`目標「${g.title}」は期限（${g.deadline}）を過ぎましたが未達成です。`);
    else if (left <= 7) problems.push(`目標「${g.title}」の期限まで残り${left}日です（未達成）。`);
  }

  if (problems.length === 0) problems.push("ルールで検出された問題はありません。");
  if (improvements.length === 0) improvements.push("現状の取り組みを継続する。");

  const nextBusinesses = ideas
    .filter((i) => i.approval_status !== "rejected")
    .slice(0, 5)
    .map(
      (i) =>
        `${i.name}（評価：${i.total_score === null ? "未評価" : i.total_score + "点"}／${{ pending: "承認待ち", approved: "承認済み", on_hold: "保留", rejected: "却下" }[i.approval_status]}）`,
    );

  return {
    date: o.today,
    generatedBy: "rule",
    note: "ルールベースで自動作成（AI未使用・費用0円）。数字はすべてDBに記録された実データです。予測は含みません。",
    sections: {
      situation,
      revenue,
      market: ["市場調査AIが未接続のため、市場の変化は未調査です（PHASE 2 で接続）。"],
      problems,
      improvements,
      nextBusinesses: nextBusinesses.length ? nextBusinesses : ["候補なし"],
      actions,
    },
  };
}

/** 会議の結果を保存し、翌日の行動計画をタスクに登録する（同じタイトルの未完了タスクがあれば作らない） */
export async function saveMeeting(db: DB, report: MeetingReport): Promise<number> {
  const open = new Set((await repo.openTasks(db, 1000)).map((t) => t.title));
  const actions = report.sections.actions.filter((a) => !open.has(a.title));
  // 1回の batch（1つのトランザクション）で、レポート・タスク・操作ログをまとめて保存する
  const results = await db.batch(
    [
      { sql: "INSERT INTO reports (kind, period, generated_by, content) VALUES ('meeting', ?, 'rule', ?)", args: [report.date, JSON.stringify(report)] },
      ...actions.map((a) => ({
        sql: `INSERT INTO tasks (title, detail, owner, due_date, requires_approval, source)
              VALUES (?, ?, ?, ?, ?, 'meeting:' || (SELECT MAX(id) FROM reports))`,
        args: [a.title, a.detail, a.owner, addDays(report.date, 1), a.requiresApproval ? 1 : 0],
      })),
      repo.auditStmt("system", "meeting.generated", "report", { by: "rule", actions: actions.length }),
    ],
    "write",
  );
  return Number(results[0].lastInsertRowid);
}
