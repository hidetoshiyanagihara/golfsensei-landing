import { test } from "node:test";
import assert from "node:assert/strict";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { openDb, get, run } from "../../lib/database/db";
import * as repo from "../../lib/database/repo";
import { oauthSignature, xWeightedLength, makeXPoster, oauthHeader, type XPoster } from "../../lib/social/x";
import { checkXText, jstStamp, publishDueX } from "../../lib/automation/publisher";
import { queueRun, executeRun, syncAgentConnection } from "../../lib/ai/runner";
import type { LlmCall } from "../../lib/ai/llm";
import "../../lib/ai/tasks/index";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

test("OAuth 1.0a の署名：X（旧Twitter）公式ドキュメントの計算例と一致する", () => {
  const sig = oauthSignature(
    "POST",
    "https://api.twitter.com/1.1/statuses/update.json",
    {
      include_entities: "true",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
    },
    "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  );
  assert.equal(sig, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  const h = oauthHeader("POST", "https://api.x.com/2/tweets", { apiKey: "k", apiSecret: "s", accessToken: "t", accessTokenSecret: "u" }, "n", 1);
  assert.match(h, /^OAuth oauth_consumer_key="k", oauth_nonce="n", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1", oauth_token="t", oauth_version="1.0"$/);
});

test("X の文字数（日本語は2、英数は1）と投稿前の確認", () => {
  assert.equal(xWeightedLength("abc"), 3);
  assert.equal(xWeightedLength("あいう"), 6);
  assert.equal(checkXText("あ".repeat(140)), null);
  assert.match(checkXText("あ".repeat(141))!, /長すぎ/);
  assert.equal(checkXText("あ".repeat(68) + "\r\n\r\n" + "い".repeat(70)), null); // 改行 CR+LF は1文字として数える
  assert.match(checkXText("【ここにひとこと】今日の記録")!, /【 】/);
  assert.match(checkXText("詳しくは https://note.com/x")!, /URL/);
  assert.match(checkXText("note.com で読めます")!, /URL/);
  assert.match(checkXText("  ")!, /空/);
});

test("X への送信：成功・残高不足・回数制限を区別する", async () => {
  const cred = { apiKey: "k", apiSecret: "s", accessToken: "t", accessTokenSecret: "u" };
  let auth = "";
  const ok = makeXPoster(cred, (async (_u: string, init: RequestInit) => {
    auth = String((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ data: { id: "123", text: "x" } }), { status: 201 });
  }) as unknown as typeof fetch);
  assert.deepEqual(await ok("こんにちは"), { ok: true, id: "123" });
  assert.match(auth, /^OAuth /);
  const r402 = await makeXPoster(cred, (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch)("x");
  assert.equal(r402.ok, false);
  if (!r402.ok) assert.equal(r402.retryable, false);
  const r429 = await makeXPoster(cred, (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch)("x");
  if (!r429.ok) assert.equal(r429.retryable, true);
});

async function setupPost(body: string, date = "2026-11-25", time = "08:00") {
  const db = await openDb(":memory:");
  await run(db, "INSERT INTO settings (key, value) VALUES ('x_autopost_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  const r = await run(
    db,
    "INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, post_time, data_kind) VALUES ('ai-ceo-project', 'x', 'scheduled', 't', ?, ?, ?, 'actual')",
    [body, date, time],
  );
  return { db, id: r.lastId };
}
const at = (s: string) => new Date(s + "+09:00"); // 日本時間

test("予約投稿：予定時刻を過ぎた承認済みの X 投稿だけを、1件ずつ投稿する", async () => {
  const { db, id } = await setupPost("今日の記録です");
  const sent: string[] = [];
  const poster: XPoster = async (t) => {
    sent.push(t);
    return { ok: true, id: "999" };
  };
  assert.equal((await publishDueX(db, poster, at("2026-11-25T07:59:00"))).status, "nothing_due"); // まだ早い
  assert.equal((await publishDueX(db, poster, at("2026-11-25T08:00:00"))).status, "posted");
  const row = await get<{ status: string; url: string; posted_at: string }>(db, "SELECT status, url, posted_at FROM content_posts WHERE id = ?", [id]);
  assert.equal(row?.status, "posted");
  assert.equal(row?.url, "https://x.com/i/web/status/999");
  assert.equal(row?.posted_at, "2026-11-25 08:00");
  assert.equal((await publishDueX(db, poster, at("2026-11-25T08:15:00"))).status, "limited"); // 30分以内は投稿しない
  assert.equal((await publishDueX(db, poster, at("2026-11-25T09:00:00"))).status, "nothing_due"); // 二重に投稿しない
  assert.deepEqual(sent, ["今日の記録です"]);
  assert.match((await repo.getSettings(db)).scheduler_last_run, /^2026-11-25 09:00 nothing_due/);
});

test("予約投稿：OFF・合鍵なし・【 】残り・30分以内・1日の上限では投稿しない", async () => {
  const never: XPoster = async () => {
    throw new Error("呼ばれてはいけない");
  };
  const a = await setupPost("本文");
  await run(a.db, "UPDATE settings SET value = 'false' WHERE key = 'x_autopost_enabled'");
  assert.equal((await publishDueX(a.db, never, at("2026-11-26T09:00:00"))).status, "disabled");

  const b = await setupPost("本文");
  assert.equal((await publishDueX(b.db, null, at("2026-11-26T09:00:00"))).status, "no_credentials");

  const c = await setupPost("【ここにひとこと】本文");
  assert.equal((await publishDueX(c.db, never, at("2026-11-26T09:00:00"))).status, "failed");
  assert.match((await get<{ error: string }>(c.db, "SELECT error FROM content_posts WHERE id = ?", [c.id]))!.error, /【 】/);

  const d = await setupPost("1本目", "2026-11-26", "08:00");
  await run(d.db, "INSERT INTO content_posts (business_id, platform, status, body, scheduled_at, post_time, data_kind) VALUES ('ai-ceo-project', 'x', 'scheduled', '2本目', '2026-11-26', '08:10', 'actual')");
  const ok: XPoster = async () => ({ ok: true, id: "1" });
  assert.equal((await publishDueX(d.db, ok, at("2026-11-26T08:15:00"))).status, "posted");
  assert.equal((await publishDueX(d.db, ok, at("2026-11-26T08:30:00"))).status, "limited"); // 30分あける
  assert.equal((await publishDueX(d.db, ok, at("2026-11-26T08:45:00"))).status, "posted");
  await run(d.db, "INSERT INTO settings (key, value) VALUES ('x_daily_limit', '2') ON CONFLICT(key) DO UPDATE SET value = '2'");
  await run(d.db, "INSERT INTO content_posts (business_id, platform, status, body, scheduled_at, post_time, data_kind) VALUES ('ai-ceo-project', 'x', 'scheduled', '3本目', '2026-11-26', '09:00', 'actual')");
  assert.equal((await publishDueX(d.db, ok, at("2026-11-26T10:00:00"))).status, "limited"); // 1日の上限
});

test("予約投稿：一時的なエラーは予約に戻して次回やり直し、それ以外は失敗にする", async () => {
  const a = await setupPost("本文");
  await publishDueX(a.db, async () => ({ ok: false, error: "X の投稿回数の制限に達しました（429）", retryable: true }), at("2026-11-26T09:00:00"));
  assert.equal((await get<{ status: string }>(a.db, "SELECT status FROM content_posts WHERE id = ?", [a.id]))?.status, "scheduled");
  const b = await setupPost("本文");
  await publishDueX(b.db, async () => ({ ok: false, error: "X の合鍵が無効です（401）", retryable: false }), at("2026-11-26T09:00:00"));
  assert.equal((await get<{ status: string }>(b.db, "SELECT status FROM content_posts WHERE id = ?", [b.id]))?.status, "failed");
});

test("マーケティングAI：X と note の下書きを承認待ちで登録し、問題のある下書きに目印を付ける", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  const out = {
    posts: [
      { platform: "x", title: "X①", body: "AI社員を7人つくった。売上はまだ0円。", day_offset: 1, time: "08:00", fact_basis: "AI社員7名・売上0円" },
      { platform: "x", title: "X②", body: "【ここにひとこと：始めた理由】", day_offset: 1, time: "12:00", fact_basis: "なし" },
      { platform: "x", title: "X③", body: "月商77万円を達成！ https://note.com/x", day_offset: 2, time: "08:00", fact_basis: "なし" },
      { platform: "note", title: "note①", body: "## はじめに\n本文", day_offset: 3, time: "20:00", fact_basis: "開始日" },
    ],
  };
  const call: LlmCall = async (p) => {
    assert.equal(p.output_config?.format?.type, "json_schema");
    return { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: JSON.stringify(out), citations: null }], usage: { input_tokens: 100, output_tokens: 100 } } as unknown as BetaMessage;
  };
  const q = await queueRun(db, "marketing.drafts", {});
  assert.ok(q.ok);
  const r = await executeRun(db, (q as { runId: number }).runId, call);
  assert.ok(r.ok, r.message);
  const rows = await repo.listContent(db, repo.ACTUAL_ONLY, { status: "pending_approval" });
  const ai = rows.filter((x) => x.title.startsWith("X") || x.title.startsWith("note①"));
  assert.equal(ai.length, 4);
  const x3 = ai.find((x) => x.title === "X③")!;
  assert.match(x3.review_note!, /77万円/); // 元データにない数字
  assert.match(x3.review_note!, /URL/);
  assert.match(ai.find((x) => x.title === "X②")!.review_note!, /【 】/);
  assert.equal(ai.find((x) => x.title === "note①")!.post_time, "20:00");
  assert.equal(jstStamp(new Date("2026-11-25T23:30:00Z")), "2026-11-26 08:30");
});

test("合鍵のアカウント確認（投稿はしない）", async () => {
  const { whoAmI } = await import("../../lib/social/x");
  const cred = { apiKey: "k", apiSecret: "s", accessToken: "t", accessTokenSecret: "u" };
  let method = "";
  const r = await whoAmI(cred, (async (_u: string, init: RequestInit) => {
    method = init.method ?? "GET";
    return new Response(JSON.stringify({ data: { id: "1", name: "HIDE", username: "ai_ceo_project" } }));
  }) as unknown as typeof fetch);
  assert.deepEqual(r, { ok: true, username: "ai_ceo_project", name: "HIDE" });
  assert.equal(method, "GET");
  const bad = await whoAmI(cred, (async () => new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch);
  assert.equal(bad.ok, false);
});
