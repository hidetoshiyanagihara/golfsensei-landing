import { test } from "node:test";
import assert from "node:assert/strict";
import { canPassQa, canStartSelling, canTransitionContent, totalIdeaScore } from "../../lib/rules";

const checklist = (done: boolean) => [
  { key: "a", label: "A", done: true },
  { key: "b", label: "B", done },
];

test("品質検査：全項目が完了し、検査中以降でないと合格にできない", () => {
  assert.equal(canPassQa({ production_status: "planning", qa_checklist: checklist(true) }).ok, false);
  assert.equal(canPassQa({ production_status: "review", qa_checklist: checklist(false) }).ok, false);
  assert.equal(canPassQa({ production_status: "review", qa_checklist: checklist(true) }).ok, true);
});

test("販売開始：品質検査合格＋代表者承認が必要", () => {
  const p = { production_status: "done", qa_checklist: checklist(true) };
  assert.equal(canStartSelling({ ...p, qa_status: "in_progress", owner_approved_at: "x" }).ok, false);
  assert.equal(canStartSelling({ ...p, qa_status: "passed", owner_approved_at: null }).ok, false);
  assert.equal(canStartSelling({ ...p, qa_status: "passed", owner_approved_at: "2026-11-21" }).ok, true);
});

test("投稿：承認を飛ばして予約できず、投稿済みは手で付けられない", () => {
  assert.equal(canTransitionContent("draft", "scheduled"), false);
  assert.equal(canTransitionContent("draft", "pending_approval"), true);
  assert.equal(canTransitionContent("pending_approval", "approved"), true);
  assert.equal(canTransitionContent("approved", "scheduled"), true);
  assert.equal(canTransitionContent("approved", "posted"), false);
  assert.equal(canTransitionContent("posted", "draft"), false);
});

test("事業評価：未評価があれば点数を出さない", () => {
  assert.equal(totalIdeaScore([80, null, 60]), null);
  assert.equal(totalIdeaScore([80, 70, 60]), 70);
  assert.throws(() => totalIdeaScore([120, 50]));
});
