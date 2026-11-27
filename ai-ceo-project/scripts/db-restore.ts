/**
 * バックアップから、パソコン上に SQLite のファイルを作る（復旧用。本番のデータベースは書き換えない）
 *   BACKUP=ダウンロードした .ccbk ファイル  OUT=作るファイル（例：restored.db）  TURSO_AUTH_TOKEN=バックアップを取ったときの合鍵
 *   npx tsx scripts/db-restore.ts
 * 本番に戻すとき：作ったファイルから Turso に新しいデータベースを作り（turso db create 新しい名前 --from-file restored.db）、
 * 中身を確かめてから Netlify と GitHub の TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を差し替える（手順は docs/OPERATIONS.md）。
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { decryptDump, restoreDump } from "../lib/ops/backup";

async function main() {
  const src = process.env.BACKUP ?? "";
  const out = path.resolve(process.env.OUT ?? "restored.db");
  if (!src || !fs.existsSync(src)) throw new Error("BACKUP にバックアップのファイルを指定してください");
  if (fs.existsSync(out)) throw new Error(`${out} はすでにあります（上書きしません）`);
  const dump = decryptDump(fs.readFileSync(src), process.env.TURSO_AUTH_TOKEN ?? "");
  const counts = await restoreDump(createClient({ url: `file:${out}` }), dump);
  console.log(`${out} を作りました（${dump.createdAt} 時点・${Object.keys(counts).length}テーブル・${Object.values(counts).reduce((a, b) => a + b, 0)}行）`);
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
