/**
 * 予約投稿の実行（15分ごと・Netlify の定期実行関数）。
 * X の自動投稿がONで、合鍵があり、承認・予約済みで予定時刻を過ぎた投稿があるときだけ、1件投稿する。
 */
import { getDb } from "../../lib/database/db";
import { publishDueX } from "../../lib/automation/publisher";
import { makeXPoster, xCredentialsFromEnv } from "../../lib/social/x";

export default async () => {
  const db = await getDb();
  const cred = xCredentialsFromEnv();
  const r = await publishDueX(db, cred ? makeXPoster(cred) : null);
  console.log(`post-scheduler: ${r.status} ${r.detail}`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: "*/15 * * * *" };
