import { test } from "node:test";
import assert from "node:assert/strict";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { openDb, get, run } from "../../lib/database/db";
import * as repo from "../../lib/database/repo";
import type { LlmCall } from "../../lib/ai/llm";
import { qaLoop, mechanicalIssues, totalScore, applyEdits, CRITERIA } from "../../lib/ai/tasks/product-qa";
import { queueRun, executeRun, syncAgentConnection } from "../../lib/ai/runner";
import "../../lib/ai/tasks/index";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const msg = (text: string): BetaMessage =>
  ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text, citations: null }], usage: { input_tokens: 1000, output_tokens: 500 } }) as unknown as BetaMessage;

/** 章立て・プロンプト2個・架空の例・匿名化がそろった原稿（機械的な減点がない） */
function goodDoc(tag: string): string {
  const pad = "説明の文章です。".repeat(60);
  return [
    `# テンプレート ${tag}`,
    "## 1. このテンプレートでできること", pad,
    "## 2. こんなときに使う", pad,
    "## 3. 準備するもの", pad,
    "## 4. 手順", pad, "名前・社名は伏せて（匿名化して）入れます。",
    "## 5. コピーして使うプロンプト", "```\nプロンプト1〔会社名〕\n```", "```\nプロンプト2〔日付〕\n```",
    "## 6. 記入例（架空の例）", pad,
    "## 7. よくある失敗と直し方", pad,
    "## 8. 使う前のチェックリスト", "- [ ] 確認",
    "## 9. 情報の扱いの注意", pad,
  ].join("\n");
}
const full = Object.fromEntries(CRITERIA.map((c) => [c.key, c.max]));
const review = (scores: Record<string, number>, issues: { criterion: string; where: string; problem: string; fix: string }[] = []) => JSON.stringify({ scores, issues, summary: "所見" });

function fakeCall(reviews: string[], revisions: { old: string; new: string }[][]): { call: LlmCall; calls: string[] } {
  const calls: string[] = [];
  let r = 0, v = 0;
  const call: LlmCall = async (p) => {
    const sys = p.system ? String(p.system) : "";
    if (sys.includes("準備をします")) {
      calls.push("prep");
      return msg(JSON.stringify({ scenario: "架空の商談", confusions: [{ where: "手順3", problem: "迷った" }], prompts: [{ label: "①", filled: "埋めたプロンプト1" }, { label: "②", filled: "埋めたプロンプト2" }] }));
    }
    if (!sys) { calls.push("run"); return msg("Claude の実際の出力"); }
    if (sys.includes("品質検査の担当")) { calls.push("review"); return msg(reviews[r++]); }
    calls.push("revise");
    return msg(JSON.stringify({ edits: revisions[v++] ?? [] }));
  };
  return { call, calls };
}
const tag = (from: string, to: string) => [{ old: `# テンプレート ${from}`, new: `# テンプレート ${to}` }];

test("品質検査：試用→採点→改訂をくり返し、100点になったら止める", async () => {
  const issue = { criterion: "clarity", where: "手順3", problem: "迷う", fix: "1つの作業に分ける" };
  const { call, calls } = fakeCall([review({ ...full, clarity: 12 }, [issue]), review(full)], [tag("v1", "v2")]);
  const r = await qaLoop(call, { title: "議事録", body: goodDoc("v1"), product: "商品", components: ["議事録"] });
  assert.deepEqual(calls, ["prep", "run", "run", "review", "revise", "prep", "run", "run", "review"]);
  assert.deepEqual(r.rounds.map((x) => x.total), [92, 100]);
  assert.equal(r.best.total, 100);
  assert.ok(r.best.body.includes("v2"));
  assert.equal(r.usage.inputTokens, 9000);
});

test("品質検査：直して点が下がったら、前の版を残す。上がらなければ打ち切る", async () => {
  const issue = { criterion: "usable", where: "プロンプト1", problem: "結果が長い", fix: "字数を指定" };
  const { call } = fakeCall(
    [review({ ...full, usable: 20 }, [issue]), review({ ...full, usable: 10 }, [issue]), review({ ...full, usable: 15 }, [issue])],
    [tag("v1", "v2"), tag("v2", "v3")],
  );
  const r = await qaLoop(call, { title: "議事録", body: goodDoc("v1"), product: "商品", components: ["議事録"] }, 6);
  assert.deepEqual(r.rounds.map((x) => x.total), [95, 85, 90]); // 3回目が1回目を超えないので打ち切り
  assert.equal(r.best.total, 95);
  assert.ok(r.best.body.includes("v1"));
});

