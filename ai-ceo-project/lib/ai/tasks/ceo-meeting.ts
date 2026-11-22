import { z } from "zod";
import { get, type DB } from "../../database/db";
import * as repo from "../../database/repo";
import { buildMeetingReport, type MeetingReport } from "../../analytics/meeting";
import { AGENTS, COMMON_AGENT_RULES } from "../agents";
import { DEFAULT_MODEL, maxCostEstimateJpy } from "../models";
import { usageOf } from "../llm";
import { addDays } from "../../time";
import type { TaskDef } from "../runner";

/**
 * AI CEO：経営会議（AI版）。
 * ルールベースの経営会議（DBの実データだけで作ったもの）を読み、7項目の会議録と翌日の行動計画を作る。
 * 顧客の情報（問い合わせの本文など）はAIに送らない。送るのは集計済みの数字と計画だけ。
 */

const MAX_TOKENS = 8000;
const EST_INPUT = 6000;
const OWNERS = ["owner", ...AGENTS.map((a) => a.id)] as const;

export const CeoMeetingSchema = z.object({
  headline: z.string(),
  situation: z.array(z.string()),
  revenue_analysis: z.array(z.string()),
  market: z.array(z.string()),
  problems: z.array(z.string()),
  improvements: z.array(z.string()),
  next_businesses: z.array(z.string()),
  actions: z.array(
    z.object({
      title: z.string(),
      owner: z.enum(OWNERS),
      detail: z.string(),
      requires_approval: z.boolean(),
    }),
  ),
  uncertainties: z.array(z.string()),
});
export type CeoMeeting = z.infer<typeof CeoMeetingSchema>;

const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
/** 構造化出力用の JSON Schema（すべて必須・余計な項目なし） */
export const CEO_MEETING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "situation", "revenue_analysis", "market", "problems", "improvements", "next_businesses", "actions", "uncertainties"],
  properties: {
    headline: str,
    situation: strs,
    revenue_analysis: strs,
    market: strs,
    problems: strs,
    improvements: strs,
    next_businesses: strs,
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "owner", "detail", "requires_approval"],
        properties: { title: str, owner: { type: "string", enum: [...OWNERS] }, detail: str, requires_approval: { type: "boolean" } },
      },
    },
    uncertainties: strs,
  },
};

export function ceoSystemPrompt(): string {
  const ceo = AGENTS.find((a) => a.id === "ceo")!;
  return [
    "あなたは AI CEO PROJECT の AI CEO です。代表者（人間1人）とAI社員で、複数の収益事業を運営する会社の経営を統括します。",
    "入力として、会社の管理画面のデータベースから機械的に集計した「実データ」と、ルールで検出した問題点が渡されます。",
    "これを読み、経営会議の議事録を日本語で作成してください。",
    "",
    "必ず守ること：",
    ...[...COMMON_AGENT_RULES, ...ceo.rules].map((r) => `- ${r}`),
    "- 数字は入力に書かれているものだけを使う。入力にない数字（売上予測、市場規模、成約率など）を作らない。",
    "- 推測を書くときは文頭に「推測：」と書く。",
    "- 市場の変化は、入力に市場調査の結果がなければ「未調査」と書き、想像で埋めない。",
    "- 行動計画（actions）は明日実行できる具体的な作業を3〜6件。担当（owner）は owner（代表者）か AI社員のID。",
    "  代表者の判断が必要なもの（お金・契約・公開・承認）は requires_approval を true にする。",
    "- AI社員のうちAPIで実際に動けるのは ceo（経営会議）と research（市場調査）だけ。他のAI社員に割り当てる作業は、代表者が手で進めるか、今後の実装待ちであることを detail に書く。",
    "- 箇条書き1つは80文字程度まで。簡潔に。",
  ].join("\n");
}

export function ceoUserPrompt(base: MeetingReport, extra: Record<string, unknown>): string {
  return [
    "# 管理画面の実データ（ルールベースの経営会議の結果）",
    "```json",
    JSON.stringify({ ...base, extra }, null, 1),
    "```",
    "",
    "上のデータだけを根拠に、経営会議の議事録を作成してください。",
  ].join("\n");
}

/** AIの文章のうち、入力データにない数字（金額・件数・割合など）を探す（見落とし防止のための目印） */
export function findUnsupportedNumbers(texts: string[], inputText: string): string[] {
  const norm = (s: string) => s.replace(/[,，]/g, "");
  const input = norm(inputText);
  const out = new Set<string>();
  // 「¥4,980」のような金額と、「30万円」「12%」「5件」のような単位つきの数
  const re = /[¥￥]\s?(\d[\d,，]*(?:\.\d+)?)|(\d[\d,，]*(?:\.\d+)?)\s?(万円|円|%|％|件|名|人|社|本|万|倍)/g;
  for (const t of texts) {
    for (const m of t.matchAll(re)) {
      const yen = m[1] !== undefined;
      const n = norm(m[1] ?? m[2]);
      const unit = m[3] ?? "円";
      if (!yen && Number(n) <= 10 && unit !== "円" && unit !== "万円") continue; // 「3件」など小さな数は目安として許容
      if (!input.includes(n)) out.add(m[0].trim());
    }
  }
  return [...out];
}

