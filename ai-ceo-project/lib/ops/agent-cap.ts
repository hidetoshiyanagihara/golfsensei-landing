import { batch, get, type DB } from "../database/db";
import * as repo from "../database/repo";
import { monthUsage } from "../ai/runner";

/**
 * AI社員ごとの月間上限を変える（代表者の指示で実行。GitHub Actions：ai_ceo_agent_cap.yml）。
 * - AI API の月間上限を超える額にはできない
 * - 予算の上限で「停止中」になっていた AI社員は、上限を上げたら「待機中」に戻す（代表者が自分で停止したものはそのまま）
 */
export async function setAgentCap(db: DB, agentId: string, capJpy: number): Promise<{ from: number; to: number; resumed: boolean }> {
  if (!Number.isInteger(capJpy) || capJpy < 0) throw new Error("上限は0以上の整数（円）で入れてください");
  const agent = await repo.getAgent(db, agentId);
  if (!agent) throw new Error(`AI社員「${agentId}」が見つかりません`);
  const settings = await repo.getSettings(db);
  const aiCap = repo.num(settings, "ai_api_monthly_cap_jpy", 10000);
  if (capJpy > aiCap) throw new Error(`AI API の月間上限（${aiCap}円）より大きくはできません`);
  const lastBlock = await get<{ action: string }>(
    db,
    "SELECT action FROM audit_log WHERE target = ? AND action IN ('agent.blocked','agent.paused_budget','agent.cap_changed') ORDER BY id DESC LIMIT 1",
    [agentId],
  );
  const used = await monthUsage(db, agentId);
  const byBudget = lastBlock?.action === "agent.blocked" || lastBlock?.action === "agent.paused_budget";
  const resume = agent.status === "paused" && byBudget && used.agent < capJpy && used.ai < aiCap;
  await batch(db, [
    { sql: "UPDATE agents SET monthly_cap_jpy = ? WHERE id = ?", args: [capJpy, agentId] },
    ...(resume ? [{ sql: "UPDATE agents SET status = 'idle' WHERE id = ? AND status = 'paused'", args: [agentId] }] : []),
    repo.auditStmt("owner", "agent.cap_changed", agentId, { from: agent.monthly_cap_jpy, to: capJpy, resumed: resume }),
  ]);
  return { from: agent.monthly_cap_jpy, to: capJpy, resumed: resume };
}
