/**
 * AI社員の仕事を裏側で実行する Netlify のバックグラウンド関数（名前の末尾 -background ＝ 最大15分）。
 * 管理画面のボタン → 受付（queued）→ ここで実行 → 結果をデータベースに保存。
 * 署名のない依頼は何もしない。
 */
import { getDb } from "../../lib/database/db";
import { executeRun } from "../../lib/ai/runner";
import { verifyDispatch } from "../../lib/ai/dispatch";
import "../../lib/ai/tasks/index";

export const handler = async (event: { body: string | null; httpMethod: string }) => {
  if (event.httpMethod !== "POST") return { statusCode: 405 };
  let body: unknown = null;
  try {
    body = JSON.parse(event.body ?? "null");
  } catch {
    return { statusCode: 400 };
  }
  const runId = await verifyDispatch(body);
  if (runId === null) return { statusCode: 401 };
  const db = await getDb();
  const r = await executeRun(db, runId);
  console.log(`agent run ${runId}: ${r.ok ? "ok" : "failed"}`);
  return { statusCode: 200 };
};
