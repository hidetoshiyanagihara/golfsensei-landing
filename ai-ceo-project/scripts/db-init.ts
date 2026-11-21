import { openDb, get } from "../lib/database/db";

// DB を作成（またはマイグレーション）し、初期設定・AI社員・最初の商品計画・新アカウントの下書きを登録する。
// TURSO_DATABASE_URL が設定されていれば Turso（本番）、なければ data/command-center.db（パソコン）。
async function main() {
  const db = await openDb();
  const n = async (t: string) => Number((await get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0);
  console.log("DB の準備ができました:", process.env.TURSO_DATABASE_URL ? "Turso" : "data/command-center.db");
  console.log(`  AI社員 ${await n("agents")}名 / 事業 ${await n("businesses")}件 / 商品 ${await n("products")}件 / 目標 ${await n("goals")}件 / 投稿 ${await n("content_posts")}件`);
  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
