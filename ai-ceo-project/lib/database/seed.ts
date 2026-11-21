import type Database from "better-sqlite3";
import { AGENTS, AGENT_DEFAULT_MODEL } from "../ai/agents";

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

export function seedBase(db: Database.Database): void {
  const tx = db.transaction(() => {
    const setting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setting.run(k, v);

    const biz = db.prepare(
      "INSERT OR IGNORE INTO businesses (id, name, kind, description, status) VALUES (?, ?, ?, ?, ?)",
    );
    biz.run("ai-business-lab", "AI BUSINESS LAB", "デジタル商品", "中小企業・個人事業主向けのAI営業・業務自動化商品の販売", "preparing");
    biz.run("axion-sales", "AXION SALES", "営業代行", "既存事業。SNS自動投稿・フォーム営業が稼働中（axion-autopost / form_sender）", "active");
    biz.run("copipe-ai", "コピペAI仕事術", "Instagramメディア", "既存の Instagram 育成プロジェクト（ig-growth）", "active");

    const agent = db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, title, role, responsibilities, model, status, monthly_cap_jpy, sort)
       VALUES (?, ?, ?, ?, ?, ?, 'not_connected', ?, ?)`,
    );
    AGENTS.forEach((a, i) =>
      agent.run(a.id, a.name, a.title, a.role, JSON.stringify(a.responsibilities), AGENT_DEFAULT_MODEL, a.monthlyCapJpy, i),
    );

    const hasIdea = db.prepare("SELECT 1 FROM business_ideas WHERE name = ?").get("中小企業向け AI営業自動化スターターキット");
    if (!hasIdea) {
      const idea = db
        .prepare(
          `INSERT INTO business_ideas (business_id, name, target, problem, price_hypothesis, revenue_model,
             evaluation_note, origin, approval_status, decided_at, data_kind)
           VALUES ('ai-business-lab', ?, ?, ?, ?, ?, ?, 'owner', 'approved', datetime('now'), 'actual')`,
        )
        .run(
          "中小企業向け AI営業自動化スターターキット",
          "中小企業・個人事業主（営業を少人数で回している会社）",
          "営業リサーチ・トーク作成・メール・議事録・提案書づくりに時間がかかる",
          "4,980円（仮）",
          "デジタル商品の買い切り販売（note など）",
          "代表者の方針で最初の商品に決定。市場調査（競合・価格・需要）は未実施のため、評価点は未入力。",
        );
      db.prepare(
        `INSERT INTO products (business_id, idea_id, name, description, price_jpy, price_is_tentative,
           components, qa_checklist, sales_channel, data_kind)
         VALUES ('ai-business-lab', ?, ?, ?, 4980, 1, ?, ?, 'note（予定）', 'actual')`,
      ).run(
        idea.lastInsertRowid,
        "中小企業向け AI営業自動化スターターキット",
        "営業の調査・トーク・メール・議事録・提案書をAIで効率化する、実際に使えるテンプレートと手順書のセット",
        JSON.stringify(STARTER_KIT_COMPONENTS.map((name) => ({ name, status: "planning" }))),
        JSON.stringify(DEFAULT_QA_CHECKLIST),
      );
    }

    const hasGoals = db.prepare("SELECT 1 FROM goals LIMIT 1").get();
    if (!hasGoals) {
      const goal = db.prepare("INSERT INTO goals (horizon, title, metric, target_value, deadline, sort) VALUES (?, ?, ?, ?, ?, ?)");
      const d30 = "2026-12-21";
      const d90 = "2027-02-19";
      goal.run("30d", "商品1つ完成（品質検査に合格）", "products_qa_passed", 1, d30, 1);
      goal.run("30d", "販売ページ1つ完成", "sales_pages", 1, d30, 2);
      goal.run("30d", "AI CEO PROJECT のSNSアカウント運営開始", "", null, d30, 3);
      goal.run("30d", "最初の購入者を獲得", "sales_count", 1, d30, 4);
      goal.run("90d", "売れる商品を特定する", "", null, d90, 5);
      goal.run("90d", "商品を2〜3種類に拡張", "products_on_sale", 2, d90, 6);
      goal.run("90d", "月商10〜30万円を検証（目標値・実績ではない）", "monthly_net_sales", 100000, d90, 7);
      goal.run("90d", "次の収益事業の候補を発見", "ideas", 1, d90, 8);
    }
  });
  tx();
}
