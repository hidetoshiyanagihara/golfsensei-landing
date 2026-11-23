import { batch, get, run, type DB } from "../database/db";
import * as repo from "../database/repo";
import { parseExtra } from "../marketing/note-format";
import { checkInstagram, igMe, igPublishCarousel, igRefresh, type IgResult } from "../social/instagram";
import { signImage } from "../social/image-sign";
import { jstStamp } from "./publisher";

/**
 * Instagram の予約投稿（AI CEO PROJECT／HIDE のカルーセル）。
 * 投稿するのは、代表者が承認して予約し、予定時刻を過ぎたものだけ。1日の上限・前回から3時間以上あける。
 */
export const IG_DAILY_LIMIT_DEFAULT = 2;
export const IG_MIN_INTERVAL_MIN = 180;
export const APP_URL = process.env.URL || "https://ai-ceo-command.netlify.app";

/** 合鍵：延長した最新のもの（データベース）を優先し、なければ Netlify の環境変数 */
export async function igToken(db: DB): Promise<string | null> {
  const s = await repo.getSettings(db);
  return s.ig_access_token || process.env.IG_ACCESS_TOKEN || null;
}

export async function dueInstagram(db: DB, now = new Date()): Promise<boolean> {
  const r = await get(
    db,
    `SELECT 1 FROM content_posts WHERE status = 'scheduled' AND platform = 'instagram' AND business_id = 'ai-ceo-project' AND data_kind = 'actual'
       AND scheduled_at IS NOT NULL AND (scheduled_at || ' ' || COALESCE(post_time, '08:00')) <= ?`,
    [jstStamp(now)],
  );
  return !!r;
}

/** 合鍵の延長（7日ごと）。60日で切れるため。失敗しても6時間は再挑戦しない */
export async function maybeRefreshIgToken(db: DB, now = Date.now(), refresh = igRefresh): Promise<string> {
  const s = await repo.getSettings(db);
  const token = s.ig_access_token || process.env.IG_ACCESS_TOKEN;
  if (!token) return "no_token";
  const last = Date.parse(s.ig_token_refreshed_at ?? "") || 0;
  const tried = Date.parse(s.ig_token_refresh_tried_at ?? "") || 0;
  if (now - last < 7 * 86_400_000 || now - tried < 6 * 3_600_000) return "not_needed";
  await batch(db, [repo.setSettingStmt("ig_token_refresh_tried_at", new Date(now).toISOString())]);
  const r = await refresh(token);
  if (!r.ok) {
    await batch(db, [repo.auditStmt("system", "ig.token_refresh_failed", "", r.error)]);
    return "failed";
  }
  await batch(db, [
    repo.setSettingStmt("ig_access_token", r.value.access_token),
    repo.setSettingStmt("ig_token_refreshed_at", new Date(now).toISOString()),
    repo.auditStmt("system", "ig.token_refreshed", "", `有効期限 約${Math.round(r.value.expires_in / 86400)}日`),
  ]);
  return "refreshed";
}

type Publisher = typeof igPublishCarousel;

export async function publishDueInstagram(db: DB, now = new Date(), publish: Publisher = igPublishCarousel, me = igMe): Promise<{ status: string; detail: string }> {
  const settings = await repo.getSettings(db);
  const stamp = jstStamp(now);
  if (settings.ig_autopost_enabled !== "true") return { status: "disabled", detail: "Instagram の自動投稿はOFFです" };
  const token = await igToken(db);
  if (!token) return { status: "no_credentials", detail: "Instagram の合鍵が設定されていません" };

  const limit = repo.num(settings, "ig_daily_limit", IG_DAILY_LIMIT_DEFAULT);
  const today = await get<{ n: number; last: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(posted_at) AS last FROM content_posts
     WHERE platform = 'instagram' AND business_id = 'ai-ceo-project' AND status = 'posted' AND substr(posted_at, 1, 10) = ?`,
    [stamp.slice(0, 10)],
  );
  if (Number(today?.n ?? 0) >= limit) return { status: "limited", detail: `今日はすでに ${limit}件 投稿しました` };
  if (today?.last && today.last.length >= 16) {
    const mins = (Date.parse(stamp.replace(" ", "T") + ":00+09:00") - Date.parse(today.last.replace(" ", "T") + ":00+09:00")) / 60000;
    if (mins < IG_MIN_INTERVAL_MIN) return { status: "limited", detail: "前回の投稿から3時間たっていません" };
  }
  const due = await get<{ id: number; body: string; extra: string | null }>(
    db,
    `SELECT id, body, extra FROM content_posts
     WHERE status = 'scheduled' AND platform = 'instagram' AND business_id = 'ai-ceo-project' AND data_kind = 'actual'
       AND scheduled_at IS NOT NULL AND (scheduled_at || ' ' || COALESCE(post_time, '08:00')) <= ?
     ORDER BY scheduled_at, COALESCE(post_time, '08:00'), id LIMIT 1`,
    [stamp],
  );
  if (!due) return { status: "nothing_due", detail: "予定時刻を過ぎた予約はありません" };
  const claimed = await run(db, "UPDATE content_posts SET status = 'posting' WHERE id = ? AND status = 'scheduled'", [due.id]);
  if (claimed.changes !== 1) return { status: "nothing_due", detail: "別の実行が処理中です" };

  const slides = parseExtra(due.extra).slides ?? [];
  const caption = due.body.replace(/\r\n?/g, "\n");
  const fail = async (error: string, retry: boolean) => {
    await batch(db, [
      { sql: "UPDATE content_posts SET status = ?, error = ? WHERE id = ?", args: [retry ? "scheduled" : "failed", error, due.id] },
      repo.auditStmt("system", "ig.post_failed", `content:${due.id}`, error),
    ]);
    return { status: "failed", detail: error };
  };
  const problem = checkInstagram(caption, slides);
  if (problem) return fail(problem, false);

  let userId = settings.ig_user_id;
  if (!userId) {
    const m = await me(token);
    if (!m.ok) return fail(m.error, m.retryable);
    userId = m.value.user_id ?? m.value.id ?? "";
    await batch(db, [repo.setSettingStmt("ig_user_id", userId)]);
  }
  const imageUrls = slides.map((_, i) => `${APP_URL}/api/note-image/${due.id}?kind=slide&n=${i + 1}&format=jpg&${signImage(due.id, "slide", i + 1, 3600)}`);
  const r: IgResult<{ id: string; permalink?: string }> = await publish({ token, userId: userId!, imageUrls, caption });
  if (!r.ok) return fail(r.error, r.retryable);
  await batch(db, [
    { sql: "UPDATE content_posts SET status = 'posted', posted_at = ?, external_id = ?, url = ?, error = NULL WHERE id = ?", args: [stamp, r.value.id, r.value.permalink ?? null, due.id] },
    repo.auditStmt("system", "ig.posted", `content:${due.id}`, r.value.id),
  ]);
  return { status: "posted", detail: `投稿しました（${r.value.id}）` };
}
