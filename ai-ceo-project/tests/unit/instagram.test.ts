import { test } from "node:test";
import assert from "node:assert/strict";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { openDb, get, run } from "../../lib/database/db";
import * as repo from "../../lib/database/repo";
import { igPublishCarousel, checkInstagram } from "../../lib/social/instagram";
import { publishDueInstagram, maybeRefreshIgToken } from "../../lib/automation/ig-publisher";
import { signImage, verifyImage } from "../../lib/social/image-sign";
import { queueRun, executeRun, syncAgentConnection } from "../../lib/ai/runner";
import type { LlmCall } from "../../lib/ai/llm";
import "../../lib/ai/tasks/index";

process.env.TURSO_AUTH_TOKEN = "t".repeat(40);
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
const at = (s: string) => new Date(s + "+09:00");

test("Instagram：カルーセルは 画像ごと→カルーセル→公開 の順に作る", async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push(`${init?.method ?? "GET"} ${u.pathname.replace("/v23.0", "")}${body.get("media_type") ? " " + body.get("media_type") : ""}`);
    if (u.pathname.endsWith("/media") && body.get("is_carousel_item")) return new Response(JSON.stringify({ id: `c${calls.length}` }));
    if (u.pathname.endsWith("/media")) return new Response(JSON.stringify({ id: "car" }));
    if (u.pathname.endsWith("/media_publish")) return new Response(JSON.stringify({ id: "post1" }));
    if (u.searchParams.get("fields") === "status_code") return new Response(JSON.stringify({ status_code: "FINISHED" }));
    if (u.searchParams.get("fields") === "permalink") return new Response(JSON.stringify({ permalink: "https://www.instagram.com/p/x/" }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const r = await igPublishCarousel({ token: "tok", userId: "u1", imageUrls: ["https://a/1.jpg", "https://a/2.jpg"], caption: "hi", doFetch: fake, wait: async () => {} });
  assert.deepEqual(r, { ok: true, value: { id: "post1", permalink: "https://www.instagram.com/p/x/" } });
  assert.deepEqual(calls.filter((c) => c.startsWith("POST")), ["POST /u1/media", "POST /u1/media", "POST /u1/media CAROUSEL", "POST /u1/media_publish"]);
  assert.match(checkInstagram("本文", [{ heading: "a", text: "" }])!, /2〜10枚/);
  assert.match(checkInstagram("【ひとこと】", [{ heading: "a", text: "" }, { heading: "b", text: "" }])!, /【 】/);
  assert.equal(checkInstagram("本文 #AI", [{ heading: "a", text: "" }, { heading: "b", text: "" }]), null);
});

async function setup(slides = [{ heading: "表紙", text: "" }, { heading: "中身", text: "説明" }], caption = "キャプション #AI") {
  const db = await openDb(":memory:");
  await run(db, "INSERT INTO settings (key, value) VALUES ('ig_autopost_enabled', 'true'), ('ig_access_token', 'tok'), ('ig_user_id', 'u1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const r = await run(
    db,
    "INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, post_time, extra, data_kind) VALUES ('ai-ceo-project', 'instagram', 'scheduled', 't', ?, '2026-11-25', '19:00', ?, 'actual')",
    [caption, JSON.stringify({ slides })],
  );
  return { db, id: r.lastId };
}

test("Instagram の予約投稿：予定時刻を過ぎた承認済みのものを、署名付きのJPEG画像で投稿する", async () => {
  const { db, id } = await setup();
  let got: { imageUrls: string[]; caption: string } | null = null;
  const publish = (async (o: { imageUrls: string[]; caption: string }) => {
    got = o;
    return { ok: true, value: { id: "p1", permalink: "https://www.instagram.com/p/1/" } };
  }) as never;
  assert.equal((await publishDueInstagram(db, at("2026-11-25T18:59:00"), publish)).status, "nothing_due");
  assert.equal((await publishDueInstagram(db, at("2026-11-25T19:00:00"), publish)).status, "posted");
  assert.equal(got!.imageUrls.length, 2);
  const u = new URL(got!.imageUrls[0]);
  assert.equal(u.searchParams.get("format"), "jpg");
  assert.ok(verifyImage(id, "slide", 1, Number(u.searchParams.get("exp")), u.searchParams.get("sig")!));
  const row = await get<{ status: string; url: string }>(db, "SELECT status, url FROM content_posts WHERE id = ?", [id]);
  assert.deepEqual(row, { status: "posted", url: "https://www.instagram.com/p/1/" });
  assert.equal((await publishDueInstagram(db, at("2026-11-25T20:00:00"), publish)).status, "limited"); // 3時間あける
});

test("Instagram の予約投稿：OFF・合鍵なし・【 】残り・一時的なエラー", async () => {
  const never = (async () => { throw new Error("呼ばれてはいけない"); }) as never;
  const a = await setup();
  await run(a.db, "UPDATE settings SET value = 'false' WHERE key = 'ig_autopost_enabled'");
  assert.equal((await publishDueInstagram(a.db, at("2026-11-26T09:00:00"), never)).status, "disabled");
  const b = await setup();
  await run(b.db, "DELETE FROM settings WHERE key = 'ig_access_token'");
  const saved = process.env.IG_ACCESS_TOKEN;
  delete process.env.IG_ACCESS_TOKEN;
  assert.equal((await publishDueInstagram(b.db, at("2026-11-26T09:00:00"), never)).status, "no_credentials");
  process.env.IG_ACCESS_TOKEN = saved;
  const c = await setup([{ heading: "【ひとこと】", text: "" }, { heading: "b", text: "" }]);
  assert.equal((await publishDueInstagram(c.db, at("2026-11-26T09:00:00"), never)).status, "failed");
  const d = await setup();
  await publishDueInstagram(d.db, at("2026-11-26T09:00:00"), (async () => ({ ok: false, error: "制限", retryable: true })) as never);
  assert.equal((await get<{ status: string }>(d.db, "SELECT status FROM content_posts WHERE id = ?", [d.id]))?.status, "scheduled");
});

test("Instagram の合鍵：7日ごとに延長し、失敗したら6時間は再挑戦しない", async () => {
  const { db } = await setup();
  let n = 0;
  const ok = (async () => { n++; return { ok: true, value: { access_token: "new", expires_in: 5184000 } }; }) as never;
  const ng = (async () => { n++; return { ok: false, error: "x", retryable: true }; }) as never;
  const t0 = Date.parse("2026-12-01T00:00:00Z");
  assert.equal(await maybeRefreshIgToken(db, t0, ok), "refreshed");
  assert.equal((await repo.getSettings(db)).ig_access_token, "new");
  assert.equal(await maybeRefreshIgToken(db, t0 + 86_400_000, ok), "not_needed");
  assert.equal(await maybeRefreshIgToken(db, t0 + 8 * 86_400_000, ng), "failed");
  assert.equal(await maybeRefreshIgToken(db, t0 + 8 * 86_400_000 + 3_600_000, ok), "not_needed"); // 6時間は待つ
  assert.equal(n, 2);
});

test("署名付き画像リンク：記事・画像・番号・期限が違えば通さない", () => {
  const q = new URLSearchParams(signImage(5, "slide", 1, 600, 1_000_000_000)!);
  const exp = Number(q.get("exp"));
  const sig = q.get("sig")!;
  assert.equal(verifyImage(5, "slide", 1, exp, sig, 1_000_000_000), true);
  assert.equal(verifyImage(5, "slide", 2, exp, sig, 1_000_000_000), false);
  assert.equal(verifyImage(6, "slide", 1, exp, sig, 1_000_000_000), false);
  assert.equal(verifyImage(5, "slide", 1, exp, sig, (exp + 1) * 1000), false);
});

test("競合研究：型の手本帳を保存し、検索結果で確認できない発信者は外す", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  const real = "https://example.com/creator";
  let k = 0;
  const call: LlmCall = async () => {
    k++;
    if (k === 1)
      return { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "pause_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } }, content: [{ type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: real, title: "t", encrypted_content: "x", page_age: null }] }] } as unknown as BetaMessage;
    return {
      id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "tool_use", id: "t", name: "save_playbook", input: {
        summary: "s", cadence: "毎日", differentiation: "実データ", avoid: ["誇大な収益報告"], hooks: ["〜した結果、◯◯だった"],
        patterns: [{ name: "失敗の公開", platform: "x", structure: "結論→数字→学び", why: "信頼" }],
        accounts: [{ name: "A", platform: "x", strengths: "毎日の記録", source_url: real }, { name: "B", platform: "x", strengths: "?", source_url: "https://made-up.example" }],
      } }],
    } as unknown as BetaMessage;
  };
  const q = await queueRun(db, "research.competitors", {});
  assert.ok(q.ok);
  const r = await executeRun(db, (q as { runId: number }).runId, call);
  assert.ok(r.ok, r.message);
  const pb = await repo.latestPlaybook(db);
  const c = JSON.parse(pb!.content);
  assert.deepEqual(c.accounts.map((a: { name: string }) => a.name), ["A"]);
  assert.equal(c.dropped_accounts, 1);
});
