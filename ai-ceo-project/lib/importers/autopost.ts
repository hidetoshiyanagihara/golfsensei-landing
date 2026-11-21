import fs from "node:fs";
import path from "node:path";
import type { DB } from "../database/db";
import { auditStmt } from "../database/repo";
import { addDays, jstDate } from "../time";

/**
 * 既存の SNS 自動投稿（axion-autopost/posts/YYYY-MM-DD.json）の結果を「実データ」として取り込む。
 * 元のファイルは変更しない。同じ投稿は source_ref で重複しない（再実行しても安全）。
 *   - パソコン：リポジトリ内のファイルを読む（importAutopostDir）
 *   - スマホ用の本番：GitHub の公開ファイルを読む（importAutopostFromGitHub）
 */

type PostFile = {
  theme?: string;
  image_title?: string;
  x?: string;
  instagram?: string;
  results?: Record<string, string>;
};

export type ImportedPost = {
  platform: "x" | "instagram" | "youtube" | "linkedin";
  status: "posted" | "failed" | "skipped";
  title: string;
  body: string;
  posted_at: string;
  external_id: string | null;
  url: string | null;
  error: string | null;
  source_ref: string;
};

const PLATFORMS = ["x", "instagram", "youtube", "linkedin"] as const;
export const AUTOPOST_FIRST_DATE = "2026-10-23";
export const AUTOPOST_SOURCE = "axion-autopost";
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com/hidetoshiyanagihara/golfsensei-landing/main/axion-autopost/posts";

export function parsePostFile(date: string, data: PostFile): ImportedPost[] {
  const out: ImportedPost[] = [];
  const results = data.results ?? {};
  for (const platform of PLATFORMS) {
    const r = results[platform];
    if (typeof r !== "string") continue;
    let status: ImportedPost["status"];
    let external_id: string | null = null;
    let error: string | null = null;
    if (r.startsWith("ok:")) {
      status = "posted";
      external_id = r.slice(3);
    } else if (r.startsWith("error")) {
      status = "failed";
      error = r.replace(/^error:?\s*/, "").slice(0, 500);
    } else {
      status = "skipped";
    }
    const body = platform === "x" ? data.x ?? "" : platform === "instagram" ? data.instagram ?? "" : data.image_title ?? "";
    out.push({
      platform,
      status,
      title: data.theme ?? data.image_title ?? "",
      body,
      posted_at: date,
      external_id,
      url: external_id ? publicUrl(platform, external_id) : null,
      error,
      source_ref: `${AUTOPOST_SOURCE}:${date}:${platform}`,
    });
  }
  return out;
}

function publicUrl(platform: string, id: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  if (platform === "x") return `https://x.com/i/web/status/${id}`;
  if (platform === "youtube") return `https://www.youtube.com/shorts/${id}`;
  return null; // Instagram のメディアIDからは公開URLを作れない
}

export type ImportResult = { files: number; inserted: number; updated: number };

export async function importPosts(db: DB, files: { date: string; data: PostFile }[], from: string): Promise<ImportResult> {
  const refs = files.flatMap((f) => parsePostFile(f.date, f.data));
  const existing = new Set<string>();
  for (let i = 0; i < refs.length; i += 200) {
    const chunk = refs.slice(i, i + 200).map((r) => r.source_ref);
    const rs = await db.execute({ sql: `SELECT source_ref FROM content_posts WHERE source_ref IN (${chunk.map(() => "?").join(",")})`, args: chunk });
    for (const r of rs.rows) existing.add(String(r.source_ref));
  }
  const updated = refs.filter((r) => existing.has(r.source_ref)).length;
  const result = { files: files.length, inserted: refs.length - updated, updated };
  await db.batch(
    [
      ...refs.map((p) => ({
        sql: `INSERT INTO content_posts (business_id, platform, status, title, body, posted_at, external_id, url, error, source, source_ref, data_kind)
              VALUES ('axion-sales', ?, ?, ?, ?, ?, ?, ?, ?, '${AUTOPOST_SOURCE}', ?, 'actual')
              ON CONFLICT(source_ref) DO UPDATE SET status = excluded.status, external_id = excluded.external_id,
                url = excluded.url, error = excluded.error, title = excluded.title, body = excluded.body`,
        args: [p.platform, p.status, p.title, p.body, p.posted_at, p.external_id, p.url, p.error, p.source_ref],
      })),
      auditStmt("system", "import.autopost", from, result),
    ],
    "write",
  );
  return result;
}

export async function importAutopostDir(db: DB, postsDir: string): Promise<ImportResult> {
  if (!fs.existsSync(postsDir)) return { files: 0, inserted: 0, updated: 0 };
  const files: { date: string; data: PostFile }[] = [];
  for (const f of fs.readdirSync(postsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    try {
      files.push({ date: f.slice(0, 10), data: JSON.parse(fs.readFileSync(path.join(postsDir, f), "utf8")) });
    } catch {
      // 壊れたファイルは飛ばす
    }
  }
  return importPosts(db, files, postsDir);
}

/**
 * GitHub の公開ファイルから取り込む。最後に取り込んだ日の2日前から今日までだけを読む（差分）。
 * 読むだけ（GET）で、こちらから送る情報はない。
 */
export async function importAutopostFromGitHub(
  db: DB,
  opts: { since: string | null; today?: string; base?: string; fetchImpl?: typeof fetch; maxDays?: number } ,
): Promise<ImportResult & { checkedDays: number }> {
  const base = opts.base ?? process.env.AUTOPOST_RAW_BASE ?? DEFAULT_RAW_BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const today = opts.today ?? jstDate();
  let d = opts.since ? addDays(opts.since, -2) : AUTOPOST_FIRST_DATE;
  if (d < AUTOPOST_FIRST_DATE) d = AUTOPOST_FIRST_DATE;
  const dates: string[] = [];
  while (d <= today && dates.length < (opts.maxDays ?? 120)) {
    dates.push(d);
    d = addDays(d, 1);
  }
  const files: { date: string; data: PostFile }[] = [];
  // 同時に読みすぎないよう、6件ずつ
  for (let i = 0; i < dates.length; i += 6) {
    const got = await Promise.all(
      dates.slice(i, i + 6).map(async (date) => {
        try {
          const r = await doFetch(`${base}/${date}.json`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
          if (!r.ok) return null; // その日の投稿がない（404）など
          return { date, data: (await r.json()) as PostFile };
        } catch {
          return null;
        }
      }),
    );
    for (const g of got) if (g) files.push(g);
  }
  const res = await importPosts(db, files, base);
  return { ...res, checkedDays: dates.length };
}