test("品質検査：機械的な確認（誇大表現・章・プロンプト・架空・匿名化）は AI が満点でも減点する", () => {
  const bad = "# x\n## 手順\n必ず成約できます。誰でも稼げる。\n" + "あ".repeat(3100);
  const m = mechanicalIssues(bad);
  const t = totalScore(JSON.parse(review(full)), m);
  assert.ok(t.total < 100);
  assert.ok(m.some((i) => i.problem.includes("必ず成約")));
  assert.ok(m.some((i) => i.problem.includes("プロンプト")));
  assert.ok(m.some((i) => i.problem.includes("架空")));
  assert.ok(m.some((i) => i.problem.includes("匿名化")));
  assert.deepEqual(mechanicalIssues(goodDoc("ok")), []);
});

test("品質検査：AI社員の仕事として記録し、全部の構成品が満点の観点だけ検査項目にチェック（販売ページは入れない）", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  const ins = await run(
    db,
    "INSERT INTO products (name, price_jpy, components, qa_checklist, data_kind) VALUES ('980円テスト', 980, ?, ?, 'actual')",
    [JSON.stringify([{ name: "議事録", status: "producing" }]), JSON.stringify((await import("../../lib/database/seed")).DEFAULT_QA_CHECKLIST)],
  );
  const pid = ins.lastId;
  await run(db, "INSERT INTO product_docs (product_id, component_index, title, body) VALUES (?, 0, '議事録', ?)", [pid, goodDoc("v1")]);
  const { call } = fakeCall([review({ ...full, solves: 10 }, [{ criterion: "solves", where: "全体", problem: "次の行動が弱い", fix: "追記" }]), review(full)], [tag("v1", "v2")]);
  const q = await queueRun(db, "product.qa", { productId: pid, index: 0, rounds: 4 });
  assert.ok(q.ok);
  const r = await executeRun(db, (q as { runId: number }).runId, call);
  assert.ok(r.ok, r.message);
  assert.match(r.message, /100点（95→100）/);
  const doc = await get<{ body: string; version: number; review_note: string }>(db, "SELECT body, version, review_note FROM product_docs WHERE product_id = ?", [pid]);
  assert.ok(doc!.body.includes("v2"));
  assert.equal(doc!.version, 2);
  assert.match(doc!.review_note, /100点／100/);
  const p = await repo.getProduct(db, pid);
  const ck = Object.fromEntries(repo.parseChecklist(p!.qa_checklist).map((i) => [i.key, i.done]));
  assert.deepEqual(ck, { accuracy: true, clarity: true, usable: true, solves: true, rights: true, claims: false });
  assert.equal(p!.qa_status, "in_progress");
  assert.equal(p!.production_status, "review");
  const runRow = await get<{ status: string; cost_jpy: number }>(db, "SELECT status, cost_jpy FROM agent_runs WHERE id = ?", [(q as { runId: number }).runId]);
  assert.equal(runRow!.status, "success");
  assert.ok(runRow!.cost_jpy > 0);
});

test("品質検査：書き換えは、原稿に1回だけ現れる所だけ当てる", () => {
  const r = applyEdits("AAA BBB AAA CCC", [{ old: "AAA", new: "x" }, { old: "BBB", new: "y" }, { old: "ZZZ", new: "z" }, { old: "CCC", new: "CCC" }]);
  assert.deepEqual(r, { body: "AAA y AAA CCC", applied: 1, skipped: 3 });
});

test("品質検査：途中で失敗しても、それまでの費用を AI社員の記録に残す", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  const ins = await run(db, "INSERT INTO products (name, components, data_kind) VALUES ('x', ?, 'actual')", [JSON.stringify([{ name: "議事録", status: "producing" }])]);
  await run(db, "INSERT INTO product_docs (product_id, component_index, title, body) VALUES (?, 0, '議事録', ?)", [ins.lastId, goodDoc("v1")]);
  const { call } = fakeCall(["これはJSONではない"], []);
  const q = await queueRun(db, "product.qa", { productId: ins.lastId, index: 0 });
  const r = await executeRun(db, (q as { runId: number }).runId, call);
  assert.equal(r.ok, false);
  const row = await get<{ status: string; cost_jpy: number; input_tokens: number }>(db, "SELECT status, cost_jpy, input_tokens FROM agent_runs WHERE id = ?", [(q as { runId: number }).runId]);
  assert.equal(row!.status, "error");
  assert.equal(row!.input_tokens, 4000); // 準備1回＋実行2回＋採点1回
  assert.ok(row!.cost_jpy > 0);
});
