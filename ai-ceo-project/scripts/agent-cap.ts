/**
 * AI社員の月間上限を変える（GitHub Actions：.github/workflows/ai_ceo_agent_cap.yml から代表者が実行）
 *   AGENT_ID … AI社員の番号（例：product）
 *   CAP_JPY  … 新しい月間上限（円）
 */
import { getDb } from "../lib/database/db";
import { setAgentCap } from "../lib/ops/agent-cap";

async function main() {
  const agentId = (process.env.AGENT_ID ?? "").trim();
  const cap = Number(process.env.CAP_JPY);
  const db = await getDb();
  const r = await setAgentCap(db, agentId, cap);
  console.log(`AI社員「${agentId}」の月間上限：${r.from}円 → ${r.to}円${r.resumed ? "（予算で止まっていたので、待機中に戻しました）" : ""}`);
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
