import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 初回セットアップ：.env.local を作り、ログイン用パスワードを発行する。
 * すでに .env.local がある場合は何も上書きしない（既存の設定を消さない）。
 */
const file = path.join(process.cwd(), ".env.local");
if (fs.existsSync(file)) {
  console.log(".env.local はすでにあります。上書きしません。パスワードを変えたいときは .env.local の ADMIN_PASSWORD を書き換えてください。");
  process.exit(0);
}
const password = crypto.randomBytes(12).toString("base64url");
const secret = crypto.randomBytes(32).toString("base64url");
fs.writeFileSync(
  file,
  `# 自動生成（${new Date().toISOString()}）。Git には入りません。\nADMIN_PASSWORD=${password}\nSESSION_SECRET=${secret}\n`,
  { mode: 0o600 },
);
console.log("\n.env.local を作成しました。");
console.log("ログイン用パスワード:", password);
console.log("（このパスワードは .env.local に保存されています。他の人に見せないでください）\n");
