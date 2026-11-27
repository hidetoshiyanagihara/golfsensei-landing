import type { InStatement } from "@libsql/client";
import { all, batch, get, run, type DB } from "../database/db";
import * as repo from "../database/repo";
import { computePnL } from "../finance/calc";
import { checkRun } from "../automation/budget";
import { costFromUsage, usdToJpy, type UsageTotals } from "./models";
import { anthropicCall, describeError, hasApiKey, type LlmCall } from "./llm";
import { jstMonth } from "../time";

/**
 * AI社員の仕事を「受付（queued）→ 実行（running）→ 結果」で動かす。
 * 受付の時点で予算を確認し、超えそうなら実行しない（PART 11-7, 11-10）。
 * 時間のかかる仕事は Netlify のバックグラウンド関数で executeRun を呼ぶ（最大15分）。
 */

export type TaskResult = {
  /** AIが出した内容（判断・提案） */
  aiOutput: string;
  /** 実際に行われたこと（保存したレポート・登録したアイデアなど） */
  executionResult: string;
  model: string;
  usage: UsageTotals;
};

export type TaskContext = {
  db: DB;
  call: LlmCall;
  params: Record<string, unknown>;
  settings: Record<string, string>;
  runId: number;
};

export type TaskDef = {
  name: string;
  agentId: string;
  label: string;
  /** AIを使う仕事か（使わない仕事は接続・予算の確認をしない） */
  usesAi: boolean;
  /** 実行前の見積もり（上限・円） */
  estimateJpy: (settings: Record<string, string>) => number;
  run: (ctx: TaskContext) => Promise<TaskResult>;
};

const registry = new Map<string, TaskDef>();
export function registerTask(t: TaskDef): void {
  registry.set(t.name, t);
}
export function getTask(name: string): TaskDef | undefined {
  return registry.get(name);
}

/** 20分以上「実行中」のままの仕事は失敗扱いにする（途中で止まった場合） */
export async function failStaleRuns(db: DB, nowIso = new Date().toISOString()): Promise<void> {
  const limit = new Date(Date.parse(nowIso) - 20 * 60 * 1000).toISOString();
  await run(
    db,
    `UPDATE agent_runs SET status = 'error', finished_at = ?, error = '時間内に終わらなかったため中断扱いにしました'
     WHERE status IN ('queued','running') AND started_at < ?`,
    [nowIso, limit],
  );
}

/** 今月の使用額（予約中の見積もりも含める＝同時に何本も走らせて上限を超えないように） */
export async function monthUsage(db: DB, agentId: string) {
  const month = jstMonth();
  const [expenses, runsAll, runsAgent, reserved] = await Promise.all([
    repo.expensesInMonth(db, month, repo.ACTUAL_ONLY),
    repo.agentCostInMonth(db, month),
    repo.agentCostInMonth(db, month, agentId),
    all<{ agent_id: string; r: number }>(
      db,
      "SELECT agent_id, COALESCE(SUM(estimate_jpy), 0) AS r FROM agent_runs WHERE status IN ('queued','running') GROUP BY agent_id",
    ),
  ]);
  const reservedAll = reserved.reduce((a, x) => a + Number(x.r), 0);
  const reservedAgent = Number(reserved.find((x) => x.agent_id === agentId)?.r ?? 0);
  const pnl = computePnL([], expenses, runsAll + reservedAll);
  return { total: pnl.operatingExpenses, ai: pnl.byCategory.ai_api, agent: runsAgent + reservedAgent };
}

export type QueueResult = { ok: true; runId: number } | { ok: false; reason: string };

