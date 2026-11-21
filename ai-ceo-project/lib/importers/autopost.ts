import fs from "node:fs";
import path from "node:path";
import type { DB } from "../database/db";

/**
 * 既存の SNS 自動投稿（../axion-autopost/posts/YYYY-MM-DD.json）の結果を「実データ」として取り込む。
 * 読むだけで、元のファイルは変更しない。同じ投稿は source_ref で重複しない（再実行しても安全）。
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
      source_ref: `axion-autopost:${date}:${platform}`,
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

export function importAutopost(db: DB, postsDir: string): { files: number; inserted: number; updated: number } {
  if (!fs.existsSync(postsDir)) return { files: 0, inserted: 0, updated: 0 };
  const files = fs.readdirSync(postsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const upsert = db.prepare(`
    INSERT INTO content_posts (business_id, platform, status, title, body, posted_at, external_id, url, error, source, source_ref, data_kind)
    VALUES ('axion-sales', @platform, @status, @title, @body, @posted_at, @external_id, @url, @error, 'axion-autopost', @source_ref, 'actual')
    ON CONFLICT(source_ref) DO UPDATE SET status = excluded.status, external_id = excluded.external_id,
      url = excluded.url, error = excluded.error, title = excluded.title, body = excluded.body`);
  const exists = db.prepare("SELECT 1 FROM content_posts WHERE source_ref = ?");
  let inserted = 0,
    updated = 0;
  db.transaction(() => {
    for (const f of files) {
      let data: PostFile;
      try {
        data = JSON.parse(fs.readFileSync(path.join(postsDir, f), "utf8"));
      } catch {
        continue; // 壊れたファイルは飛ばす
      }
      for (const p of parsePostFile(f.slice(0, 10), data)) {
        if (exists.get(p.source_ref)) updated++;
        else inserted++;
        upsert.run(p);
      }
    }
    db.prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES ('system', 'import.autopost', ?, ?)").run(
      postsDir,
      JSON.stringify({ files: files.length, inserted, updated }),
    );
  })();
  return { files: files.length, inserted, updated };
}
