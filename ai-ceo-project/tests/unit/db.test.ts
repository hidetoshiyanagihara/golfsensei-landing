import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, migrate, run, get } from "../../lib/database/db";
import { seedBase } from "../../lib/database/seed";
import * as repo from "../../lib/database/repo";
import { buildOverview } from "../../lib/analytics/overview";
import { buildMeetingReport, saveMeeting } from "../../lib/analytics/meeting";
import { importAutopostDir, importAutopostFromGitHub, parsePostFile } from "../../lib/importers/autopost";
import { LAUNCH_DRAFTS, PROFILES } from "../../lib/marketing/launch-kit";
import { createClient } from "@libsql/client";

const now = new Date("2026-11-21T03:00:00Z");
const mem = () => openDb(":memory:");

test("初期データ：AI社員7名・最初の商品（販売前・note）・新アカウントの下書き・実績0円", async () => {
  const db = await mem();
  const agents = await repo.listAgents(db);
  assert.equal(agents.length, 7);
  assert.ok(agents.every((a) => a.status === "not_connected"));
  const [p] = await repo.listProducts(db, repo.ACTUAL_ONLY);
  assert.equal(p.price_jpy, 4980);
  assert.equal(p.sales_status, "not_for_sale");
  assert.equal(p.sales_channel, "note（有料記事）");
  assert.equal((await repo.getSettings(db)).automation_enabled, "false");
  const drafts = await repo.listContent(db, repo.ACTUAL_ONLY, { business: "ai-ceo-project" });
  assert.equal(drafts.length, LAUNCH_DRAFTS.length);
  assert.ok(drafts.every((d) => d.status === "draft"));
  const o = await buildOverview(db, repo.ACTUAL_ONLY, now);
  assert.equal(o.pnl.netSales, 0);
  assert.equal(o.budget.capJpy, 30000);
  // 2回目の初期化でも重複しない
  await seedBase(db);
  assert.equal((await repo.listProducts(db, repo.ACTUAL_ONLY)).length, 1);
  assert.equal((await repo.listGoals(db)).length, 8);
  assert.equal((await repo.listContent(db, repo.ACTUAL_ONLY, { business: "ai-ceo-project" })).length, LAUNCH_DRAFTS.length);
});

test("プロフィール文は各SNSの文字数上限に収まる", () => {
  for (const p of PROFILES) assert.ok([...p.bio].length <= p.limit, `${p.platform}: ${[...p.bio].length}/${p.limit}`);
  for (const d of LAUNCH_DRAFTS.filter((d) => d.platform === "x")) {
    // X は全角140字（=半角280）まで。【 】の差し込み分を残しておく
    assert.ok([...d.body].length <= 140 + 40, `${d.ref}: ${[...d.body].length}`);
  }
});

test("旧版（PHASE 1）のDBからの移行：フォロワー記録が残り、販売先が note になる", async () => {
  const db = createClient({ url: ":memory:" });
  const { MIGRATIONS } = await import("../../lib/database/schema");
  await db.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  await db.executeMultiple(MIGRATIONS[0].sql + "\nINSERT INTO schema_migrations (version, name) VALUES (1, 'initial');");
  await db.execute("INSERT INTO metrics (metric, platform, date, value) VALUES ('followers', 'x', '2026-11-20', 10)");
  await db.execute("INSERT INTO products (name, sales_channel) VALUES ('旧商品', 'note（予定）')");
  await migrate(db);
  const m = await get<{ account: string; value: number }>(db, "SELECT account, value FROM metrics");
  assert.deepEqual(m, { account: "", value: 10 });
  assert.equal((await get<{ c: string }>(db, "SELECT sales_channel AS c FROM products"))?.c, "note（有料記事）");
});

test("サンプルデータは実データの集計に混ざらない", async () => {
  const db = await mem();
  await run(db, "INSERT INTO sales (sold_at, gross_jpy, data_kind) VALUES ('2026-11-05', 9999, 'sample')");
  await run(db, "INSERT INTO sales (sold_at, gross_jpy, data_kind) VALUES ('2026-11-06', 4980, 'actual')");
  assert.equal((await buildOverview(db, repo.ACTUAL_ONLY, now)).pnl.grossSales, 4980);
  assert.equal((await buildOverview(db, { kinds: ["actual", "sample"] }, now)).pnl.grossSales, 14979);
});

