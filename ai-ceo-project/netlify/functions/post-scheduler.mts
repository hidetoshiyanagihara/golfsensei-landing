/**
 * 予約投稿の実行（15分ごと・Netlify の定期実行関数）。
 * X の自動投稿がONで、合鍵があり、承認・予約済みで予定時刻を過ぎた投稿があるときだけ、1件投稿する。
 */
import { getDb } from "../../lib/database/db";
import { publishDueX } from "../../lib/automation/publisher";
import { makeXPoster, xCredentialsFromEnv } from "../../lib/social/x";
import { APP_URL, dueInstagram, maybeRefreshIgToken } from "../../lib/automation/ig-publisher";
import { signPurpose } from "../../lib/ai/dispatch";

export default async () => {
  const db = await getDb();
  const cred = xCredentialsFromEnv();
  const r = await publishDueX(db, cred ? makeXPoster(cred) : null);
  console.log(`post-scheduler: ${r.status} ${r.detail}`);
  // Instagram：合鍵の延長（7日ごと）と、予定時刻を過ぎた予約があれば裏側の投稿を呼ぶ
  try {
    console.log(`ig-token: ${await maybeRefreshIgToken(db)}`);
    if (await dueInstagram(db)) {
      const res = await fetch(`${APP_URL}/.netlify/functions/ig-publish-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await signPurpose("ig-publish")),
        redirect: "manual",
      });
      console.log(`ig-publish dispatched: ${res.status}`);
    }
  } catch (e) {
    console.log(`ig: ${e instanceof Error ? e.message : "error"}`);
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: "*/15 * * * *" };
