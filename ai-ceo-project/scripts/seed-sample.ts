import { openDb } from "../lib/database/db";
import { jstDate, jstMonth, addDays } from "../lib/time";

/**
 * 画面確認用のサンプルデータ（data_kind='sample'）を入れる／消す。
 * サンプルは実データの集計には絶対に混ざらない（画面で「サンプル表示」をONにしたときだけ見える）。
 *   npm run db:sample        … 入れる
 *   npm run db:sample:clear  … 消す
 */
const db = openDb();
const tables = ["sales", "expenses", "content_posts", "metrics", "inquiries", "products", "business_ideas"];

function clear() {
  db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t} WHERE data_kind = 'sample'`).run();
    db.prepare("INSERT INTO audit_log (actor, action) VALUES ('system', 'sample.cleared')").run();
  })();
}

clear();
if (process.argv.includes("--clear")) {
  console.log("サンプルデータを削除しました");
  process.exit(0);
}

const today = jstDate();
const month = jstMonth();
db.transaction(() => {
  const p = db
    .prepare(
      `INSERT INTO products (business_id, name, description, price_jpy, production_status, qa_status, sales_status, data_kind)
       VALUES ('ai-business-lab', '【サンプル】AIメール作成テンプレート単品', '画面確認用の架空の商品', 1980, 'done', 'passed', 'on_sale', 'sample')`,
    )
    .run();
  const sale = db.prepare(
    "INSERT INTO sales (product_id, sold_at, gross_jpy, payment_fee_jpy, refund_jpy, channel, note, data_kind) VALUES (?, ?, ?, ?, ?, 'note', '架空の販売（サンプル）', 'sample')",
  );
  for (let i = 0; i < 4; i++) sale.run(p.lastInsertRowid, `${month}-0${i + 1}`, 1980, 297, i === 3 ? 1980 : 0);
  const exp = db.prepare("INSERT INTO expenses (spent_at, category, vendor, amount_jpy, note, data_kind) VALUES (?, ?, ?, ?, '架空（サンプル）', 'sample')");
  exp.run(`${month}-01`, "tool", "サンプルツール", 3000);
  exp.run(`${month}-02`, "ai_api", "サンプルAPI", 1200);
  const m = db.prepare("INSERT INTO metrics (metric, platform, date, value, source, data_kind) VALUES (?, ?, ?, ?, 'sample', 'sample')");
  m.run("followers", "x", today, 120);
  m.run("followers", "instagram", today, 80);
  m.run("article_views", "note", today, 340);
  db.prepare("INSERT INTO inquiries (received_at, channel, category, status, summary, data_kind) VALUES (?, 'note', 'usage', 'new', '架空の問い合わせ（サンプル）', 'sample')").run(today);
  db.prepare(
    "INSERT INTO content_posts (platform, status, title, body, scheduled_at, source, data_kind) VALUES ('note', 'pending_approval', '【サンプル】AIで営業メールを10分で作る方法', '架空の下書き（サンプル）', ?, 'sample', 'sample')",
  ).run(addDays(today, 2));
  db.prepare(
    `INSERT INTO business_ideas (name, target, problem, price_hypothesis, revenue_model, score_demand, score_competition, score_price,
       score_profit, score_difficulty, score_acquisition, score_recurrence, total_score, evaluation_note, origin, data_kind)
     VALUES ('【サンプル】士業向けAI議事録パック', '税理士・社労士事務所', '面談記録の作成に時間がかかる', '9,800円（架空）', '買い切り',
       60, 50, 55, 50, 70, 40, 45, 53, '画面確認用の架空の評価です。根拠はありません。', 'ai', 'sample')`,
  ).run();
  db.prepare("INSERT INTO audit_log (actor, action) VALUES ('system', 'sample.seeded')").run();
})();
console.log("サンプルデータを入れました（画面右上の「サンプル表示」をONにすると見えます）");