test("ログイン失敗：同じ接続元5回、または全体30回でロック", async () => {
  const db = await mem();
  for (let i = 0; i < 4; i++) await repo.recordLoginFailure(db, "a", 1000);
  assert.equal(await repo.loginLocked(db, "a", 2000), false);
  await repo.recordLoginFailure(db, "a", 1000);
  assert.equal(await repo.loginLocked(db, "a", 2000), true);
  assert.equal(await repo.loginLocked(db, "b", 2000), false);
  assert.equal(await repo.loginLocked(db, "a", 1000 + 16 * 60 * 1000), false); // 15分で解除
  for (let i = 0; i < 30; i++) await repo.recordLoginFailure(db, `ip-${i}`, 5_000_000);
  assert.equal(await repo.loginLocked(db, "new-ip", 5_000_001), true);
});

test("SNS自動投稿の結果の取り込み（ファイル・重複しない）", async () => {
  const parsed = parsePostFile("2026-11-21", {
    theme: "テーマ",
    x: "本文",
    results: { x: "ok:123", instagram: "error: token expired", youtube: "skipped" },
  });
  assert.deepEqual(parsed.map((p) => p.status), ["posted", "failed", "skipped"]);
  assert.equal(parsed[0].url, "https://x.com/i/web/status/123");
  assert.equal(parsed[1].error, "token expired");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posts-"));
  fs.writeFileSync(path.join(dir, "2026-11-21.json"), JSON.stringify({ theme: "t", results: { x: "ok:1", instagram: "ok:2" } }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  const db = await mem();
  assert.deepEqual(await importAutopostDir(db, dir), { files: 1, inserted: 2, updated: 0 });
  assert.deepEqual(await importAutopostDir(db, dir), { files: 1, inserted: 0, updated: 2 });
  assert.equal((await buildOverview(db, repo.ACTUAL_ONLY, now)).content.posted, 2);
});

test("SNS自動投稿の結果の取り込み（GitHub・差分のみ）", async () => {
  const db = await mem();
  const asked: string[] = [];
  const fakeFetch = (async (url: string) => {
    asked.push(url);
    const date = url.slice(-15, -5);
    if (date === "2026-11-20") return new Response(JSON.stringify({ theme: "t", results: { x: "ok:9" } }));
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;
  const r1 = await importAutopostFromGitHub(db, { since: null, today: "2026-11-21", base: "https://example.invalid/posts", fetchImpl: fakeFetch });
  assert.equal(r1.checkedDays, 30); // 2026-10-23〜2026-11-21
  assert.equal(r1.inserted, 1);
  asked.length = 0;
  const r2 = await importAutopostFromGitHub(db, { since: await repo.lastImportedDate(db, "axion-autopost"), today: "2026-11-21", base: "https://example.invalid/posts", fetchImpl: fakeFetch });
  assert.equal(r2.checkedDays, 4); // 最後に取り込んだ日の2日前から
  assert.equal(r2.updated, 1);
});

test("経営会議（ルールベース）：実データのみで作り、行動計画をタスクに登録する", async () => {
  const db = await mem();
  await run(db, "INSERT INTO sales (sold_at, gross_jpy, data_kind) VALUES ('2026-11-05', 9999, 'sample')");
  const r = await buildMeetingReport(db, now);
  assert.equal(r.generatedBy, "rule");
  assert.match(r.sections.revenue[0], /0円/); // サンプル売上は含めない
  assert.ok(r.sections.problems.some((p) => p.includes("販売中の商品がありません")));
  const id = await saveMeeting(db, r);
  const n = (await repo.openTasks(db)).length;
  assert.ok(n > 0);
  await saveMeeting(db, await buildMeetingReport(db, now));
  assert.equal((await repo.openTasks(db)).length, n); // 同じタスクは重複して作らない
  assert.ok(await repo.getReport(db, id));
});

test("開設キットを直すと、まだ下書きのものだけ新しい文章になる（発信名 HIDE）", async () => {
  const db = await mem();
  const x1 = "launch-kit:x-1";
  await run(db, "UPDATE content_posts SET body = '古い文章（柳原）' WHERE source_ref = ?", [x1]);
  await run(db, "UPDATE content_posts SET body = '承認済みの文章', status = 'approved' WHERE source_ref = 'launch-kit:x-2'");
  await seedBase(db);
  const rows = await repo.listContent(db, repo.ACTUAL_ONLY, { business: "ai-ceo-project" });
  assert.ok(rows.find((r) => r.title.startsWith("X①"))!.body.includes("HIDEです"));
  assert.equal(rows.find((r) => r.title.startsWith("X②"))!.body, "承認済みの文章"); // 手を付けたものは変えない
  for (const p of PROFILES) assert.ok(!p.name.includes("柳原") && !p.bio.includes("柳原"));
  assert.ok(LAUNCH_DRAFTS.every((d) => !d.body.includes("柳原")));
});