async function gatherExtra(db: DB) {
  const v = repo.ACTUAL_ONLY;
  const [products, goals, tasks, ideas] = await Promise.all([repo.listProducts(db, v), repo.listGoals(db), repo.openTasks(db, 20), repo.listIdeas(db, v)]);
  return {
    products: products.map((p) => ({
      name: p.name,
      price_jpy: p.price_jpy,
      price_is_tentative: !!p.price_is_tentative,
      production: p.production_status,
      qa: p.qa_status,
      sales: p.sales_status,
      channel: p.sales_channel,
      qa_left: repo.parseChecklist(p.qa_checklist).filter((i) => !i.done).map((i) => i.label),
    })),
    goals: goals.map((g) => ({ horizon: g.horizon, title: g.title, deadline: g.deadline, status: g.status })),
    open_tasks: tasks.map((t) => ({ title: t.title, owner: t.owner, due: t.due_date, status: t.status })),
    ideas: ideas.map((i) => ({ name: i.name, score: i.total_score, approval: i.approval_status, origin: i.origin })),
  };
}

export const ceoMeetingTask: TaskDef = {
  name: "ceo.meeting",
  agentId: "ceo",
  label: "経営会議（AI CEO）",
  usesAi: true,
  estimateJpy: (s) => maxCostEstimateJpy(DEFAULT_MODEL, EST_INPUT, MAX_TOKENS, 0, repo.num(s, "usd_jpy", 155)),
  async run({ db, call }) {
    const base = await buildMeetingReport(db);
    const extra = await gatherExtra(db);
    const user = ceoUserPrompt(base, extra);
    const msg = await call({
      model: DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: ceoSystemPrompt(),
      output_config: { effort: "medium", format: { type: "json_schema", schema: CEO_MEETING_JSON_SCHEMA } },
      messages: [{ role: "user", content: user }],
    });
    if (msg.stop_reason === "refusal") throw new Error("AIが回答を断りました（refusal）");
    if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました（max_tokens）");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let ai: CeoMeeting;
    try {
      ai = CeoMeetingSchema.parse(JSON.parse(text));
    } catch {
      throw new Error("AIの出力を読み取れませんでした（形式が不正）");
    }
    const allText = [ai.headline, ...ai.situation, ...ai.revenue_analysis, ...ai.market, ...ai.problems, ...ai.improvements, ...ai.next_businesses, ...ai.actions.flatMap((a) => [a.title, a.detail])];
    const warnings = findUnsupportedNumbers(allText, user);

    const content = {
      date: base.date,
      generatedBy: "ai",
      model: msg.model,
      note: "AI CEO が、管理画面の実データだけを根拠に作成しました。AIの文章には誤りが含まれることがあります。数字は元データ（下のルールベース版）と照らして確認してください。",
      warnings,
      ai,
      base,
    };
    // レポートと翌日の行動計画（同じタイトルの未完了タスクは作らない）を1回で保存する
    const open = new Set((await repo.openTasks(db, 1000)).map((t) => t.title));
    const actions = ai.actions.filter((a) => !open.has(a.title));
    const results = await db.batch(
      [
        { sql: "INSERT INTO reports (kind, period, generated_by, content) VALUES ('meeting', ?, 'ai', ?)", args: [base.date, JSON.stringify(content)] },
        ...actions.map((a) => ({
          sql: `INSERT INTO tasks (title, detail, owner, due_date, requires_approval, source)
                VALUES (?, ?, ?, ?, ?, 'meeting:' || (SELECT MAX(id) FROM reports))`,
          args: [a.title.slice(0, 200), a.detail.slice(0, 1000), a.owner, addDays(base.date, 1), a.requires_approval ? 1 : 0],
        })),
        repo.auditStmt("ai:ceo", "meeting.generated", "report", { by: "ai", actions: actions.length, warnings: warnings.length }),
      ],
      "write",
    );
    const reportId = Number(results[0].lastInsertRowid);
    return {
      aiOutput: JSON.stringify(ai),
      executionResult: `経営会議レポート #${reportId} を保存し、翌日のタスクを ${actions.length}件 登録しました${warnings.length ? `（要確認の数字 ${warnings.length}件）` : ""}`,
      model: msg.model,
      usage: usageOf(msg),
    };
  },
};

export async function latestAiReportId(db: DB): Promise<number | null> {
  const r = await get<{ id: number }>(db, "SELECT id FROM reports WHERE generated_by = 'ai' ORDER BY id DESC LIMIT 1");
  return r ? Number(r.id) : null;
}
