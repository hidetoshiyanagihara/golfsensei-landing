import { z } from "zod";
import { batch } from "../../database/db";
import * as repo from "../../database/repo";
import { buildMeetingReport } from "../../analytics/meeting";
import { AGENTS, COMMON_AGENT_RULES } from "../agents";
import { DEFAULT_MODEL, maxCostEstimateJpy } from "../models";
import { usageOf } from "../llm";
import { PROFILES } from "../../marketing/launch-kit";
import { checkXText } from "../../automation/publisher";
import { findUnsupportedNumbers } from "./ceo-meeting";
import { addDays, jstDate } from "../../time";
import type { TaskDef } from "../runner";

/**
 * マーケティングAI：AI CEO PROJECT（発信名 HIDE）の投稿の下書きを作る。X 5本＋note 1本。
 * すべて「承認待ち」で登録する。代表者が承認・予約したものだけが投稿される（X は自動、note は手で貼る）。
 */

const MAX_TOKENS = 12000;
const EST_INPUT = 8000;

const PostSchema = z.object({
  platform: z.enum(["x", "note"]),
  title: z.string().min(1),
  body: z.string().min(1),
  day_offset: z.number().int().min(1).max(14),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  fact_basis: z.string(),
});
export const DraftsSchema = z.object({ posts: z.array(PostSchema).min(1).max(8) });

const str = { type: "string" } as const;
export const DRAFTS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["posts"],
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["platform", "title", "body", "day_offset", "time", "fact_basis"],
        properties: {
          platform: { type: "string", enum: ["x", "note"] },
          title: str,
          body: str,
          day_offset: { type: "integer" },
          time: str,
          fact_basis: str,
        },
      },
    },
  },
};

export function marketingSystemPrompt(): string {
  const me = AGENTS.find((a) => a.id === "marketing")!;
  const x = PROFILES.find((p) => p.platform === "x")!;
  return [
    "あなたは AI CEO PROJECT のマーケティングAIです。代表者の発信アカウント（発信名：HIDE）の投稿の下書きを書きます。",
    `アカウントの自己紹介：${x.bio}`,
    "発信のテーマ：AIだけで会社を作る挑戦／AI社員の開発過程／AIを使った収益化／新規事業の実験／売上・利益の公開／成功と失敗／Claude Code の活用／業務自動化。",
    "",
    "必ず守ること：",
    ...[...COMMON_AGENT_RULES, ...me.rules].map((r) => `- ${r}`),
    "- 数字・出来事は、入力の「実データ」に書かれているものだけを使う。入力にない成果・反響・数字を作らない。",
    "- 本名（柳原）や家族・住所などのプライベートは書かない。発信名は HIDE。",
    "- 費用・利益の金額は「管理画面に記録された分」でしかない。expenses_recorded が false（請求書の記録がない）のときは、費用や営業利益の金額を投稿に書かない（記録漏れで実際より少なく見えるため）。",
    "- 「開始◯日目」のような日数は、投稿される日（day_offset 後）の日数で書く。分からなければ日数を書かない。",
    "- X：日本語で130字以内。URLは入れない（料金が高く、リンクはプロフィールに置く）。ハッシュタグは0〜1個。1本ずつ切り口を変える（同じ文章の使い回し禁止）。",
    "- note：タイトルと本文（見出し付き、1,500〜2,500字）。Xの文章を伸ばしただけにしない。",
    "- 代表者の実感・体験が入ると良くなる箇所には【ここにひとこと：〜】と空欄を残してよい（Xは5本中2本まで）。空欄が残った投稿は代表者が書き換えるまで投稿されない。",
    "- 投稿の日時：day_offset は今日から何日後か（1〜7）、time は日本時間の HH:MM（Xは 7:00〜22:00 の間で、同じ日は2時間以上あける）。",
    "- fact_basis に、その投稿が根拠にした実データを短く書く。",
    "- 出力は X 5本、note 1本。",
  ].join("\n");
}

export const marketingDraftsTask: TaskDef = {
  name: "marketing.drafts",
  agentId: "marketing",
  label: "投稿の下書き（X 5本＋note 1本）",
  usesAi: true,
  estimateJpy: (s) => maxCostEstimateJpy(DEFAULT_MODEL, EST_INPUT, MAX_TOKENS, 0, repo.num(s, "usd_jpy", 155)),
  async run({ db, call }) {
    const base = await buildMeetingReport(db);
    const recent = await repo.listContent(db, repo.ACTUAL_ONLY, { business: "ai-ceo-project", limit: 30 });
    const products = await repo.listProducts(db, repo.ACTUAL_ONLY);
    const expensesRecorded = (await repo.expensesInMonth(db, jstDate().slice(0, 7), repo.ACTUAL_ONLY)).length > 0;
    const input = {
      today: jstDate(),
      project_start_date: "2026-11-21",
      expenses_recorded: expensesRecorded,
      facts: base.sections,
      products: products.map((p) => ({ name: p.name, price_jpy: p.price_jpy, tentative: !!p.price_is_tentative, production: p.production_status, qa: p.qa_status, sales: p.sales_status, channel: p.sales_channel })),
      recent_posts: recent.map((r) => ({ platform: r.platform, status: r.status, title: r.title, body: r.body.slice(0, 300) })),
    };
    const user = ["# 実データ（管理画面の記録）", "```json", JSON.stringify(input, null, 1), "```", "", "これまでの投稿と重ならない切り口で、下書きを作ってください。"].join("\n");
    const msg = await call({
      model: DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: marketingSystemPrompt(),
      output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFTS_JSON_SCHEMA } },
      messages: [{ role: "user", content: user }],
    });
    if (msg.stop_reason === "refusal") throw new Error("AIが回答を断りました（refusal）");
    if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました（max_tokens）");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let drafts: z.infer<typeof DraftsSchema>;
    try {
      drafts = DraftsSchema.parse(JSON.parse(text));
    } catch {
      throw new Error("AIの出力を読み取れませんでした（形式が不正）");
    }
    const today = jstDate();
    let flagged = 0;
    const rows = drafts.posts.map((p) => {
      const notes: string[] = [];
      const nums = findUnsupportedNumbers([p.title, p.body], user);
      if (nums.length) notes.push(`元データにない数字：${nums.join("、")}`);
      if (p.platform === "x") {
        const problem = checkXText(p.body);
        if (problem && !problem.startsWith("【")) notes.push(problem);
        if (/[【】]/.test(p.body)) notes.push("【 】を書き換えると投稿できます");
      }
      if (notes.length) flagged++;
      return {
        sql: `INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, post_time, review_note, source, data_kind)
              VALUES ('ai-ceo-project', ?, 'pending_approval', ?, ?, ?, ?, ?, 'ai-marketing', 'actual')`,
        args: [p.platform, p.title.slice(0, 200), p.body.slice(0, 20000), addDays(today, p.day_offset), p.time, [`根拠：${p.fact_basis}`, ...notes].join("\n").slice(0, 1000)],
      };
    });
    await batch(db, [...rows, repo.auditStmt("ai:marketing", "drafts.created", "ai-ceo-project", { count: rows.length, flagged })]);
    return {
      aiOutput: JSON.stringify(drafts),
      executionResult: `下書きを ${rows.length}件 作り、承認待ちにしました${flagged ? `（要確認 ${flagged}件）` : ""}`,
      model: msg.model,
      usage: usageOf(msg),
    };
  },
};
