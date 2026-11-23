import { batch, get, run, type DB } from "../database/db";
import * as repo from "../database/repo";
import { parseExtra, type Slide } from "../marketing/note-format";
import { shortDescription, shortTitle, type ShortMeta, type YtResult } from "../social/youtube";
import { jstStamp } from "./publisher";

/**
 * YouTube ショートの自動投稿（AI CEO PROJECT／HIDE）。
 * Instagram に投稿済みのカルーセル（＝代表者が承認・予約したもの）を、縦長の動画にして同じ内容をショートに出す。
 * 新しい文章は作らない。1回の実行で1本まで・1日の上限・前回から3時間以上あける。
 * 動画づくりは GitHub Actions（ffmpeg が入っている）で動かす：scripts/youtube-shorts.ts
 */
export const YT_DAILY_LIMIT_DEFAULT = 2;
export const YT_MIN_INTERVAL_MIN = 180;
/** Instagram に出てから何日以内のものをショートにするか（古いものを掘り起こさない） */
export const YT_LOOKBACK_DAYS = 7;

export type ShortSource = { id: number; title: string; body: string; slides: Slide[] };

export function sourceRef(igId: number): string {
  return `yt-short:ig:${igId}`;
}

/** 次にショートにする Instagram 投稿（なければ null） */
export async function nextShortSource(db: DB, now = new Date()): Promise<ShortSource | null> {
  const since = jstStamp(new Date(now.getTime() - YT_LOOKBACK_DAYS * 86_400_000));
  const rows = await db.execute({
    sql: `SELECT c.id, c.title, c.body, c.extra FROM content_posts c
          WHERE c.platform = 'instagram' AND c.business_id = 'ai-ceo-project' AND c.status = 'posted' AND c.data_kind = 'actual'
            AND c.posted_at >= ?
            AND NOT EXISTS (SELECT 1 FROM content_posts y WHERE y.source_ref = 'yt-short:ig:' || c.id)
          ORDER BY c.posted_at, c.id LIMIT 5`,
    args: [since],
  });
  for (const r of rows.rows) {
    const slides = parseExtra((r.extra as string | null) ?? null).slides ?? [];
    if (slides.length >= 2) return { id: Number(r.id), title: String(r.title), body: String(r.body), slides };
  }
  return null;
}

export type MakeVideo = (slides: Slide[]) => Promise<Uint8Array>;
export type Upload = (video: Uint8Array, meta: ShortMeta) => Promise<YtResult<string>>;

export async function publishNextShort(
  db: DB,
  deps: { makeVideo: MakeVideo; upload: Upload; privacy?: ShortMeta["privacy"]; dryRun?: boolean },
  now = new Date(),
): Promise<{ status: string; detail: string; videoBytes?: number }> {
  const settings = await repo.getSettings(db);
  if (settings.yt_autopost_enabled === "false") return { status: "disabled", detail: "YouTube の自動投稿はOFFです" };
  const stamp = jstStamp(now);
  const limit = repo.num(settings, "yt_daily_limit", YT_DAILY_LIMIT_DEFAULT);
  const today = await get<{ n: number; last: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(posted_at) AS last FROM content_posts
     WHERE platform = 'youtube' AND business_id = 'ai-ceo-project' AND source = 'auto-short' AND status = 'posted' AND substr(posted_at, 1, 10) = ?`,
    [stamp.slice(0, 10)],
  );
  if (!deps.dryRun) {
    if (Number(today?.n ?? 0) >= limit) return { status: "limited", detail: `今日はすでに ${limit}本 投稿しました` };
    if (today?.last && today.last.length >= 16) {
      const mins = (Date.parse(stamp.replace(" ", "T") + ":00+09:00") - Date.parse(today.last.replace(" ", "T") + ":00+09:00")) / 60000;
      if (mins < YT_MIN_INTERVAL_MIN) return { status: "limited", detail: "前回の投稿から3時間たっていません" };
    }
  }
  const src = await nextShortSource(db, now);
  if (!src) return { status: "nothing_due", detail: "ショートにする Instagram 投稿はありません" };

  const meta: ShortMeta = { title: shortTitle(src.slides[0].heading), description: shortDescription(src.body), privacy: deps.privacy ?? "public" };
  if (deps.dryRun) {
    const video = await deps.makeVideo(src.slides);
    return { status: "dry_run", detail: `動画を作りました（投稿はしていません）：${meta.title}`, videoBytes: video.byteLength };
  }

  // 先に「投稿中」の行を作って、同じ投稿を二重に出さないようにする（source_ref は重複できない）
  const claimed = await run(
    db,
    `INSERT OR IGNORE INTO content_posts (business_id, platform, status, title, body, scheduled_at, source, source_ref, data_kind)
     VALUES ('ai-ceo-project', 'youtube', 'posting', ?, ?, ?, 'auto-short', ?, 'actual')`,
    [meta.title, meta.description, stamp.slice(0, 10), sourceRef(src.id)],
  );
  if (claimed.changes !== 1) return { status: "nothing_due", detail: "別の実行が処理中です" };
  const fail = async (error: string) => {
    await batch(db, [
      { sql: "UPDATE content_posts SET status = 'failed', error = ? WHERE source_ref = ?", args: [error.slice(0, 500), sourceRef(src.id)] },
      repo.auditStmt("system", "yt.post_failed", `content:${src.id}`, error.slice(0, 500)),
    ]);
    return { status: "failed", detail: error };
  };
  let video: Uint8Array;
  try {
    video = await deps.makeVideo(src.slides);
  } catch (e) {
    return fail(`動画を作れませんでした：${e instanceof Error ? e.message : String(e)}`);
  }
  const r = await deps.upload(video, meta);
  if (!r.ok) return fail(r.error);
  await batch(db, [
    {
      sql: "UPDATE content_posts SET status = 'posted', posted_at = ?, external_id = ?, url = ?, error = NULL WHERE source_ref = ?",
      args: [stamp, r.value, `https://www.youtube.com/shorts/${r.value}`, sourceRef(src.id)],
    },
    repo.auditStmt("system", "yt.posted", `content:${src.id}`, r.value),
  ]);
  return { status: "posted", detail: `投稿しました（https://www.youtube.com/shorts/${r.value}）`, videoBytes: video.byteLength };
}
