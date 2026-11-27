import crypto from "node:crypto";
import zlib from "node:zlib";
import { all, type DB } from "../database/db";

/**
 * データベースのバックアップ（全テーブル）。
 * - 中身は gzip で縮めてから AES-256-GCM で暗号化する。鍵はデータベースの合鍵（TURSO_AUTH_TOKEN）から作る。
 *   ＝バックアップのファイルを誰かが手に入れても、合鍵がなければ読めない。
 * - 合鍵を作り直したら、それより前のバックアップを開くには古い合鍵が必要。
 */
export type Cell = string | number | null | { b64: string };
export type Dump = {
  format: "ai-ceo-backup/1";
  createdAt: string;
  tables: { name: string; sql: string; columns: string[]; rows: Cell[][] }[];
  indexes: string[];
};

const MAGIC = Buffer.from("CCBK1");

function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof ArrayBuffer) return { b64: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v)) return { b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  return String(v);
}

export async function dumpDb(db: DB, now = new Date()): Promise<Dump> {
  const objs = await all<{ type: string; name: string; sql: string | null }>(
    db,
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
  );
  const tables: Dump["tables"] = [];
  for (const t of objs.filter((o) => o.type === "table")) {
    const rs = await db.execute(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`);
    tables.push({ name: t.name, sql: t.sql!, columns: rs.columns, rows: rs.rows.map((r) => rs.columns.map((_, i) => cell(r[i]))) });
  }
  return { format: "ai-ceo-backup/1", createdAt: now.toISOString(), tables, indexes: objs.filter((o) => o.type === "index").map((o) => o.sql!) };
}

const keyFrom = (secret: string) => crypto.createHash("sha256").update(`backup:v1:${secret}`).digest();

export function encryptDump(dump: Dump, secret: string): Buffer {
  if (!secret) throw new Error("暗号化の鍵（TURSO_AUTH_TOKEN）がありません");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(dump)))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function decryptDump(file: Buffer, secret: string): Dump {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("バックアップのファイルではありません");
  const iv = file.subarray(5, 17), tag = file.subarray(17, 33), body = file.subarray(33);
  const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  d.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error("開けませんでした（合鍵が違うか、ファイルが壊れています）");
  }
  const dump = JSON.parse(zlib.gunzipSync(plain).toString("utf8")) as Dump;
  if (dump.format !== "ai-ceo-backup/1") throw new Error("形式が違います");
  return dump;
}

/** 空のデータベースにバックアップを書き戻す（復旧・復旧テスト用）。書き戻した各テーブルの行数を返す */
export async function restoreDump(target: DB, dump: Dump): Promise<Record<string, number>> {
  const existing = await all(target, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1");
  if (existing.length) throw new Error("書き戻し先が空ではありません（上書き事故を防ぐため、空のデータベースにだけ書き戻します）");
  await target.execute("PRAGMA foreign_keys = OFF");
  const counts: Record<string, number> = {};
  for (const t of dump.tables) {
    await target.execute(t.sql);
    const cols = t.columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    const ph = t.columns.map(() => "?").join(", ");
    const sql = `INSERT INTO "${t.name.replace(/"/g, '""')}" (${cols}) VALUES (${ph})`;
    for (let i = 0; i < t.rows.length; i += 200) {
      const chunk = t.rows.slice(i, i + 200).map((r) => ({
        sql,
        args: r.map((v) => (v && typeof v === "object" ? Buffer.from(v.b64, "base64") : v)),
      }));
      await target.batch(chunk, "write");
    }
    const n = await all<{ n: number }>(target, `SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`);
    counts[t.name] = Number(n[0].n);
  }
  for (const ix of dump.indexes) await target.execute(ix);
  await target.execute("PRAGMA foreign_keys = ON");
  return counts;
}
