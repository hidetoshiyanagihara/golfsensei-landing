import { openDb } from "../lib/database/db";

// DB を作成（またはマイグレーション）し、初期設定・AI社員・最初の商品計画を登録する
const db = openDb();
const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
console.log("DB の準備ができました:", db.name);
console.log(`  AI社員 ${n("agents")}名 / 事業 ${n("businesses")}件 / 商品 ${n("products")}件 / 目標 ${n("goals")}件`);
db.close();
