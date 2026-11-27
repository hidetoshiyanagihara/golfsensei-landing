/**
 * 投稿を「見送り」にする（GitHub Actions：.github/workflows/ai_ceo_content_skip.yml から代表者の指示で実行）
 *   CONTENT_ID … 投稿の番号
 * 管理画面と同じ状態の決まり（lib/rules.ts）に従う：失敗 → 下書き → 見送り。投稿済み・投稿中のものは変えない。
 */
import { batch, get, getDb } from "../lib/database/db";
import * as repo from "../lib/database/repo";
import { canTransitionContent, type ContentStatus } from "../lib/rules";

async function main() {
  const id = Number(process.env.CONTENT_ID);
  if (!Number.isInteger(id) || id < 1) throw new Error("CONTENT_ID が正しくありません");
  const db = await getDb();
  const row = await get<{ status: ContentStatus; title: string }>(db, "SELECT status, title FROM content_posts WHERE id = ? AND data_kind = 'actual'", [id]);
  if (!row) throw new Error(`投稿 #${id} が見つかりません`);
  const path: ContentStatus[] = row.status === "failed" ? ["draft", "skipped"] : ["skipped"];
  let from = row.status;
  const stmts = [];
  for (const to of path) {
    if (!canTransitionContent(from, to)) throw new Error(`「${from}」の投稿は見送りにできません`);
    stmts.push(repo.auditStmt("owner", "content.status", `content:${id}`, { from, to, via: "github-actions" }));
    from = to;
  }
  await batch(db, [{ sql: "UPDATE content_posts SET status = 'skipped' WHERE id = ?", args: [id] }, ...stmts]);
  console.log(`投稿 #${id} を見送りにしました（${row.status} → skipped）`);
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