export async function queueRun(
  db: DB,
  taskName: string,
  params: Record<string, unknown>,
  trigger: "manual" | "schedule" = "manual",
): Promise<QueueResult> {
  const task = getTask(taskName);
  if (!task) return { ok: false, reason: "不明な仕事です" };
  await failStaleRuns(db);
  const settings = await repo.getSettings(db);
  const agent = await repo.getAgent(db, task.agentId);
  if (!agent) return { ok: false, reason: "AI社員が見つかりません" };
  const estimate = task.usesAi ? task.estimateJpy(settings) : 0;
  const now = new Date().toISOString();

  if (task.usesAi) {
    if (!hasApiKey()) return { ok: false, reason: "Claude API のキーが設定されていません（Netlify の環境変数 ANTHROPIC_API_KEY）" };
    const busy = await get(db, "SELECT 1 FROM agent_runs WHERE agent_id = ? AND status IN ('queued','running')", [task.agentId]);
    if (busy) return { ok: false, reason: `${agent.name}は別の仕事を実行中です。終わってから実行してください` };
    const used = await monthUsage(db, task.agentId);
    const check = checkRun({
      trigger,
      automationEnabled: settings.automation_enabled === "true",
      agentStatus: agent.status,
      estimateJpy: estimate,
      total: { capJpy: repo.num(settings, "monthly_budget_jpy", 30000), usedJpy: used.total },
      ai: { capJpy: repo.num(settings, "ai_api_monthly_cap_jpy", 10000), usedJpy: used.ai },
      agent: { capJpy: agent.monthly_cap_jpy, usedJpy: used.agent },
    });
    if (!check.allowed) {
      const stmts: InStatement[] = [
        {
          sql: `INSERT INTO agent_runs (agent_id, task, params, started_at, finished_at, status, trigger, summary, estimate_jpy, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [task.agentId, task.name, JSON.stringify(params), now, now, check.pauseAgent ? "blocked_budget" : "skipped", trigger, task.label, estimate, check.reason],
        },
        repo.auditStmt("system", "agent.blocked", task.agentId, check.reason),
      ];
      if (check.pauseAgent) stmts.push({ sql: "UPDATE agents SET status = 'paused' WHERE id = ?", args: [task.agentId] });
      await batch(db, stmts);
      return { ok: false, reason: check.reason };
    }
  }

  const r = await db.batch(
    [
      {
        sql: `INSERT INTO agent_runs (agent_id, task, params, started_at, status, trigger, summary, estimate_jpy)
              VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        args: [task.agentId, task.name, JSON.stringify(params), now, trigger, task.label, estimate],
      },
      repo.auditStmt(trigger === "manual" ? "owner" : "system", "agent.queued", task.agentId, { task: task.name, estimate }),
    ],
    "write",
  );
  return { ok: true, runId: Number(r[0].lastInsertRowid) };
}

export async function executeRun(db: DB, runId: number, call: LlmCall = anthropicCall): Promise<{ ok: boolean; message: string }> {
  // 受付中のものだけを「実行中」にする（同じ仕事を二重に実行しない）
  const claimed = await run(db, "UPDATE agent_runs SET status = 'running' WHERE id = ? AND status = 'queued'", [runId]);
  if (claimed.changes !== 1) return { ok: false, message: "この仕事はすでに実行済みか、見つかりません" };
  const row = await get<{ agent_id: string; task: string; params: string; estimate_jpy: number }>(
    db,
    "SELECT agent_id, task, params, estimate_jpy FROM agent_runs WHERE id = ?",
    [runId],
  );
  const task = row && getTask(row.task);
  if (!row || !task) {
    await run(db, "UPDATE agent_runs SET status = 'error', finished_at = ?, error = '不明な仕事です' WHERE id = ?", [new Date().toISOString(), runId]);
    return { ok: false, message: "不明な仕事です" };
  }
  await run(db, "UPDATE agents SET status = 'running' WHERE id = ? AND status <> 'paused'", [row.agent_id]);
  const settings = await repo.getSettings(db);
  try {
    const res = await task.run({ db, call, params: JSON.parse(row.params || "{}"), settings, runId });
    const usd = task.usesAi ? costFromUsage(res.model, res.usage) : 0;
    const jpy = usdToJpy(usd, repo.num(settings, "usd_jpy", 155));
    const now = new Date().toISOString();
    await batch(db, [
      {
        sql: `UPDATE agent_runs SET status = 'success', finished_at = ?, ai_output = ?, execution_result = ?, model = ?,
                input_tokens = ?, output_tokens = ?, web_searches = ?, cost_usd = ?, cost_jpy = ? WHERE id = ?`,
        args: [now, res.aiOutput, res.executionResult, res.model, res.usage.inputTokens, res.usage.outputTokens, res.usage.webSearches, usd, jpy, runId],
      },
      { sql: "UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'idle' END, last_run_at = ? WHERE id = ?", args: [now, row.agent_id] },
      repo.auditStmt("system", "agent.succeeded", row.agent_id, { task: row.task, cost_jpy: jpy, estimate_jpy: row.estimate_jpy }),
    ]);
    // 実行後に上限に達していたら、それ以上動かないよう止める
    const agent = await repo.getAgent(db, row.agent_id);
    const used = await monthUsage(db, row.agent_id);
    if (agent && task.usesAi && (used.agent >= agent.monthly_cap_jpy || used.ai >= repo.num(settings, "ai_api_monthly_cap_jpy", 10000))) {
      await batch(db, [
        { sql: "UPDATE agents SET status = 'paused' WHERE id = ?", args: [row.agent_id] },
        repo.auditStmt("system", "agent.paused_budget", row.agent_id, used),
      ]);
    }
    return { ok: true, message: res.executionResult };
  } catch (e) {
    const msg = describeError(e);
    const now = new Date().toISOString();
    // 途中で失敗しても、それまでにかかった費用は記録する（記録漏れで費用が少なく見えないように）
    const partial = e as { usage?: UsageTotals; model?: string };
    const pUsd = task.usesAi && partial.usage && partial.model ? costFromUsage(partial.model, partial.usage) : 0;
    const pJpy = usdToJpy(pUsd, repo.num(settings, "usd_jpy", 155));
    await batch(db, [
      {
        sql: `UPDATE agent_runs SET status = 'error', finished_at = ?, error = ?, model = COALESCE(?, model), input_tokens = ?, output_tokens = ?,
                web_searches = ?, cost_usd = ?, cost_jpy = ? WHERE id = ?`,
        args: [now, msg, partial.model ?? null, partial.usage?.inputTokens ?? 0, partial.usage?.outputTokens ?? 0, partial.usage?.webSearches ?? 0, pUsd, pJpy, runId],
      },
      { sql: "UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'error' END, last_run_at = ? WHERE id = ?", args: [now, row.agent_id] },
      repo.auditStmt("system", "agent.failed", row.agent_id, { task: row.task, error: msg }),
    ]);
    return { ok: false, message: msg };
  }
}

/** APIキーの有無に合わせて「未接続／待機中」を切り替える（停止中はそのまま） */
export async function syncAgentConnection(db: DB, connected = hasApiKey()): Promise<void> {
  if (connected) await run(db, "UPDATE agents SET status = 'idle' WHERE status = 'not_connected'");
  else await run(db, "UPDATE agents SET status = 'not_connected' WHERE status IN ('idle','error')");
}
