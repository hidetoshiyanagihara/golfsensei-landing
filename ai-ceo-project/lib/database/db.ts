import type { Client, InArgs, InStatement } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema";
import { seedBase } from "./seed";

/**
 * データベース接続（libSQL）。
 * - パソコン：data/command-center.db（SQLite ファイル）
 * - スマホから使う本番：Turso（TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を設定）
 * どちらも同じ SQL で動く。
 */
export type DB = Client;
export type Row = Record<string, unknown>;

function resolveUrl(): { url: string; authToken?: string } {
  if (process.env.TURSO_DATABASE_URL) {
    return { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  const env = process.env.DB_PATH;
  if (env === ":memory:") return { url: ":memory:" };
  const file = env ? path.resolve(/*turbopackIgnore: true*/ env) : path.join(process.cwd(), "data", "command-center.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { url: `file:${file}` };
}

/** 新しく接続し、マイグレーションと初期データの登録まで行う */
export async function openDb(url?: string): Promise<DB> {
  const conf = url ? { url } : resolveUrl();
  // 本番（Turso）は HTTP だけで通信する軽い版を使う（ネイティブのモジュールを読み込まない）
  const remote = /^(libsql|https?|wss?):/.test(conf.url);
  const { createClient } = remote ? await import("@libsql/client/web") : await import("@libsql/client");
  const db = createClient(conf);
  if (conf.url.startsWith("file:")) {
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA busy_timeout = 5000");
  }
  await db.execute("PRAGMA foreign_keys = ON");
  await migrate(db);
  await seedBase(db);
  return db;
}

export async function migrate(db: DB): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set((await all<{ version: number }>(db, "SELECT version FROM schema_migrations")).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // 1つのマイグレーションは全部成功するか、全部取り消す（batch はリモートでも1つのトランザクション）
    await db.batch(
      [...splitSql(m.sql), { sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)", args: [m.version, m.name] }],
      "write",
    );
  }
}

/** マイグレーションの SQL を1文ずつに分ける（-- のコメント行を除き、行末の ; で区切る） */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// 1つのプロセス（サーバー）で接続を使い回す
const g = globalThis as unknown as { __ccDb?: Promise<DB> };

export function getDb(): Promise<DB> {
  if (!g.__ccDb) {
    g.__ccDb = openDb()
      .then(async (db) => {
        // APIキーの有無に合わせて AI社員の「未接続／待機中」を切り替える
        const { syncAgentConnection } = await import("../ai/runner");
        await syncAgentConnection(db);
        return db;
      })
      .catch((e) => {
      g.__ccDb = undefined; // 失敗したら次のリクエストでやり直す
      throw e;
    });
  }
  return g.__ccDb;
}

// ---------- 小さな補助関数 ----------
function toObj(columns: string[], row: ArrayLike<unknown>): Row {
  const o: Row = {};
  columns.forEach((c, i) => (o[c] = row[i]));
  return o;
}

export async function all<T = Row>(db: DB, sql: string, args: InArgs = []): Promise<T[]> {
  const rs = await db.execute({ sql, args });
  return rs.rows.map((r) => toObj(rs.columns, r) as T);
}

export async function get<T = Row>(db: DB, sql: string, args: InArgs = []): Promise<T | undefined> {
  return (await all<T>(db, sql, args))[0];
}

export async function run(db: DB, sql: string, args: InArgs = []): Promise<{ changes: number; lastId: number }> {
  const rs = await db.execute({ sql, args });
  return { changes: rs.rowsAffected, lastId: Number(rs.lastInsertRowid ?? 0) };
}

/** 複数の書き込みをまとめて実行（全部成功するか、全部取り消す） */
export async function batch(db: DB, stmts: InStatement[]): Promise<void> {
  if (stmts.length) await db.batch(stmts, "write");
}
