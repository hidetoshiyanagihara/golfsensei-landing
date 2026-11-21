/**
 * データベース定義（SQLite）。
 *
 * 全テーブル共通のルール：
 * - data_kind で「実データ（actual）」「サンプル（sample）」「予測（forecast）」を必ず区別する。
 *   画面は既定で actual だけを集計し、sample は明示的に表示ONにしたときだけ混ぜる。
 * - 金額はすべて「円・整数」で保存する（小数の誤差を避けるため）。
 * - 顧客の個人情報（氏名・メールなど）は PHASE 1 では保存しない。
 *
 * 変更するときは MIGRATIONS の末尾に追記する（既存の番号は書き換えない）。
 */

export const DATA_KINDS = ["actual", "sample", "forecast"] as const;
export type DataKind = (typeof DATA_KINDS)[number];

const DK = `data_kind TEXT NOT NULL DEFAULT 'actual' CHECK (data_kind IN ('actual','sample','forecast'))`;

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','preparing','paused','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected','idle','running','paused','error')),
  monthly_cap_jpy INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

-- AIの実行履歴。AIの「判断（ai_output）」と「実際に行われた結果（execution_result）」を分けて保存する
CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','error','skipped','blocked_budget')),
  trigger TEXT NOT NULL DEFAULT 'manual',
  summary TEXT NOT NULL DEFAULT '',
  ai_output TEXT,
  execution_result TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_jpy INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at);

CREATE TABLE business_ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT REFERENCES businesses(id),
  name TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  competitors TEXT NOT NULL DEFAULT '',
  price_hypothesis TEXT NOT NULL DEFAULT '',
  revenue_model TEXT NOT NULL DEFAULT '',
  dev_cost_note TEXT NOT NULL DEFAULT '',
  expected_profit_note TEXT NOT NULL DEFAULT '',
  risks TEXT NOT NULL DEFAULT '',
  -- 評価（0〜100）。未評価は NULL。根拠がないまま点数を入れない
  score_demand INTEGER, score_competition INTEGER, score_price INTEGER, score_profit INTEGER,
  score_difficulty INTEGER, score_acquisition INTEGER, score_recurrence INTEGER,
  total_score INTEGER,
  evaluation_note TEXT NOT NULL DEFAULT '',
  -- 情報源 [{title,url,accessed_at,kind:'fact'|'estimate'}]
  sources TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL CHECK (origin IN ('owner','ai')),
  approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected','on_hold')),
  decided_at TEXT,
  ${DK},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT REFERENCES businesses(id),
  idea_id INTEGER REFERENCES business_ideas(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_jpy INTEGER NOT NULL DEFAULT 0,
  price_is_tentative INTEGER NOT NULL DEFAULT 1,
  production_status TEXT NOT NULL DEFAULT 'planning'
    CHECK (production_status IN ('planning','producing','review','done')),
  qa_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (qa_status IN ('not_started','in_progress','passed','failed')),
  sales_status TEXT NOT NULL DEFAULT 'not_for_sale'
    CHECK (sales_status IN ('not_for_sale','ready','on_sale','stopped')),
  components TEXT NOT NULL DEFAULT '[]',
  qa_checklist TEXT NOT NULL DEFAULT '[]',
  sales_channel TEXT NOT NULL DEFAULT '',
  owner_approved_at TEXT,
  ${DK},
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 売上。gross（売上総額）・refund（返金）・payment_fee（決済手数料）を分けて保存する
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  sold_at TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  gross_jpy INTEGER NOT NULL CHECK (gross_jpy >= 0),
  payment_fee_jpy INTEGER NOT NULL DEFAULT 0 CHECK (payment_fee_jpy >= 0),
  refund_jpy INTEGER NOT NULL DEFAULT 0 CHECK (refund_jpy >= 0),
  channel TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  ${DK},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_date ON sales(sold_at);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spent_at TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN
    ('ai_api','tool','payment_fee','outsourcing','advertising','tax','other')),
  vendor TEXT NOT NULL DEFAULT '',
  amount_jpy INTEGER NOT NULL CHECK (amount_jpy >= 0),
  note TEXT NOT NULL DEFAULT '',
  ${DK},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_date ON expenses(spent_at);

CREATE TABLE content_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT REFERENCES businesses(id),
  platform TEXT NOT NULL CHECK (platform IN ('x','instagram','youtube','note','linkedin','other')),
  status TEXT NOT NULL CHECK (status IN
    ('draft','pending_approval','approved','scheduled','posted','failed','skipped')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  posted_at TEXT,
  external_id TEXT,
  url TEXT,
  views INTEGER,
  engagements INTEGER,
  follower_delta INTEGER,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT UNIQUE,
  ${DK},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_content_date ON content_posts(posted_at, scheduled_at);

-- フォロワー数・記事閲覧数などの時系列
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  ${DK},
  UNIQUE (metric, platform, date, data_kind)
);

-- 問い合わせ。個人情報は保存せず、分類と要約だけを残す
CREATE TABLE inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('purchase','usage','bug','refund','partnership','other')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','needs_owner','closed')),
  summary TEXT NOT NULL DEFAULT '',
  ${DK}
);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horizon TEXT NOT NULL CHECK (horizon IN ('30d','90d')),
  title TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT '',
  target_value REAL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','achieved','missed')),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT 'owner',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('meeting','daily','weekly','monthly')),
  period TEXT NOT NULL,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('rule','ai')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 重要操作のログ
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
];
