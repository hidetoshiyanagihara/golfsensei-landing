import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBudget, checkRun, type RunCheckInput } from "../../lib/automation/budget";
import { estimateCostUsd, usdToJpy } from "../../lib/ai/models";

const base: RunCheckInput = {
  automationEnabled: true,
  agentStatus: "idle",
  estimateJpy: 50,
  total: { capJpy: 30000, usedJpy: 0 },
  ai: { capJpy: 10000, usedJpy: 0 },
  agent: { capJpy: 3000, usedJpy: 0 },
};

test("予算の段階判定", () => {
  assert.equal(evaluateBudget(30000, 1000, 0.8).level, "ok");
  assert.equal(evaluateBudget(30000, 24000, 0.8).level, "warn");
  assert.equal(evaluateBudget(30000, 30000, 0.8).level, "stop");
  assert.equal(evaluateBudget(0, 0, 0.8).level, "stop");
  assert.equal(evaluateBudget(30000, 1000, 0.8).remainingJpy, 29000);
});

test("自動実行OFF・未接続・停止中なら実行しない", () => {
  assert.equal(checkRun({ ...base, automationEnabled: false }).allowed, false);
  assert.equal(checkRun({ ...base, agentStatus: "not_connected" }).allowed, false);
  assert.equal(checkRun({ ...base, agentStatus: "paused" }).allowed, false);
  assert.equal(checkRun({ ...base, estimateJpy: NaN }).allowed, false);
  assert.equal(checkRun(base).allowed, true);
});

test("どれか1つの上限を超えるなら停止し、AI社員を止める", () => {
  for (const key of ["total", "ai", "agent"] as const) {
    const r = checkRun({ ...base, [key]: { capJpy: 100, usedJpy: 80 } });
    assert.equal(r.allowed, false, key);
    if (!r.allowed) assert.equal(r.pauseAgent, true);
  }
  assert.equal(checkRun({ ...base, agent: { capJpy: 100, usedJpy: 50 } }).allowed, true); // ちょうど上限は可
});

test("API費用の推計（切り上げ）", () => {
  const usd = estimateCostUsd("claude-opus-5-5", 10_000, 2_000);
  assert.equal(usd, (10_000 * 4 + 2_000 * 20) / 1e6);
  assert.equal(usdToJpy(0.0801, 155), 13);
  assert.throws(() => estimateCostUsd("unknown-model", 1, 1));
});
