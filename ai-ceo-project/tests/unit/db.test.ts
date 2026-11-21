import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../lib/database/db";
import * as repo from "../../lib/database/repo";
import { buildOverview } from "../../lib/analytics/overview";
import { buildMeetingReport, saveMeeting } from "../../lib/analytics/meeting";
import { importAutopost, parsePostFile } from "../../lib/importers/autopost";

const now = new Date("2026-11-21T03:00:00Z");

test("初期データ：AI社員7名・最初の商品（販売前）・実績0円", () => {
  const db = openDb(":memory:");
  assert.equal(repo.listAgents(db).length, 7);
  assert.ok(repo.listAgents(db).every((a) => a.status === "not_connected"));
  const [p] = repo.listProducts(db, repo.ACTUAL_ONLY);
  assert.equal(p.price_jpy, 4980);
  assert.equal(p.sales_status, "not_for_sale");
  assert.equal(repo.getSettings(db).automation_enabled, "false");
  const o = buildOverview(db, repo.ACTUAL_ONLY, now);
  assert.equal(o.pnl.netSales, 0);
  assert.equal(o.budget.capJpy, 30000);
  // 2回目の初期化でも重複しない
  const { seedBase } = require("../../lib/database/seed");
  seedBase(db);
  assert.equal(repo.listProducts(db, repo.ACTUAL_ONLY).length, 1);
  assert.equal(repo.listGoals(db).length, 8);
});

test("サンプルデータは実データの集計に混ざらない", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sales (sold_at, gross_jpy, data_kind) VALUES ('2026-11-05', 9999, 'sample')").run();
  db.prepare("INSERT INTO sales (sold_at, gross_jpy, data_kind) VALUES ('2026-11-06', 4980, 'actual')").run();
  assert.equal(buildOverview(db, repo.ACTUAL_ONLY, now).pnl.grossSales, 4980);
  assert.equal(buildOverview(db, { kinds: ["actual", "sample"] }, now).pnl.grossSales, 14979);
});

test("SNS自動投稿の結果の取り込み（重複しない）", () => {
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
  const db = openDb(":memory:");
  assert.deepEqual(importAutopost(db, dir), { files: 1, inserted: 2, updated: 0 });
  assert.deepEqual(importAutopost(db, dir), { files: 1, inserted: 0, updated: 2 });
  assert.equal(buildOverview(db, repo.ACTUAL_ONLY, now).content.posted, 2);
});

test("経営会議（ルールベース）：実データのみで作り、行動計画をタスクに登録する", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sales (sold_at, gross_jpy, data_kind) VALUES ('2026-11-05', 9999, 'sample')").run();
  const r = buildMeetingReport(db, now);
  assert.equal(r.generatedBy, "rule");
  assert.match(r.sections.revenue[0], /0円/); // サンプル売上は含めない
  assert.ok(r.sections.problems.some((p) => p.includes("販売中の商品がありません")));
  const id = saveMeeting(db, r);
  const n = repo.openTasks(db).length;
  assert.ok(n > 0);
  saveMeeting(db, buildMeetingReport(db, now));
  assert.equal(repo.openTasks(db).length, n); // 同じタスクは重複して作らない
  assert.ok(repo.getReport(db, id));
});
