import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { openDb, get, run, all } from "../../lib/database/db";
import { syncAgentConnection } from "../../lib/ai/runner";
import { decryptDump, dumpDb, encryptDump, restoreDump } from "../../lib/ops/backup";
import { healthIssues, syncHealthTasks, HEALTH_PREFIX } from "../../lib/ops/health";
import { jstStamp } from "../../lib/automation/publisher";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

test("バックアップ：暗号化して、空のデータベースに書き戻すと、全テーブルの行数と中身が一致する", async () => {
  const db = await openDb(":memory:");
  await run(db, "INSERT INTO tasks (title, detail) VALUES ('日本語の題名', 'くわしく')");
  const dump = await dumpDb(db);
  const file = encryptDump(dump, "secret-A");
  assert.ok(!file.toString("utf8").includes("日本語の題名")); // 暗号化されている
  assert.throws(() => decryptDump(file, "secret-B"), /開けませんでした/);
  const target = createClient({ url: ":memory:" });
  const counts = await restoreDump(target, decryptDump(file, "secret-A"));
  for (const t of dump.tables) assert.equal(counts[t.name], t.rows.length, t.name);
  const row = await get<{ title: string }>(target, "SELECT title FROM tasks WHERE detail = 'くわしく'");
  assert.equal(row!.title, "日本語の題名");
  await assert.rejects(restoreDump(target, dump), /空ではありません/); // 上書きしない
});

test("自動点検：見回りの停止・予約の遅れ・予算・残高不足を見つけ、「次にやること」に重ねずに載せ、直ったら完了にする", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  const now = new Date("2026-11-28T12:00:00+09:00");
  await run(db, "INSERT INTO settings (key, value) VALUES ('x_autopost_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  await run(db, "INSERT INTO settings (key, value) VALUES ('scheduler_last_run', '2026-11-28 09:00 posted') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  await run(db, "INSERT INTO settings (key, value) VALUES ('backup_last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [now.toISOString()]);
  await run(db, "INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, post_time, data_kind) VALUES ('ai-ceo-project', 'x', 'scheduled', 't', 'b', '2026-11-28', '07:00', 'actual')");
  await run(db, "INSERT INTO agent_runs (agent_id, task, params, started_at, status, trigger, summary, error) VALUES ('product', 'product.qa', '{}', ?, 'error', 'manual', 'x', '400 Your credit balance is too low')", [now.toISOString()]);
  await run(db, "INSERT INTO agent_runs (agent_id, task, params, started_at, status, trigger, summary, cost_jpy) VALUES ('product', 'product.qa', '{}', ?, 'success', 'manual', 'x', 8000)", [now.toISOString()]);
  const issues = await healthIssues(db, now);
  const titles = issues.map((i) => i.title).join("\n");
  assert.match(titles, /見回りが止まって/);
  assert.match(titles, /X の予約投稿が1件/);
  assert.match(titles, /残高が足りません/);
  assert.match(titles, /AI API の月間上限の80%/);
  assert.doesNotMatch(titles, /バックアップ/);

  assert.equal((await syncHealthTasks(db, issues)).added, issues.length);
  assert.equal((await syncHealthTasks(db, issues)).added, 0); // 重ねない
  const r = await syncHealthTasks(db, issues.slice(1));
  assert.equal(r.closed, 1); // 直ったものは完了
  const open = await all<{ title: string }>(db, "SELECT title FROM tasks WHERE source = 'health' AND status = 'todo'");
  assert.equal(open.length, issues.length - 1);
  assert.ok(open.every((t) => t.title.startsWith(HEALTH_PREFIX)));
});

test("自動点検：問題がなければ何も載せない", async () => {
  const db = await openDb(":memory:");
  await syncAgentConnection(db, true);
  const now = new Date();
  await run(db, "DELETE FROM content_posts"); // 初期データの下書きは除く
  await run(db, "INSERT INTO settings (key, value) VALUES ('scheduler_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`${jstStamp(now)} nothing_due`]);
  await run(db, "INSERT INTO settings (key, value) VALUES ('backup_last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [now.toISOString()]);
  const issues = await healthIssues(db, now);
  assert.deepEqual(issues.map((i) => i.title), []);
});
