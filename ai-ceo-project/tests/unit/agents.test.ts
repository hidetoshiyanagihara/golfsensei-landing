import { test } from "node:test";
import assert from "node:assert/strict";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { openDb, get, all, run } from "../../lib/database/db";
import * as repo from "../../lib/database/repo";
import { queueRun, executeRun, syncAgentConnection } from "../../lib/ai/runner";
import { findUnsupportedNumbers } from "../../lib/ai/tasks/ceo-meeting";
import { seenUrls, verifySources } from "../../lib/ai/tasks/market-research";
import { signDispatch, verifyDispatch } from "../../lib/ai/dispatch";
import type { LlmCall, LlmParams } from "../../lib/ai/llm";
import "../../lib/ai/tasks/index";

process.env.ANTHROPIC_API_KEY = "test-key-not-used"; // 偽物の呼び出し口を使うので、実際には送られない
process.env.SESSION_SECRET = "s".repeat(40);

function msg(partial: Partial<BetaMessage> & { content: unknown[] }): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null },
    ...partial,
  } as unknown as BetaMessage;
}

async function setup() {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  return db;
}

const ceoOutput = {
  headline: "販売できる商品がまだない。最優先は商品1つの完成。",
  situation: ["売上は0円（実績）。"],
  revenue_analysis: ["売上 ¥0、営業利益 ¥0。", "推測：月商¥99,999も可能"],
  market: ["未調査"],
  problems: ["販売中の商品がない"],
  improvements: ["テンプレートを1つ完成させる"],
  next_businesses: ["中小企業向け AI営業自動化スターターキット"],
  actions: [
    { title: "AIメール作成テンプレートの下書きを作る", owner: "owner", detail: "代表者が手で進める", requires_approval: false },
    { title: "note の販売ページの構成を決める", owner: "sales", detail: "販売戦略AIは実装待ち", requires_approval: true },
  ],
  uncertainties: ["市場の需要は未調査"],
};

test("AI CEO：経営会議をAIで作り、レポート・タスク・費用（推計）を記録する", async () => {
  const db = await setup();
  const seen: LlmParams[] = [];
  const call: LlmCall = async (p) => {
    seen.push(p);
    return msg({ content: [{ type: "text", text: JSON.stringify(ceoOutput), citations: null }] });
  };
  const q = await queueRun(db, "ceo.meeting", {});
  assert.ok(q.ok);
  const r = await executeRun(db, (q as { runId: number }).runId, call);
  assert.ok(r.ok, r.message);
  // 送った内容：実データの集計だけ。モデルと構造化出力の指定
  assert.equal(seen[0].model, "claude-opus-5-5");
  assert.equal(seen[0].output_config?.format?.type, "json_schema");
  const report = await get<{ generated_by: string; content: string }>(db, "SELECT generated_by, content FROM reports ORDER BY id DESC LIMIT 1");
  assert.equal(report?.generated_by, "ai");
  const content = JSON.parse(report!.content);
  assert.ok(content.warnings.some((w: string) => w.includes("99,999")), "データにない数字に目印が付く");
  const tasks = await repo.openTasks(db);
  assert.ok(tasks.some((t) => t.title === "note の販売ページの構成を決める" && t.requires_approval === 1));
  const runRow = await get<{ status: string; cost_jpy: number; input_tokens: number }>(db, "SELECT status, cost_jpy, input_tokens FROM agent_runs WHERE id = ?", [(q as { runId: number }).runId]);
  assert.equal(runRow?.status, "success");
  // 1000入力×$4 + 500出力×$20 = $0.014 → 155円/ドル → 3円（切り上げ）
  assert.equal(runRow?.cost_jpy, 3);
  assert.equal((await repo.getAgent(db, "ceo"))?.status, "idle");
  // 同じ仕事を2回実行しない
  const again = await executeRun(db, (q as { runId: number }).runId, call);
  assert.equal(again.ok, false);
  assert.equal(seen.length, 1);
});

test("予算：上限を超える見積もりなら実行せず、AI社員を止める", async () => {
  const db = await setup();
  await run(db, "UPDATE agents SET monthly_cap_jpy = 1 WHERE id = 'ceo'");
  const q = await queueRun(db, "ceo.meeting", {});
  assert.equal(q.ok, false);
  assert.equal((await repo.getAgent(db, "ceo"))?.status, "paused");
  const rows = await all<{ status: string }>(db, "SELECT status FROM agent_runs");
  assert.deepEqual(rows.map((r) => r.status), ["blocked_budget"]);
  // 止まったAI社員には頼めない
  await run(db, "UPDATE agents SET monthly_cap_jpy = 3000 WHERE id = 'ceo'");
  const q2 = await queueRun(db, "ceo.meeting", {});
  assert.equal(q2.ok, false);
});

test("実行中の仕事があるときは、同じAI社員に重ねて頼めない（予算の二重取り防止）", async () => {
  const db = await setup();
  assert.ok((await queueRun(db, "ceo.meeting", {})).ok);
  const q2 = await queueRun(db, "ceo.meeting", {});
  assert.equal(q2.ok, false);
});

test("APIキーがなければ未接続のまま、AIの仕事は受け付けない", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, false);
  assert.equal((await repo.getAgent(db, "ceo"))?.status, "not_connected");
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal((await queueRun(db, "ceo.meeting", {})).ok, false);
    // AIを使わない動作確認は動く
    const q = await queueRun(db, "system.ping", { seconds: 0 });
    assert.ok(q.ok);
    assert.ok((await executeRun(db, (q as { runId: number }).runId)).ok);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("失敗したら「エラー」と理由を記録する（秘密情報は出さない）", async () => {
  const db = await setup();
  const q = await queueRun(db, "ceo.meeting", {});
  const r = await executeRun(db, (q as { runId: number }).runId, async () => {
    throw new Error("ネットワークに接続できません");
  });
  assert.equal(r.ok, false);
  const row = await get<{ status: string; error: string }>(db, "SELECT status, error FROM agent_runs");
  assert.equal(row?.status, "error");
  assert.match(row!.error, /ネットワーク/);
  assert.equal((await repo.getAgent(db, "ceo"))?.status, "error");
});

