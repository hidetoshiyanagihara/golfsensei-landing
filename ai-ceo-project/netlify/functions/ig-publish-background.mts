/**
 * Instagram の予約投稿を裏側で実行する（画像のアップロードと処理待ちに時間がかかるため。最大15分）。
 * 15分ごとの予約確認（post-scheduler）から、署名付きで呼ばれる。
 */
import { getDb } from "../../lib/database/db";
import { publishDueInstagram } from "../../lib/automation/ig-publisher";
import { verifyPurpose } from "../../lib/ai/dispatch";

export const handler = async (event: { body: string | null; httpMethod: string }) => {
  if (event.httpMethod !== "POST") return { statusCode: 405 };
  let body: unknown = null;
  try {
    body = JSON.parse(event.body ?? "null");
  } catch {
    return { statusCode: 400 };
  }
  if (!(await verifyPurpose(body, "ig-publish"))) return { statusCode: 401 };
  const r = await publishDueInstagram(await getDb());
  console.log(`ig-publish: ${r.status} ${r.detail}`);
  return { statusCode: 200 };
};
