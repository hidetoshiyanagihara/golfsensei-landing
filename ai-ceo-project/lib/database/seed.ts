import type { InStatement } from "@libsql/client";
import { AGENTS, AGENT_DEFAULT_MODEL } from "../ai/agents";
import { LAUNCH_DRAFTS } from "../marketing/launch-kit";
import { addDays } from "../time";
import { batch, get, type DB } from "./db";

/**
 * 最初から入れておく「実際の計画・設定」。何度実行しても重複しない（INSERT OR IGNORE）。
 * ここには架空の売上・顧客・口コミを入れない。サンプルは scripts/seed-sample.ts で、data_kind='sample' として入れる。
 */

export const DEFAULT_SETTINGS: Record<string, string> = {
  project_start_date: "2026-11-21",
  monthly_budget_jpy: "30000", // 月間運営予算の上限（PART 1：10,000〜30,000円）
  budget_warn_ratio: "0.8", // 予算の80%で警告
  ai_api_monthly_cap_jpy: "10000", // AI API の月間上限（この金額に達したらAIは自動停止）
  usd_jpy: "155", // 円換算レート（設定値。実際のレートと請求額で定期的に見直す）
  automation_enabled: "false", // AIの自動実行。代表者がONにするまで動かない
  // note の手数料（公式ヘルプ「コンテンツを販売する際に引かれる手数料」記載の料率。変わることがあるので販売前に再確認）
  note_card_fee_rate: "0.05", // 事務手数料（クレジットカード決済）
  note_platform_fee_rate: "0.10", // プラットフォーム利用料（有料記事。事務手数料を引いた額にかかる）
  note_payout_fee_jpy: "270", // 振込手数料（1回ごと）
};

export const STARTER_KIT_COMPONENTS = [
  "AI営業リサーチシステム",
  "AI営業トーク作成テンプレート",
  "AIメール作成テンプレート",
  "AI商談議事録作成システム",
  "AI提案書作成テンプレート",
  "Claude Code業務自動化スターターキット",
];

export const DEFAULT_QA_CHECKLIST = [
  { key: "accuracy", label: "誤情報がない（事実・数字に根拠がある）", done: false },
  { key: "clarity", label: "初めての人が読んで分かる", done: false },
  { key: "usable", label: "実際に使って動作・成果を確認した", done: false },
  { key: "solves", label: "顧客の問題を解決できる", done: false },
  { key: "rights", label: "著作権・商標権に問題がない（他社教材のコピーがない）", done: false },
  { key: "claims", label: "販売ページに誇大表現・架空の実績・口コミがない", done: false },
];

const STARTER_KIT = "中小企業向け AI営業自動化スターターキット";

