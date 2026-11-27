import { all, batch, get, type DB } from "../database/db";
import * as repo from "../database/repo";
import { monthUsage } from "../ai/runner";
import { DEFAULT_POST_TIME, jstStamp } from "../automation/publisher";

/**
 * 自動点検（GitHub Actions：ai_ceo_health.yml から数時間ごと）。
 * 止まっている仕組み・お金の使いすぎ・見落としを探し、管理画面の「次にやること」に【自動点検】として載せる。
 * 直ったものは、次の点検で自動的に「完了」にする。AI は使わない（費用0円）。
 */
export type HealthIssue = { title: string; detail: string };

const minutesBetween = (a: string, b: string) => (Date.parse(`${b.replace(" ", "T")}:00+09:00`) - Date.parse(`${a.replace(" ", "T")}:00+09:00`)) / 60000;
const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")}円`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
export const HEALTH_PREFIX = "【自動点検】";

export async function healthIssues(db: DB, now = new Date()): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];
  const s = await repo.getSettings(db);
  const stamp = jstStamp(now);
  const minusH = (h: number) => jstStamp(new Date(now.getTime() - h * 3600_000));

  // 1. 15分ごとの見回り（Netlify）が止まっていないか
  if (s.x_autopost_enabled === "true" || s.ig_autopost_enabled === "true") {
    const last = (s.scheduler_last_run ?? "").slice(0, 16);
    const gap = last ? minutesBetween(last, stamp) : Infinity;
    if (gap > 90)
      issues.push({
        title: "自動投稿の見回りが止まっています",
        detail: `最後に動いたのは ${last || "記録なし"}。Netlify の無料枠（クレジット）切れ・サイト停止の可能性があります。Netlify の管理画面で、サイトが止まっていないか確認してください。`,
      });
  }

  // 2. 予約時刻を過ぎても出ていない自動投稿（X は2時間、Instagram は1日2本・3時間あけるので8時間まで待つ）
  const overdue = async (platform: string, hours: number) =>
    Number(
      (
        await get<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM content_posts WHERE status = 'scheduled' AND platform = ? AND business_id = 'ai-ceo-project' AND data_kind = 'actual'
             AND (scheduled_at || ' ' || COALESCE(post_time, '${DEFAULT_POST_TIME}')) <= ?`,
          [platform, minusH(hours)],
        )
      )?.n ?? 0,
    );
  const ox = await overdue("x", 2), oi = await overdue("instagram", 8);
  if (ox) issues.push({ title: `X の予約投稿が${ox}件、時刻を過ぎても出ていません`, detail: "コンテンツ画面で、エラーや【 】の残りがないか確認してください。" });
  if (oi) issues.push({ title: `Instagram の予約投稿が${oi}件、時刻を過ぎても出ていません`, detail: "コンテンツ画面で、エラーや合鍵（トークン）の期限を確認してください。" });

  // 3. 手で投稿する予定（note・YouTube の台本など）を過ぎたもの
  const manual = await all<{ title: string; scheduled_at: string }>(
    db,
    `SELECT title, scheduled_at FROM content_posts WHERE status IN ('approved','scheduled') AND data_kind = 'actual' AND business_id = 'ai-ceo-project'
       AND platform NOT IN ('x','instagram') AND scheduled_at IS NOT NULL AND scheduled_at < ? ORDER BY scheduled_at`,
    [stamp.slice(0, 10)],
  );
  if (manual.length)
    issues.push({
      title: `手で投稿する予定を過ぎたものが${manual.length}件`,
      detail: `${manual.slice(0, 3).map((m) => `${m.scheduled_at}「${m.title.slice(0, 30)}」`).join("、")}。投稿したら「投稿した」、やめるなら「見送り」を押してください。`,
    });

  // 4. 24時間以内に予定があるのに、承認待ちのままの下書き
  const pending = Number(
    (
      await get<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM content_posts WHERE status IN ('draft','pending_approval') AND data_kind = 'actual' AND business_id = 'ai-ceo-project'
           AND scheduled_at IS NOT NULL AND (scheduled_at || ' ' || COALESCE(post_time, '${DEFAULT_POST_TIME}')) <= ?`,
        [jstStamp(new Date(now.getTime() + 24 * 3600_000))],
      )
    )?.n ?? 0,
  );
  if (pending) issues.push({ title: `24時間以内に予定の下書きが${pending}件、承認待ちです`, detail: "承認して予約しないと投稿されません。" });

  // 5. 投稿の失敗（直近7日）
  const failed = await all<{ id: number; platform: string; title: string; error: string | null }>(
    db,
    "SELECT id, platform, title, error FROM content_posts WHERE status = 'failed' AND data_kind = 'actual' AND business_id = 'ai-ceo-project' ORDER BY id",
  );
  if (failed.length)
    issues.push({
      title: `失敗した投稿が${failed.length}件あります`,
      detail: `${failed.slice(0, 3).map((f) => `#${f.id}（${f.platform}）「${f.title.slice(0, 30)}」：${(f.error ?? "").slice(0, 120)}`).join(" ／ ")}。直して予約し直すか、見送りにしてください。`,
    });

  // 6. Anthropic の残高不足（直近24時間）
  // （チャージしたあとに AI の仕事が1回でも成功していれば、直ったとみなす）
  const credit = await get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM agent_runs e WHERE e.status = 'error' AND e.error LIKE '%credit balance%' AND e.started_at >= ?
       AND NOT EXISTS (SELECT 1 FROM agent_runs s WHERE s.status = 'success' AND s.cost_jpy > 0 AND s.started_at > e.started_at)`,
    [new Date(now.getTime() - 24 * 3600_000).toISOString()],
  );
  if (Number(credit?.n ?? 0))
    issues.push({ title: "Anthropic API の残高が足りません", detail: "AI社員の仕事が失敗しています。console.anthropic.com の Plans & Billing でチャージしてください（自動チャージはオフのままがおすすめ）。" });

  // 7. お金：月間予算・AI API 上限・AI社員ごとの上限
  const budget = repo.num(s, "monthly_budget_jpy", 30000), aiCap = repo.num(s, "ai_api_monthly_cap_jpy", 10000);
  const agents = await repo.listAgents(db);
  const any = await monthUsage(db, agents[0]?.id ?? "ceo");
  for (const [label, used, cap] of [["月間予算", any.total, budget], ["AI API の月間上限", any.ai, aiCap]] as const) {
    const r = cap > 0 ? used / cap : 1;
    if (r >= 0.85) issues.push({ title: `${label}の${pct(r)}を使いました（85%以上）`, detail: `${yen(used)}／${yen(cap)}。上限に達すると AI は自動で止まります。` });
    else if (r >= 0.7) issues.push({ title: `${label}の${pct(r)}を使いました（70%以上）`, detail: `${yen(used)}／${yen(cap)}。` });
  }
  for (const a of agents) {
    if (a.status === "paused")
      issues.push({ title: `AI社員「${a.name}」が停止中です`, detail: "予算の上限で止まった可能性があります。上限を変えるときは代表者の判断で（GitHub Actions「AI CEO agent cap」）。" });
    else if (a.monthly_cap_jpy > 0) {
      const u = (await monthUsage(db, a.id)).agent;
      if (u / a.monthly_cap_jpy >= 0.8) issues.push({ title: `AI社員「${a.name}」が月の上限の${pct(u / a.monthly_cap_jpy)}を使いました`, detail: `${yen(u)}／${yen(a.monthly_cap_jpy)}。` });
    }
  }

  // 8. バックアップが止まっていないか（3日）
  const lastBackup = s.backup_last_at ? Date.parse(s.backup_last_at) : 0;
  if (now.getTime() - lastBackup > 3 * 24 * 3600_000)
    issues.push({ title: "データベースのバックアップが3日以上取れていません", detail: "GitHub の Actions「AI CEO DB backup」を確認してください。" });

  return issues;
}

/** 点検の結果を「次にやること」に反映する（同じ件名は重ねない・直ったものは完了にする） */
export async function syncHealthTasks(db: DB, issues: HealthIssue[]): Promise<{ added: number; closed: number }> {
  const open = await all<{ id: number; title: string; detail: string }>(db, "SELECT id, title, detail FROM tasks WHERE source = 'health' AND status IN ('todo','doing')");
  const want = new Map(issues.map((i) => [`${HEALTH_PREFIX}${i.title}`.slice(0, 200), i.detail]));
  const have = new Set(open.map((t) => t.title));
  const stmts = [
    ...[...want].filter(([t]) => !have.has(t)).map(([t, d]) => ({ sql: "INSERT INTO tasks (title, detail, owner, source) VALUES (?, ?, 'owner', 'health')", args: [t, d] })),
    ...open.filter((t) => !want.has(t.title)).map((t) => ({ sql: "UPDATE tasks SET status = 'done' WHERE id = ?", args: [t.id] })),
    // 件名が同じで中身（金額・件名の一覧など）が変わったものは、説明だけ新しくする
    ...open.filter((t) => want.has(t.title) && want.get(t.title) !== t.detail).map((t) => ({ sql: "UPDATE tasks SET detail = ? WHERE id = ?", args: [want.get(t.title)!, t.id] })),
  ];
  const added = [...want.keys()].filter((t) => !have.has(t)).length, closed = open.filter((t) => !want.has(t.title)).length;
  if (stmts.length) await batch(db, [...stmts, repo.auditStmt("system", "health.check", "", { added, closed, open: want.size })]);
  return { added, closed };
}
