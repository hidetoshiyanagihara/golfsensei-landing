import path from "node:path";
import { openDb } from "../lib/database/db";
import { importAutopost } from "../lib/importers/autopost";

// このリポジトリにある実データ（SNS自動投稿の結果）を取り込む。元のファイルは変更しない
const db = openDb();
const dir = path.resolve(process.cwd(), "..", "axion-autopost", "posts");
const r = importAutopost(db, dir);
console.log(`SNS自動投稿の結果を取り込みました: ファイル ${r.files}件 / 新規 ${r.inserted}件 / 更新 ${r.updated}件`);
db.close();
