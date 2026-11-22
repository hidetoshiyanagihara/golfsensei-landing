import { batch, get, run, type DB } from "../database/db";
import * as repo from "../database/repo";
import { hasUrl, xWeightedLength, X_MAX_WEIGHT, type XPoster } from "../social/x";

/**
 * 予約投稿の実行（X）。15分ごとに呼ばれる。
 * 投稿するのは「代表者が承認して予約した」AI CEO PROJECT の X 投稿で、予定時刻を過ぎたものだけ。
 * スパム防止：1日の上限・前回からの間隔・1回の実行で1件まで。
 */

export const X_DAILY_LIMIT_DEFAULT = 5;
export const X_MIN_INTERVAL_MIN = 30;
export const DEFAULT_POST_TIME = "08:00";

/** 日本時間の「YYYY-MM-DD HH:MM」 */
export function jstStamp(d = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

/** 投稿してよい文章か（投稿前の最終確認） */
export function checkXText(text: string): string | null {
  if (!text.trim()) return "本文が空です";
  if (/[【】]/.test(text)) return "【 】の部分が残っています（ご自身の言葉に書き換えてから予約してください）";
  if (hasUrl(text)) return "URLが入っています（XはURL入りの投稿が約13倍の料金のため、自動投稿しません。リンクはプロフィールに置いてください）";
  const w = xWeightedLength(text);
  if (w > X_MAX_WEIGHT) return `長すぎます（${Math.ceil(w / 2)}字相当。日本語は140字まで）`;
  return null;
}

export type PublishResult = { status: "disabled" | "no_credentials" | "nothing_due" | "limited" | "posted" | "failed"; detail: string };

export async function publishDueX(db: DB, poster: XPoster | null, now = new Date()): Promise<PublishResult> {
  const settings = await repo.getSettings(db);
  const stamp = jstStamp(now);
  const finish = async (r: PublishResult) => {
    await batch(db, [repo.setSettingStmt("scheduler_last_run", `${stamp} ${r.status}`)]);
    return r;
  };
  if (settings.x_autopost_enabled !== "true") return finish({ status: "disabled", detail: "X の自動投稿はOFFです" });
  if (!poster) return finish({ status: "no_credentials", detail: "X の合鍵が設定されていません" });

  const today = stamp.slice(0, 10);
  const limit = repo.num(settings, "x_daily_limit", X_DAILY_LIMIT_DEFAULT);
  const postedToday = await get<{ n: number; last: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(posted_at) AS last FROM content_posts
     WHERE platform = 'x' AND business_id = 'ai-ceo-project' AND status = 'posted' AND substr(posted_at, 1, 10) = ?`,
    [today],
  );
  if (Number(postedToday?.n ?? 0) >= limit) return finish({ status: "limited", detail: `今日はすでに ${limit}件 投稿しました（1日の上限）` });
  const last = postedToday?.last;
  if (last && last.length >= 16) {
    const mins = (Date.parse(stamp.replace(" ", "T") + ":00+09:00") - Date.parse(last.replace(" ", "T") + ":00+09:00")) / 60000;
    if (mins < X_MIN_INTERVAL_MIN) return finish({ status: "limited", detail: `前回の投稿から${X_MIN_INTERVAL_MIN}分たっていません` });
  }

  const due = await get<{ id: number; body: string }>(
    db,
    `SELECT id, body FROM content_posts
     WHERE status = 'scheduled' AND platform = 'x' AND business_id = 'ai-ceo-project' AND data_kind = 'actual'
       AND scheduled_at IS NOT NULL AND (scheduled_at || ' ' || COALESCE(post_time, '${DEFAULT_POST_TIME}')) <= ?
     ORDER BY scheduled_at, COALESCE(post_time, '${DEFAULT_POST_TIME}'), id LIMIT 1`,
    [stamp],
  );
  if (!due) return finish({ status: "nothing_due", detail: "予定時刻を過ぎた予約はありません" });

  // 二重投稿を防ぐため、先に「投稿中」にする（取れなかったら別の実行が処理中）
  const claimed = await run(db, "UPDATE content_posts SET status = 'posting' WHERE id = ? AND status = 'scheduled'", [due.id]);
  if (claimed.changes !== 1) return finish({ status: "nothing_due", detail: "別の実行が処理中です" });

  const problem = checkXText(due.body);
  if (problem) {
    await batch(db, [
      { sql: "UPDATE content_posts SET status = 'failed', error = ? WHERE id = ?", args: [problem, due.id] },
      repo.auditStmt("system", "x.post_blocked", `content:${due.id}`, problem),
    ]);
    return finish({ status: "failed", detail: problem });
  }

  const r = await poster(due.body);
  if (r.ok) {
    await batch(db, [
      {
        sql: "UPDATE content_posts SET status = 'posted', posted_at = ?, external_id = ?, url = ?, error = NULL WHERE id = ?",
        args: [stamp, r.id, `https://x.com/i/web/status/${r.id}`, due.id],
      },
      repo.auditStmt("system", "x.posted", `content:${due.id}`, r.id),
    ]);
    return finish({ status: "posted", detail: `投稿しました（${r.id}）` });
  }
  // 一時的なエラー（回数制限・X側の障害）は予約に戻して次回やり直す。それ以外は失敗にする
  await batch(db, [
    { sql: `UPDATE content_posts SET status = ?, error = ? WHERE id = ?`, args: [r.retryable ? "scheduled" : "failed", r.error, due.id] },
    repo.auditStmt("system", "x.post_failed", `content:${due.id}`, r.error),
  ]);
  return finish({ status: "failed", detail: r.error });
}
