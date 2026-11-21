import type { DB } from "./db";
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
export function getSettings(db: DB): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function num(settings: Record<string, string>, key: string, fallback: number): number {
  const n = Number(settings[key]);
  return Number.isFinite(n) ? n : fallback;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

// ---------- audit ----------
export function audit(db: DB, actor: string, action: string, target = "", detail: unknown = ""): void {
  db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)").run(
    actor,
    action,
    target,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

export type AuditRow = { id: number; at: string; actor: string; action: string; target: string; detail: string };
export function recentAudit(db: DB, limit = 30): AuditRow[] {
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as AuditRow[];
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

export function salesInMonth(db: DB, month: string, v: View): SaleRecord[] {
  const k = kindsSql(v, "s.data_kind");
  return db
    .prepare(
      `SELECT s.*, p.name AS product_name FROM sales s LEFT JOIN products p ON p.id = s.product_id
       WHERE substr(s.sold_at, 1, 7) = ? AND ${k.sql} ORDER BY s.sold_at DESC, s.id DESC`,
    )
    .all(month, ...k.params) as SaleRecord[];
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

export function expensesInMonth(db: DB, month: string, v: View): ExpenseRecord[] {
  const k = kindsSql(v);
  return db
    .prepare(`SELECT * FROM expenses WHERE substr(spent_at, 1, 7) = ? AND ${k.sql} ORDER BY spent_at DESC, id DESC`)
    .all(month, ...k.params) as ExpenseRecord[];
}

/** Command Center 内のAI実行で発生した費用（トークン数からの推計）。AI実行は常に実データ */
export function agentCostInMonth(db: DB, month: string, agentId?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_jpy), 0) AS c FROM agent_runs WHERE substr(started_at, 1, 7) = ? ${agentId ? "AND agent_id = ?" : ""}`,
    )
    .get(...(agentId ? [month, agentId] : [month])) as { c: number };
  return row.c;
}

export function salesByProduct(db: DB, month: string, v: View): { name: string; net: number; count: number; kind: string }[] {
  const k = kindsSql(v, "s.data_kind");
  return db
    .prepare(
      `SELECT COALESCE(p.name, '（商品未指定）') AS name, SUM(s.gross_jpy - s.refund_jpy) AS net, SUM(s.quantity) AS count,
              GROUP_CONCAT(DISTINCT s.data_kind) AS kind
       FROM sales s LEFT JOIN products p ON p.id = s.product_id
       WHERE substr(s.sold_at, 1, 7) = ? AND ${k.sql} GROUP BY p.id ORDER BY net DESC`,
    )
    .all(month, ...k.params) as { name: string; net: number; count: number; kind: string }[];
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

export function listAgents(db: DB): AgentRow[] {
  return db.prepare("SELECT * FROM agents ORDER BY sort").all() as AgentRow[];
}

export function getAgent(db: DB, id: string): AgentRow | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
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

export function agentRuns(db: DB, agentId: string, limit = 50): AgentRunRow[] {
  return db.prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?").all(agentId, limit) as AgentRunRow[];
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

export function listIdeas(db: DB, v: View): IdeaRow[] {
  const k = kindsSql(v);
  return db
    .prepare(`SELECT * FROM business_ideas WHERE ${k.sql} ORDER BY (total_score IS NULL), total_score DESC, id DESC`)
    .all(...k.params) as IdeaRow[];
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

export function listProducts(db: DB, v: View): ProductRow[] {
  const k = kindsSql(v, "p.data_kind");
  const ks = kindsSql(v, "s.data_kind");
  return db
    .prepare(
      `SELECT p.*,
         COALESCE((SELECT SUM(s.gross_jpy - s.refund_jpy) FROM sales s WHERE s.product_id = p.id AND ${ks.sql}), 0) AS net_sales,
         COALESCE((SELECT SUM(s.payment_fee_jpy) FROM sales s WHERE s.product_id = p.id AND ${ks.sql}), 0) AS payment_fees,
         COALESCE((SELECT SUM(s.quantity) FROM sales s WHERE s.product_id = p.id AND s.refund_jpy < s.gross_jpy AND ${ks.sql}), 0) AS buyers
       FROM products p WHERE ${k.sql} ORDER BY p.id`,
    )
    .all(...ks.params, ...ks.params, ...ks.params, ...k.params) as ProductRow[];
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

export function listContent(db: DB, v: View, filter: { status?: string; platform?: string; limit?: number } = {}): ContentRow[] {
  const k = kindsSql(v);
  const where = [k.sql];
  const params: (string | number)[] = [...k.params];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.platform) {
    where.push("platform = ?");
    params.push(filter.platform);
  }
  params.push(filter.limit ?? 200);
  return db
    .prepare(
      `SELECT * FROM content_posts WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(posted_at, scheduled_at, created_at) DESC, id DESC LIMIT ?`,
    )
    .all(...params) as ContentRow[];
}

export function contentStats(db: DB, month: string, v: View): { platform: string; status: string; n: number }[] {
  const k = kindsSql(v);
  return db
    .prepare(
      `SELECT platform, status, COUNT(*) AS n FROM content_posts
       WHERE substr(COALESCE(posted_at, scheduled_at, created_at), 1, 7) = ? AND ${k.sql}
       GROUP BY platform, status`,
    )
    .all(month, ...k.params) as { platform: string; status: string; n: number }[];
}

// ---------- metrics ----------
export type MetricRow = { id: number; metric: string; platform: string; date: string; value: number; source: string; data_kind: DataKind };

/** 指標ごと・SNSごとの最新値 */
export function latestMetrics(db: DB, metric: string, v: View): MetricRow[] {
  const k = kindsSql(v, "m.data_kind");
  return db
    .prepare(
      `SELECT m.* FROM metrics m
       WHERE m.metric = ? AND ${k.sql} AND m.date = (
         SELECT MAX(m2.date) FROM metrics m2 WHERE m2.metric = m.metric AND m2.platform = m.platform AND m2.data_kind = m.data_kind)
       ORDER BY m.platform`,
    )
    .all(metric, ...k.params) as MetricRow[];
}

export function metricSumInMonth(db: DB, metric: string, month: string, v: View): { value: number; rows: number } {
  const k = kindsSql(v);
  return db
    .prepare(`SELECT COALESCE(SUM(value), 0) AS value, COUNT(*) AS rows FROM metrics WHERE metric = ? AND substr(date, 1, 7) = ? AND ${k.sql}`)
    .get(metric, month, ...k.params) as { value: number; rows: number };
}

export function recentMetrics(db: DB, v: View, limit = 30): MetricRow[] {
  const k = kindsSql(v);
  return db.prepare(`SELECT * FROM metrics WHERE ${k.sql} ORDER BY date DESC, id DESC LIMIT ?`).all(...k.params, limit) as MetricRow[];
}

// ---------- inquiries ----------
export function inquiriesInMonth(db: DB, month: string, v: View): { total: number; open: number; needsOwner: number } {
  const k = kindsSql(v);
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status IN ('new','in_progress','needs_owner')), 0) AS open,
              COALESCE(SUM(status = 'needs_owner'), 0) AS needsOwner
       FROM inquiries WHERE substr(received_at, 1, 7) = ? AND ${k.sql}`,
    )
    .get(month, ...k.params) as { total: number; open: number; needsOwner: number };
}

// ---------- goals / tasks / reports ----------
export type GoalRow = { id: number; horizon: "30d" | "90d"; title: string; metric: string; target_value: number | null; deadline: string; status: string };
export function listGoals(db: DB): GoalRow[] {
  return db.prepare("SELECT * FROM goals ORDER BY sort").all() as GoalRow[];
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
export function openTasks(db: DB, limit = 50): TaskRow[] {
  return db
    .prepare("SELECT * FROM tasks WHERE status IN ('todo','doing') ORDER BY (due_date IS NULL), due_date, id LIMIT ?")
    .all(limit) as TaskRow[];
}

export type ReportRow = { id: number; kind: string; period: string; generated_by: string; content: string; created_at: string };
export function listReports(db: DB, limit = 20): ReportRow[] {
  return db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?").all(limit) as ReportRow[];
}
export function getReport(db: DB, id: number): ReportRow | undefined {
  return db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined;
}

export function countSample(db: DB): number {
  const tables = ["business_ideas", "products", "sales", "expenses", "content_posts", "metrics", "inquiries"];
  return tables.reduce(
    (a, t) => a + (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE data_kind = 'sample'`).get() as { n: number }).n,
    0,
  );
}
