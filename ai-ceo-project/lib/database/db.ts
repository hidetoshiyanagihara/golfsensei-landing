import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema";
import { seedBase } from "./seed";

export type DB = Database.Database;

function resolveDbPath(): string {
  const env = process.env.DB_PATH;
  if (!env) return path.join(process.cwd(), "data", "command-center.db");
  return env === ":memory:" ? env : path.resolve(/*turbopackIgnore: true*/ env);
}

export function openDb(dbPath = resolveDbPath()): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  seedBase(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
    })();
  }
}

// 開発中のホットリロードで接続が増えないよう、プロセス内で1つだけ使う
const g = globalThis as unknown as { __ccDb?: DB };

export function getDb(): DB {
  if (!g.__ccDb) g.__ccDb = openDb();
  return g.__ccDb;
}
