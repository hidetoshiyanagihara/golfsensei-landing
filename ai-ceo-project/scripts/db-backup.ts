/**
 * データベースのバックアップ（GitHub Actions：.github/workflows/ai_ceo_db_backup.yml から毎日）
 *   1. 全テーブルを読み出して暗号化し、OUT に保存（Actions の Artifacts に30日残す）
 *   2. 復旧テスト：暗号化したファイルを開き、空のデータベースに書き戻して、行数が一致するか確かめる
 *   3. 最後に取れた日時を記録（自動点検で「バックアップが止まっていないか」を確かめる）
 * 記録（公開）には、テーブルの数と行数だけを出す（中身は出さない）。
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";
import { batch, getDb } from "../lib/database/db";
import * as repo from "../lib/database/repo";
import { decryptDump, dumpDb, encryptDump, restoreDump } from "../lib/ops/backup";

async function main() {
  const secret = process.env.TURSO_AUTH_TOKEN ?? "";
  const out = process.env.OUT ?? "backup.ccbk";
  const db = await getDb();
  const dump = await dumpDb(db);
  const file = encryptDump(dump, secret);
  fs.writeFileSync(out, file);
  const total = dump.tables.reduce((a, t) => a + t.rows.length, 0);
  console.log(`バックアップ：${dump.tables.length}テーブル・${total}行（暗号化後 ${Math.round(file.length / 1024)}KB）`);

  // 復旧テスト
  const check = createClient({ url: ":memory:" });
  const counts = await restoreDump(check, decryptDump(fs.readFileSync(out), secret));
  const bad = dump.tables.filter((t) => counts[t.name] !== t.rows.length).map((t) => t.name);
  if (bad.length) throw new Error(`復旧テストで行数が合いません：${bad.join("、")}`);
  console.log("復旧テスト：合格（すべてのテーブルの行数が一致）");

  await batch(db, [
    repo.setSettingStmt("backup_last_at", dump.createdAt),
    repo.auditStmt("system", "db.backup", "", { tables: dump.tables.length, rows: total }),
  ]);
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
