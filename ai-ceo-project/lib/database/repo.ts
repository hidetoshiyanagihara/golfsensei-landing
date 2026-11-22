import { all, get, run, type DB } from "./db";
import type { DataKind } from "./schema";
import type { ExpenseCategory } from "../finance/calc";
import type { QaItem } from "../rules";

/** 画面に出すデータの種類。既定は実データのみ */
export type View = { kinds: DataKind[] };
export const ACTUAL_ONLY: View = { kinds: ["actual"] };

function kindsSql(v: View, col = "data_kind"): { sql: string; params: string[] } {
  return { sql: `${col} IN (${v.kinds.map(() => "?").join(",")})`, params: v.kinds };
}

// ---------- settings ----------
export async function getSettings(db: DB): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function num(settings: Record<string, string>, key: string, fallback: number): number {
  const n = Number(settings[key]);
  return settings[key] !== undefined && Number.isFinite(n) ? n : fallback;
}

export function setSettingStmt(key: string, value: string) {
  return {
    sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    args: [key, value],
  };
}

// ---------- audit ----------
export function auditStmt(actor: string, action: string, target = "", detail: unknown = "") {
  return {
    sql: "INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)",
    args: [actor, action, target, typeof detail === "string" ? detail : JSON.stringify(detail)],
  };
}

export async function audit(db: DB, actor: string, action: string, target = "", detail: unknown = ""): Promise<void> {
  await db.execute(auditStmt(actor, action, target, detail));
}