export async function seedBase(db: DB): Promise<void> {
  const s: InStatement[] = [];
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) s.push({ sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", args: [k, v] });

  // 名前・説明は最新の定義で更新する（状態 status は変えない）
  const biz = `INSERT INTO businesses (id, name, kind, description, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, description = excluded.description`;
  s.push({ sql: biz, args: ["ai-business-lab", "AI BUSINESS LAB", "デジタル商品", "中小企業・個人事業主向けのAI営業・業務自動化商品の販売（販売先：note）", "preparing"] });
  s.push({ sql: biz, args: ["ai-ceo-project", "AI CEO PROJECT（発信）", "SNS・note", "代表の新しい発信アカウント（発信名：HIDE／X・note・Instagram・YouTube）", "preparing"] });
  s.push({ sql: biz, args: ["axion-sales", "AXION SALES", "営業代行", "既存事業。SNS自動投稿・フォーム営業が稼働中（axion-autopost / form_sender）", "active"] });
  s.push({ sql: biz, args: ["copipe-ai", "コピペAI仕事術", "Instagramメディア", "既存の Instagram 育成プロジェクト（ig-growth）", "active"] });

  AGENTS.forEach((a, i) =>
    s.push({
      sql: `INSERT OR IGNORE INTO agents (id, name, title, role, responsibilities, model, status, monthly_cap_jpy, sort)
            VALUES (?, ?, ?, ?, ?, ?, 'not_connected', ?, ?)`,
      args: [a.id, a.name, a.title, a.role, JSON.stringify(a.responsibilities), AGENT_DEFAULT_MODEL, a.monthlyCapJpy, i],
    }),
  );

  // 新アカウントの最初の下書き（承認制。投稿は代表者が行う）。
  // 開設キットを直したときは、まだ「下書き」のものだけ新しい文章に差し替える（承認・投稿済みのものは変えない）
  const start = DEFAULT_SETTINGS.project_start_date;
  for (const d of LAUNCH_DRAFTS) {
    s.push({
      sql: `INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, source, source_ref, data_kind)
            VALUES ('ai-ceo-project', ?, 'draft', ?, ?, ?, 'launch-kit', ?, 'actual')
            ON CONFLICT(source_ref) DO UPDATE SET title = excluded.title, body = excluded.body
            WHERE content_posts.status = 'draft' AND (content_posts.body <> excluded.body OR content_posts.title <> excluded.title)`,
      args: [d.platform, d.title, d.body, addDays(start, d.dayOffset + 1), d.ref],
    });
  }
  await batch(db, s);

  if (!(await get(db, "SELECT 1 FROM business_ideas WHERE name = ?", [STARTER_KIT]))) {
    await batch(db, [
      {
        sql: `INSERT INTO business_ideas (business_id, name, target, problem, price_hypothesis, revenue_model,
                evaluation_note, origin, approval_status, decided_at, data_kind)
              VALUES ('ai-business-lab', ?, ?, ?, ?, ?, ?, 'owner', 'approved', datetime('now'), 'actual')`,
        args: [
          STARTER_KIT,
          "中小企業・個人事業主（営業を少人数で回している会社）",
          "営業リサーチ・トーク作成・メール・議事録・提案書づくりに時間がかかる",
          "4,980円（仮）",
          "note の有料記事（買い切り）",
          "代表者の方針で最初の商品に決定。市場調査（競合・価格・需要）は未実施のため、評価点は未入力。",
        ],
      },
      {
        sql: `INSERT INTO products (business_id, idea_id, name, description, price_jpy, price_is_tentative,
                components, qa_checklist, sales_channel, data_kind)
              VALUES ('ai-business-lab', last_insert_rowid(), ?, ?, 4980, 1, ?, ?, 'note（有料記事）', 'actual')`,
        args: [
          STARTER_KIT,
          "営業の調査・トーク・メール・議事録・提案書をAIで効率化する、実際に使えるテンプレートと手順書のセット",
          JSON.stringify(STARTER_KIT_COMPONENTS.map((name) => ({ name, status: "planning" }))),
          JSON.stringify(DEFAULT_QA_CHECKLIST),
        ],
      },
    ]);
  }

  if (!(await get(db, "SELECT 1 FROM goals LIMIT 1"))) {
    const d30 = "2026-12-21";
    const d90 = "2027-02-19";
    const goals: [string, string, string, number | null, string][] = [
      ["30d", "商品1つ完成（品質検査に合格）", "products_qa_passed", 1, d30],
      ["30d", "販売ページ1つ完成", "sales_pages", 1, d30],
      ["30d", "AI CEO PROJECT のSNSアカウント運営開始", "", null, d30],
      ["30d", "最初の購入者を獲得", "sales_count", 1, d30],
      ["90d", "売れる商品を特定する", "", null, d90],
      ["90d", "商品を2〜3種類に拡張", "products_on_sale", 2, d90],
      ["90d", "月商10〜30万円を検証（目標値・実績ではない）", "monthly_net_sales", 100000, d90],
      ["90d", "次の収益事業の候補を発見", "ideas", 1, d90],
    ];
    await batch(
      db,
      goals.map((g, i) => ({
        sql: "INSERT INTO goals (horizon, title, metric, target_value, deadline, sort) VALUES (?, ?, ?, ?, ?, ?)",
        args: [...g, i + 1],
      })),
    );
  }
}
