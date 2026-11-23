/**
 * HIDE の YouTube チャンネルをつなぐ（GitHub Actions：.github/workflows/hide_youtube_connect.yml から手動で実行）
 *   1回目（CODE なし）：チャンネルの持ち主が開く「許可」のリンクを、HTML ファイル（OUT_HTML）に書き出す
 *   2回目（CODE あり）：許可のあとに出たコードを合鍵（リフレッシュトークン）に交換し、
 *                       YT_CLIENT_SECRET で暗号化してデータベースに保存する。どのチャンネルにつながったかを表示する
 * 合鍵そのものは画面（ログ）に出さない。
 */
import fs from "node:fs/promises";
import { batch, getDb } from "../lib/database/db";
import * as repo from "../lib/database/repo";
import { seal } from "../lib/security/seal";
import { extractCode, ytAccessToken, ytAuthUrl, ytChannel, ytExchangeCode } from "../lib/social/youtube";

export const SEAL_PURPOSE = "hide-yt-refresh-token";

async function main() {
  const clientId = process.env.YT_CLIENT_ID?.trim();
  const clientSecret = process.env.YT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("YT_CLIENT_ID / YT_CLIENT_SECRET が未設定です");
  const code = extractCode(process.env.CODE ?? "");

  if (!code) {
    const url = ytAuthUrl(clientId);
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HIDE の YouTube をつなぐ</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.8">
<h1 style="font-size:22px">HIDE の YouTube チャンネルをつなぐ</h1>
<ol>
<li>下のボタンを押す</li>
<li>HIDE のチャンネル（AI CEO PROJECT）のアカウントを選ぶ。チャンネルを選ぶ画面が出たら HIDE のチャンネルを選ぶ</li>
<li>「このアプリは Google で確認されていません」と出たら「詳細」→「（安全ではないページ）に移動」</li>
<li>「許可」を押す（アップロードと、チャンネル名の確認だけに使います）</li>
<li>OAuth Playground という画面に変わったら、上のアドレス欄の URL を丸ごとコピーする（10分以内に次へ）</li>
</ol>
<p><a href="${url.replace(/&/g, "&amp;")}" style="display:inline-block;background:#c00;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">HIDE のチャンネルを許可する</a></p>
</body>`;
    if (process.env.OUT_HTML) await fs.writeFile(process.env.OUT_HTML, html);
    console.log("許可のリンクを作りました。この実行の下の「Artifacts」→「youtube-connect-link」を開いてください");
    return;
  }

  const ex = await ytExchangeCode(clientId, clientSecret, code);
  if (!ex.ok) throw new Error(ex.error);
  const token = await ytAccessToken({ clientId, clientSecret, refreshToken: ex.value });
  if (!token.ok) throw new Error(token.error);
  const ch = await ytChannel(token.value);
  if (!ch.ok) throw new Error(ch.error);
  const db = await getDb();
  await batch(db, [
    repo.setSettingStmt("hide_yt_refresh_token_sealed", seal(ex.value, clientSecret, SEAL_PURPOSE)),
    repo.setSettingStmt("hide_yt_channel_title", ch.value.title),
    repo.setSettingStmt("hide_yt_channel_id", ch.value.id),
    repo.auditStmt("owner", "yt.connected", ch.value.id, ch.value.title),
  ]);
  console.log(`つながりました：チャンネル「${ch.value.title}」（${ch.value.id}）`);
  console.log("HIDE のチャンネルでなければ、もう一度 1回目からやり直してください（上書きされます）");
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