test("市場調査AI：検索→一時停止→保存。検索結果にないURLは情報源から外す", async () => {
  const db = await setup();
  const real = "https://example.com/market-report";
  let n = 0;
  const call: LlmCall = async (p) => {
    n++;
    if (n === 1) {
      assert.ok(p.tools?.some((t) => "type" in t && t.type === "web_search_20260209"));
      return msg({
        stop_reason: "pause_turn",
        usage: { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } } as never,
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "AI 営業 テンプレート" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: real, title: "市場レポート", encrypted_content: "x", page_age: null }] },
        ],
      });
    }
    // 一時停止した続きは、同じ会話に前回の応答を足して送られている
    assert.equal(p.messages.length, 2);
    return msg({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "save_research",
          input: {
            summary: "需要はあるが競合も多い",
            ideas: [
              {
                name: "士業向けAI議事録テンプレート",
                target: "税理士事務所",
                problem: "面談記録に時間がかかる",
                competitors: "不明（情報源なし）",
                price_hypothesis: "3,980円",
                revenue_model: "note 有料記事",
                dev_cost_note: "代表者の作業時間のみ",
                expected_profit_note: "不明（情報源なし）",
                risks: "需要が小さい可能性",
                scores: { demand: 60, competition: 50, price: 55, profit: 40, difficulty: 70, acquisition: 45, recurrence: 30 },
                score_rationale: "推測を含む",
                sources: [
                  { title: "市場レポート", url: real, kind: "fact" },
                  { title: "存在しないページ", url: "https://made-up.example/none", kind: "fact" },
                ],
              },
            ],
          },
        },
      ],
    });
  };
  const q = await queueRun(db, "research.ideas", { theme: "士業向けのAIテンプレート" });
  assert.ok(q.ok);
  const r = await executeRun(db, (q as { runId: number }).runId, call);
  assert.ok(r.ok, r.message);
  const ideas = (await repo.listIdeas(db, repo.ACTUAL_ONLY)).filter((i) => i.origin === "ai");
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].approval_status, "pending");
  assert.equal(ideas[0].total_score, 50);
  const sources = JSON.parse(ideas[0].sources);
  assert.deepEqual(sources.map((s: { url: string }) => s.url), [real]);
  assert.match(ideas[0].evaluation_note, /除外/);
  const row = await get<{ web_searches: number; input_tokens: number }>(db, "SELECT web_searches, input_tokens FROM agent_runs");
  assert.equal(row?.web_searches, 2);
  assert.equal(row?.input_tokens, 3000); // 2回の呼び出しの合計
});

test("URLの確認と、入力にない数字の検出", () => {
  // 文章に書かれただけのURLは数えず、引用（citations）に付いたURLだけを数える
  const seen = seenUrls([
    msg({ content: [{ type: "text", text: "参考 https://made-up.example/y 。", citations: [{ type: "web_search_result_location", url: "https://a.example/x", title: "t", cited_text: "c", encrypted_index: "e" }] }] }),
  ]);
  assert.ok(seen.has("https://a.example/x"));
  assert.ok(!seen.has("https://made-up.example/y"));
  const v = verifySources(
    { summary: "", ideas: [{ sources: [{ title: "a", url: "https://a.example/x", kind: "fact" }, { title: "b", url: "https://b.example", kind: "fact" }] } as never] },
    seen,
  );
  assert.equal(v.dropped, 1);
  assert.deepEqual(findUnsupportedNumbers(["売上は¥4,980", "月商30万円", "3件"], "price 4980"), ["30万円"]);
});

test("裏側の実行の依頼は、署名が正しく新しいものだけ受け付ける", async () => {
  const d = await signDispatch(7, 1_000_000);
  assert.equal(await verifyDispatch(d, 1_000_000), 7);
  assert.equal(await verifyDispatch({ ...d, runId: 8 }, 1_000_000), null); // 改ざん
  assert.equal(await verifyDispatch(d, 1_000_000 + 6 * 60 * 1000), null); // 古い
  assert.equal(await verifyDispatch({ runId: 7 }, 1_000_000), null);
  assert.equal(await verifyDispatch(d, 1_000_000, "x".repeat(40)), null); // 別の鍵
});

test("商品開発AI：構成品の下書きを非公開のデータベースに保存し、作り直すと版が上がる", async () => {
  const db = await setup();
  const [p] = await repo.listProducts(db, repo.ACTUAL_ONLY);
  const body = "## このテンプレートでできること\n" + "営業の準備を短くする。".repeat(80) + "\nこれで必ず成約します。";
  const call: LlmCall = async (params) => {
    assert.match(String(params.system), /架空の例/);
    return msg({ content: [{ type: "text", text: body, citations: null }] });
  };
  for (let v = 1; v <= 2; v++) {
    const q = await queueRun(db, "product.component", { productId: p.id, index: 0 });
    assert.ok(q.ok);
    const r = await executeRun(db, (q as { runId: number }).runId, call);
    assert.ok(r.ok, r.message);
  }
  const docs = await repo.listProductDocs(db, p.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].version, 2);
  assert.equal(docs[0].status, "draft");
  assert.match(docs[0].review_note!, /約束/); // 「必ず」に目印
  const after = await repo.getProduct(db, p.id);
  assert.equal(after?.production_status, "producing");
  assert.equal(JSON.parse(after!.components)[0].status, "producing");
});
