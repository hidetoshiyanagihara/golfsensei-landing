import type { DB } from "../database/db";
import * as repo from "../database/repo";
import { computePnL, type PnL } from "../finance/calc";
import { evaluateBudget, type BudgetStatus } from "../automation/budget";
import { jstDate, jstMonth } from "../time";

export type Overview = {
  month: string;
  today: string;
  pnl: PnL;
  /** Command Center 内のAI実行費（トークン数からの推計） */
  agentCostJpy: number;
  aiApiJpy: number;
  budget: BudgetStatus;
  aiBudget: BudgetStatus;
  productSales: { name: string; net: number; count: number; kind: string }[];
  followers: repo.MetricRow[];
  articleViews: { value: number; rows: number };
  inquiries: { total: number; open: number; needsOwner: number };
  agents: { total: number; byStatus: Record<string, number> };
  content: { posted: number; failed: number; pendingApproval: number; drafts: number; byPlatform: Record<string, { posted: number; failed: number }> };
  pending: { ideas: number; contentApproval: number; productsAwaitingApproval: number; inquiriesNeedOwner: number };
  automationEnabled: boolean;
};

export function buildOverview(db: DB, view: repo.View, now = new Date()): Overview {
  const month = jstMonth(now);
  const settings = repo.getSettings(db);
  const sales = repo.salesInMonth(db, month, view);
  const expenses = repo.expensesInMonth(db, month, view);
  const agentCostJpy = repo.agentCostInMonth(db, month);
  const pnl = computePnL(sales, expenses, agentCostJpy);

  const warn = repo.num(settings, "budget_warn_ratio", 0.8);
  const budget = evaluateBudget(repo.num(settings, "monthly_budget_jpy", 30000), pnl.operatingExpenses, warn);
  const aiApiJpy = pnl.byCategory.ai_api;
  const aiBudget = evaluateBudget(repo.num(settings, "ai_api_monthly_cap_jpy", 10000), aiApiJpy, warn);

  const agents = repo.listAgents(db);
  const byStatus: Record<string, number> = {};
  for (const a of agents) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  const stats = repo.contentStats(db, month, view);
  const byPlatform: Record<string, { posted: number; failed: number }> = {};
  let posted = 0,
    failed = 0;
  for (const s of stats) {
    byPlatform[s.platform] ??= { posted: 0, failed: 0 };
    if (s.status === "posted") {
      byPlatform[s.platform].posted += s.n;
      posted += s.n;
    } else if (s.status === "failed") {
      byPlatform[s.platform].failed += s.n;
      failed += s.n;
    }
  }
  const allContent = repo.listContent(db, view, { limit: 10000 });
  const pendingApproval = allContent.filter((c) => c.status === "pending_approval").length;
  const drafts = allContent.filter((c) => c.status === "draft").length;

  const ideas = repo.listIdeas(db, view);
  const products = repo.listProducts(db, view);
  const inquiries = repo.inquiriesInMonth(db, month, view);

  return {
    month,
    today: jstDate(now),
    pnl,
    agentCostJpy,
    aiApiJpy,
    budget,
    aiBudget,
    productSales: repo.salesByProduct(db, month, view),
    followers: repo.latestMetrics(db, "followers", view),
    articleViews: repo.metricSumInMonth(db, "article_views", month, view),
    inquiries,
    agents: { total: agents.length, byStatus },
    content: { posted, failed, pendingApproval, drafts, byPlatform },
    pending: {
      ideas: ideas.filter((i) => i.approval_status === "pending").length,
      contentApproval: pendingApproval,
      productsAwaitingApproval: products.filter((p) => p.qa_status === "passed" && !p.owner_approved_at).length,
      inquiriesNeedOwner: inquiries.needsOwner,
    },
    automationEnabled: settings.automation_enabled === "true",
  };
}