export type AuditRow = { id: number; at: string; actor: string; action: string; target: string; detail: string };
export function recentAudit(db: DB, limit = 30): Promise<AuditRow[]> {
  return all<AuditRow>(db, "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
}

// ---------- login attempts（サーバーが複数台でも共有できるようDBで管理） ----------
const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILS_PER_KEY = 5;
export const MAX_FAILS_GLOBAL = 30;

export async function loginLocked(db: DB, key: string, now = Date.now()): Promise<boolean> {
  await run(db, "DELETE FROM login_attempts WHERE first_at < ?", [now - WINDOW_MS]);
  const rows = await all<{ key: string; count: number }>(db, "SELECT key, count FROM login_attempts");
  const mine = rows.find((r) => r.key === key)?.count ?? 0;
  const total = rows.reduce((a, r) => a + r.count, 0);
  // 1つの接続元から5回、または全体で30回失敗したら15分止める（接続元を偽装した総当たりにも備える）
  return mine >= MAX_FAILS_PER_KEY || total >= MAX_FAILS_GLOBAL;
}

export async function recordLoginFailure(db: DB, key: string, now = Date.now()): Promise<void> {
  await run(
    db,
    `INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1`,
    [key, now],
  );
}

export async function clearLoginFailures(db: DB, key: string): Promise<void> {
  await run(db, "DELETE FROM login_attempts WHERE key = ?", [key]);
}

// ---------- finance ----------
export type SaleRecord = {
  id: number;
  product_id: number | null;
  product_name: string | null;
  sold_at: string;
  quantity: number;
  gross_jpy: number;
  payment_fee_jpy: number;
  refund_jpy: number;
  channel: string;
  note: string;
  data_kind: DataKind;
};

export function salesInMonth(db: DB, month: string, v: View): Promise<SaleRecord[]> {
  const k = kindsSql(v, "s.data_kind");
  return all<SaleRecord>(
    db,
    `SELECT s.*, p.name AS product_name FROM sales s LEFT JOIN products p ON p.id = s.product_id
     WHERE substr(s.sold_at, 1, 7) = ? AND ${k.sql} ORDER BY s.sold_at DESC, s.id DESC`,
    [month, ...k.params],
  );
}

export type ExpenseRecord = {
  id: number;
  spent_at: string;
  category: ExpenseCategory;
  vendor: string;
  amount_jpy: number;
  note: string;
  data_kind: DataKind;
};

export function expensesInMonth(db: DB, month: string, v: View): Promise<ExpenseRecord[]> {
  const k = kindsSql(v);
  return all<ExpenseRecord>(
    db,
    `SELECT * FROM expenses WHERE substr(spent_at, 1, 7) = ? AND ${k.sql} ORDER BY spent_at DESC, id DESC`,
    [month, ...k.params],
  );
}

/** Command Center 内のAI実行で発生した費用（トークン数からの推計）。AI実行は常に実データ */
export async function agentCostInMonth(db: DB, month: string, agentId?: string): Promise<number> {
  const row = await get<{ c: number }>(
    db,
    `SELECT COALESCE(SUM(cost_jpy), 0) AS c FROM agent_runs WHERE substr(started_at, 1, 7) = ? ${agentId ? "AND agent_id = ?" : ""}`,
    agentId ? [month, agentId] : [month],
  );
  return Number(row?.c ?? 0);
}

export function agentCostsByAgent(db: DB, month: string): Promise<{ agent_id: string; c: number }[]> {
  return all(db, "SELECT agent_id, COALESCE(SUM(cost_jpy), 0) AS c FROM agent_runs WHERE substr(started_at, 1, 7) = ? GROUP BY agent_id", [month]);
}

export type ProductSales = { name: string; net: number; count: number; kind: string };
export function salesByProduct(db: DB, month: string, v: View): Promise<ProductSales[]> {
  const k = kindsSql(v, "s.data_kind");
  return all<ProductSales>(
    db,
    `SELECT COALESCE(p.name, '（商品未指定）') AS name, SUM(s.gross_jpy - s.refund_jpy) AS net, SUM(s.quantity) AS count,
            GROUP_CONCAT(DISTINCT s.data_kind) AS kind
     FROM sales s LEFT JOIN products p ON p.id = s.product_id
     WHERE substr(s.sold_at, 1, 7) = ? AND ${k.sql} GROUP BY p.id ORDER BY net DESC`,
    [month, ...k.params],
  );
}

// ---------- agents ----------
export type AgentRow = {
  id: string;
  name: string;
  title: string;
  role: string;
  responsibilities: string;
  model: string;
  status: string;
  monthly_cap_jpy: number;
  last_run_at: string | null;
  sort: number;
};

export function listAgents(db: DB): Promise<AgentRow[]> {
  return all<AgentRow>(db, "SELECT * FROM agents ORDER BY sort");
}

export function getAgent(db: DB, id: string): Promise<AgentRow | undefined> {
  return get<AgentRow>(db, "SELECT * FROM agents WHERE id = ?", [id]);
}

export type AgentRunRow = {
  id: number;
  agent_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger: string;
  summary: string;
  ai_output: string | null;
  execution_result: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_jpy: number;
  error: string | null;
};

export function agentRuns(db: DB, agentId: string, limit = 50): Promise<AgentRunRow[]> {
  return all<AgentRunRow>(db, "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?", [agentId, limit]);
}

export function agentRunCounts(db: DB): Promise<{ agent_id: string; runs: number; errors: number }[]> {
  return all(db, "SELECT agent_id, COUNT(*) AS runs, SUM(status IN ('error','blocked_budget')) AS errors FROM agent_runs GROUP BY agent_id");
}

// ---------- business ideas ----------
export type IdeaRow = {
  id: number;
  business_id: string | null;
  name: string;
  target: string;
  problem: string;
  competitors: string;
  price_hypothesis: string;
  revenue_model: string;
  dev_cost_note: string;
  expected_profit_note: string;
  risks: string;
  score_demand: number | null;
  score_competition: number | null;
  score_price: number | null;
  score_profit: number | null;
  score_difficulty: number | null;
  score_acquisition: number | null;
  score_recurrence: number | null;
  total_score: number | null;
  evaluation_note: string;
  sources: string;
  origin: "owner" | "ai";
  approval_status: "pending" | "approved" | "rejected" | "on_hold";
  decided_at: string | null;
  data_kind: DataKind;
  created_at: string;
};

export function listIdeas(db: DB, v: View): Promise<IdeaRow[]> {
  const k = kindsSql(v);
  return all<IdeaRow>(db, `SELECT * FROM business_ideas WHERE ${k.sql} ORDER BY (total_score IS NULL), total_score DESC, id DESC`, k.params);
}

// ---------- products ----------
export type ProductRow = {
  id: number;
  business_id: string | null;
  name: string;
  description: string;
  price_jpy: number;
  price_is_tentative: number;
  production_status: string;
  qa_status: string;
  sales_status: string;
  components: string;
  qa_checklist: string;
  sales_channel: string;
  owner_approved_at: string | null;
  data_kind: DataKind;
  net_sales: number;
  payment_fees: number;
  buyers: number;
};

export function listProducts(db: DB, v: View): Promise<ProductRow[]> {
  const k = kindsSql(v, "p.data_kind");
  const ks = kindsSql(v, "s.data_kind");
  return all<ProductRow>(
    db,
    `SELECT p.*,
       COALESCE((SELECT SUM(s.gross_jpy - s.refund_jpy) FROM sales s WHERE s.product_id = p.id AND ${ks.sql}), 0) AS net_sales,
       COALESCE((SELECT SUM(s.payment_fee_jpy) FROM sales s WHERE s.product_id = p.id AND ${ks.sql}), 0) AS payment_fees,
       COALESCE((SELECT SUM(s.quantity) FROM sales s WHERE s.product_id = p.id AND s.refund_jpy < s.gross_jpy AND ${ks.sql}), 0) AS buyers
     FROM products p WHERE ${k.sql} ORDER BY p.id`,
    [...ks.params, ...ks.params, ...ks.params, ...k.params],
  );
}

export function getProduct(db: DB, id: number): Promise<ProductRow | undefined> {
  return get<ProductRow>(db, "SELECT * FROM products WHERE id = ?", [id]);
}

export function parseChecklist(json: string): QaItem[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ---------- content ----------
export type ContentRow = {
  id: number;
  business_id: string | null;
  platform: string;
  status: string;
  title: string;
  body: string;
  scheduled_at: string | null;
  posted_at: string | null;
  external_id: string | null;
  url: string | null;
  views: number | null;
  engagements: number | null;
  follower_delta: number | null;
  error: string | null;
  source: string;
  data_kind: DataKind;
};

export function listContent(
  db: DB,
  v: View,
  filter: { status?: string; statuses?: string[]; platform?: string; business?: string; limit?: number; oldestFirst?: boolean } = {},
): Promise<ContentRow[]> {
  const k = kindsSql(v);
  const where = [k.sql];
  const params: (string | number)[] = [...k.params];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.statuses?.length) {
    where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
    params.push(...filter.statuses);
  }
  if (filter.platform) {
    where.push("platform = ?");
    params.push(filter.platform);
  }
  if (filter.business) {
    where.push("business_id = ?");
    params.push(filter.business);
  }
  params.push(filter.limit ?? 200);
  return all<ContentRow>(
    db,
    `SELECT * FROM content_posts WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(posted_at, scheduled_at, created_at) ${filter.oldestFirst ? "ASC" : "DESC"}, id ${filter.oldestFirst ? "ASC" : "DESC"} LIMIT ?`,
    params,
  );
}

export function countContentByStatus(db: DB, v: View): Promise<{ status: string; n: number }[]> {
  const k = kindsSql(v);
  return all(db, `SELECT status, COUNT(*) AS n FROM content_posts WHERE ${k.sql} GROUP BY status`, k.params);
}

export function contentStats(db: DB, month: string, v: View): Promise<{ platform: string; status: string; n: number }[]> {
  const k = kindsSql(v);
  return all(
    db,
    `SELECT platform, status, COUNT(*) AS n FROM content_posts
     WHERE status IN ('posted','failed') AND substr(posted_at, 1, 7) = ? AND ${k.sql}
     GROUP BY platform, status`,
    [month, ...k.params],
  );
}

/** 自動投稿の取り込み済みの最新日（取り込みを差分にするため） */
export async function lastImportedDate(db: DB, source: string): Promise<string | null> {
  const r = await get<{ d: string | null }>(db, "SELECT MAX(posted_at) AS d FROM content_posts WHERE source = ?", [source]);
  return r?.d ?? null;
}

// ---------- metrics ----------
export type MetricRow = {
  id: number;
  metric: string;
  account: string;
  platform: string;
  date: string;
  value: number;
  source: string;
  data_kind: DataKind;
};

/** 指標ごと・アカウント×SNSごとの最新値 */
export function latestMetrics(db: DB, metric: string, v: View): Promise<MetricRow[]> {
  const k = kindsSql(v, "m.data_kind");
  return all<MetricRow>(
    db,
    `SELECT m.* FROM metrics m
     WHERE m.metric = ? AND ${k.sql} AND m.date = (
       SELECT MAX(m2.date) FROM metrics m2
       WHERE m2.metric = m.metric AND m2.account = m.account AND m2.platform = m.platform AND m2.data_kind = m.data_kind)
     ORDER BY m.account, m.platform`,
    [metric, ...k.params],
  );
}

export async function metricSumInMonth(db: DB, metric: string, month: string, v: View): Promise<{ value: number; rows: number }> {
  const k = kindsSql(v);
  const r = await get<{ value: number; rows: number }>(
    db,
    `SELECT COALESCE(SUM(value), 0) AS value, COUNT(*) AS rows FROM metrics WHERE metric = ? AND substr(date, 1, 7) = ? AND ${k.sql}`,
    [metric, month, ...k.params],
  );
  return { value: Number(r?.value ?? 0), rows: Number(r?.rows ?? 0) };
}

export function recentMetrics(db: DB, v: View, limit = 30): Promise<MetricRow[]> {
  const k = kindsSql(v);
  return all<MetricRow>(db, `SELECT * FROM metrics WHERE ${k.sql} ORDER BY date DESC, id DESC LIMIT ?`, [...k.params, limit]);
}

// ---------- inquiries ----------
export type InquiryRow = { id: number; received_at: string; channel: string; category: string; status: string; summary: string; data_kind: string };

export function listInquiries(db: DB, v: View, limit = 30): Promise<InquiryRow[]> {
  const k = kindsSql(v);
  return all<InquiryRow>(db, `SELECT * FROM inquiries WHERE ${k.sql} ORDER BY received_at DESC, id DESC LIMIT ?`, [...k.params, limit]);
}

export async function inquiriesInMonth(db: DB, month: string, v: View): Promise<{ total: number; open: number; needsOwner: number }> {
  const k = kindsSql(v);
  const r = await get<{ total: number; open: number; needsOwner: number }>(
    db,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status IN ('new','in_progress','needs_owner')), 0) AS open,
            COALESCE(SUM(status = 'needs_owner'), 0) AS needsOwner
     FROM inquiries WHERE substr(received_at, 1, 7) = ? AND ${k.sql}`,
    [month, ...k.params],
  );
  return { total: Number(r?.total ?? 0), open: Number(r?.open ?? 0), needsOwner: Number(r?.needsOwner ?? 0) };
}

// ---------- goals / tasks / reports ----------
export type GoalRow = { id: number; horizon: "30d" | "90d"; title: string; metric: string; target_value: number | null; deadline: string; status: string };
export function listGoals(db: DB): Promise<GoalRow[]> {
  return all<GoalRow>(db, "SELECT * FROM goals ORDER BY sort");
}

export type TaskRow = {
  id: number;
  title: string;
  detail: string;
  owner: string;
  due_date: string | null;
  status: string;
  requires_approval: number;
  source: string;
  created_at: string;
};
export function openTasks(db: DB, limit = 50): Promise<TaskRow[]> {
  return all<TaskRow>(db, "SELECT * FROM tasks WHERE status IN ('todo','doing') ORDER BY (due_date IS NULL), due_date, id LIMIT ?", [limit]);
}

export type ReportRow = { id: number; kind: string; period: string; generated_by: string; content: string; created_at: string };
export function listReports(db: DB, limit = 20): Promise<ReportRow[]> {
  return all<ReportRow>(db, "SELECT * FROM reports ORDER BY id DESC LIMIT ?", [limit]);
}
export function getReport(db: DB, id: number): Promise<ReportRow | undefined> {
  return get<ReportRow>(db, "SELECT * FROM reports WHERE id = ?", [id]);
}
