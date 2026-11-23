/**
 * YouTube ショートの自動投稿（GitHub Actions から1時間ごとに実行：.github/workflows/hide_youtube_shorts.yml）
 *   Instagram に投稿済みのカルーセルを縦長の動画にして、HIDE の YouTube チャンネルにショートとして出す。
 *
 * 必要な環境変数（GitHub の Secrets）：
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN … 管理画面のデータベース
 *   YT_CLIENT_ID / YT_CLIENT_SECRET     … Google の OAuth クライアント（AXION と共用）
 *   HIDE_YT_REFRESH_TOKEN               … HIDE のチャンネルで許可したリフレッシュトークン
 * 任意：YT_PRIVACY（public／unlisted。既定 public）、DRY_RUN=1（動画を作るだけで投稿しない）、OUT=保存先（DRY_RUN のとき動画を保存）
 */
import fs from "node:fs/promises";
import { getDb } from "../lib/database/db";
import { publishNextShort } from "../lib/automation/yt-shorts";
import { makeShortVideo } from "../lib/video/short-video";
import { ytAccessToken, ytCredentialsFromEnv, ytUploadShort } from "../lib/social/youtube";

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const creds = ytCredentialsFromEnv();
  if (!creds && !dryRun) {
    console.log("YouTube の合鍵（YT_CLIENT_ID / YT_CLIENT_SECRET / HIDE_YT_REFRESH_TOKEN）が未設定のため、何もしません");
    return;
  }
  const privacy = process.env.YT_PRIVACY === "unlisted" ? "unlisted" : "public";
  const db = await getDb();
  let saved: Uint8Array | null = null;
  const r = await publishNextShort(
    db,
    {
      dryRun,
      privacy,
      makeVideo: async (slides) => (saved = await makeShortVideo(slides)),
      upload: async (video, meta) => {
        const t = await ytAccessToken(creds!);
        if (!t.ok) return t;
        return ytUploadShort(t.value, video, meta);
      },
    },
  );
  console.log(`[${r.status}] ${r.detail}${r.videoBytes ? `（${Math.round(r.videoBytes / 1024)}KB）` : ""}`);
  if (dryRun && saved && process.env.OUT) await fs.writeFile(process.env.OUT, saved);
  if (r.status === "failed") process.exitCode = 1;
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
