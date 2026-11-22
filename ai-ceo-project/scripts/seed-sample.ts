import type { InStatement } from "@libsql/client";
import { openDb, batch } from "../lib/database/db";
import { jstDate, jstMonth, addDays } from "../lib/time";

/**
 * 画面確認用のサンプルデータ（data_kind='sample'）を入れる／消す。
 * サンプルは実データの集計には絶対に混ざらない（画面で「サンプル表示」をONにしたときだけ見える）。
 *   npm run db:sample        … 入れる
 *   npm run db:sample:clear  … 消す
 */
const tables = ["sales", "expenses", "content_posts", "metrics", "inquiries", "products", "business_ideas"];

async function main() {
  const db = await openDb();
  await batch(db, [
    ...tables.map((t) => `DELETE FROM ${t} WHERE data_kind = 'sample'`),
    "INSERT INTO audit_log (actor, action) VALUES ('system', 'sample.cleared')",
  ]);
  if (process.argv.includes("--clear")) {
    console.log("サンプルデータを削除しました");
    return;
  }
  const today = jstDate();
  const month = jstMonth();
  const p = await db.execute(
    `INSERT INTO products (business_id, name, description, price_jpy, production_status, qa_status, sales_status, data_kind)
     VALUES ('ai-business-lab', '【サンプル】AIメール作成テンプレート単品', '画面確認用の架空の商品', 1980, 'done', 'passed', 'on_sale', 'sample')`,
  );
  const pid = Number(p.lastInsertRowid);
  const s: InStatement[] = [];
  for (let i = 0; i < 4; i++)
    s.push({
      sql: "INSERT INTO sales (product_id, sold_at, gross_jpy, payment_fee_jpy, refund_jpy, channel, note, data_kind) VALUES (?, ?, 1980, 287, ?, 'note', '架空の販売（サンプル）', 'sample')",
      args: [pid, `${month}-0${i + 1}`, i === 3 ? 1980 : 0],
    });
  s.push({ sql: "INSERT INTO expenses (spent_at, category, vendor, amount_jpy, note, data_kind) VALUES (?, 'tool', 'サンプルツール', 3000, '架空（サンプル）', 'sample')", args: [`${month}-01`] });
  s.push({ sql: "INSERT INTO expenses (spent_at, category, vendor, amount_jpy, note, data_kind) VALUES (?, 'ai_api', 'サンプルAPI', 1200, '架空（サンプル）', 'sample')", args: [`${month}-02`] });
  const m = "INSERT INTO metrics (metric, account, platform, date, value, source, data_kind) VALUES (?, ?, ?, ?, ?, 'sample', 'sample')";
  s.push({ sql: m, args: ["followers", "ai-ceo", "x", today, 120] });
  s.push({ sql: m, args: ["followers", "ai-ceo", "instagram", today, 80] });
  s.push({ sql: m, args: ["article_views", "ai-ceo", "note", today, 340] });
  s.push({ sql: "INSERT INTO inquiries (received_at, channel, category, status, summary, data_kind) VALUES (?, 'note', 'usage', 'new', '架空の問い合わせ（サンプル）', 'sample')", args: [today] });
  s.push({
    sql: "INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, source, data_kind) VALUES ('ai-ceo-project', 'note', 'pending_approval', '【サンプル】AIで営業メールを10分で作る方法', '架空の下書き（サンプル）', ?, 'sample', 'sample')",
    args: [addDays(today, 2)],
  });
  s.push(
    `INSERT INTO business_ideas (name, target, problem, price_hypothesis, revenue_model, score_demand, score_competition, score_price,
       score_profit, score_difficulty, score_acquisition, score_recurrence, total_score, evaluation_note, origin, data_kind)
     VALUES ('【サンプル】士業向けAI議事録パック', '税理士・社労士事務所', '面談記録の作成に時間がかかる', '9,800円（架空）', '買い切り',
       60, 50, 55, 50, 70, 40, 45, 53, '画面確認用の架空の評価です。根拠はありません。', 'ai', 'sample')`,
  );
  s.push("INSERT INTO audit_log (actor, action) VALUES ('system', 'sample.seeded')");
  await batch(db, s);
  console.log("サンプルデータを入れました（画面右上の「サンプル表示」をONにすると見えます）");
  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
