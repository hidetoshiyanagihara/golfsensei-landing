import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, get, run } from "../../lib/database/db";
import { syncAgentConnection } from "../../lib/ai/runner";
import { setAgentCap } from "../../lib/ops/agent-cap";
import * as repo from "../../lib/database/repo";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

test("AI社員の上限：上げると記録に残り、予算で止まっていたら待機中に戻す。AI API の上限は超えられない", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  await run(db, "UPDATE agents SET status = 'paused', monthly_cap_jpy = 3000 WHERE id = 'product'");
  await run(db, "INSERT INTO agent_runs (agent_id, task, params, started_at, status, trigger, summary, cost_jpy) VALUES ('product', 'product.qa', '{}', datetime('now'), 'success', 'manual', 'x', 2900)");
  await db.execute({ sql: "INSERT INTO audit_log (actor, action, target, detail) VALUES ('system', 'agent.blocked', 'product', '')", args: [] });
  await assert.rejects(setAgentCap(db, "product", 20000), /AI API の月間上限/);
  await assert.rejects(setAgentCap(db, "nobody", 1000), /見つかりません/);
  const r = await setAgentCap(db, "product", 5000);
  assert.deepEqual(r, { from: 3000, to: 5000, resumed: true });
  assert.equal((await repo.getAgent(db, "product"))!.status, "idle");
  const log = await get<{ detail: string }>(db, "SELECT detail FROM audit_log WHERE action = 'agent.cap_changed'");
  assert.match(log!.detail, /"to":5000/);
});

test("AI社員の上限：使った額より低い上限では、止まったまま", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  await run(db, "UPDATE agents SET status = 'paused', monthly_cap_jpy = 3000 WHERE id = 'product'");
  await run(db, "INSERT INTO agent_runs (agent_id, task, params, started_at, status, trigger, summary, cost_jpy) VALUES ('product', 'product.qa', '{}', datetime('now'), 'success', 'manual', 'x', 3500)");
  await db.execute({ sql: "INSERT INTO audit_log (actor, action, target, detail) VALUES ('system', 'agent.paused_budget', 'product', '')", args: [] });
  const r = await setAgentCap(db, "product", 3200);
  assert.equal(r.resumed, false);
  assert.equal((await repo.getAgent(db, "product"))!.status, "paused");
});
