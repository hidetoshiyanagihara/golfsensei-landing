import { z } from "zod";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { batch } from "../../database/db";
import * as repo from "../../database/repo";
import { AGENTS, COMMON_AGENT_RULES } from "../agents";
import { DEFAULT_MODEL, maxCostEstimateJpy, type UsageTotals } from "../models";
import { usageOf } from "../llm";
import { totalIdeaScore } from "../../rules";
import { jstDate } from "../../time";
import type { TaskDef } from "../runner";

/**
 * 市場調査AI：テーマについて Web 検索で調べ、事業アイデアを1〜3件、情報源付きで登録する（承認待ち）。
 * 情報源のURLは、実際の検索結果に出てきたものだけを残す（AIが作ったURLは捨てる）。
 */

const MAX_TOKENS = 16000;
const MAX_SEARCHES = 5;
const MAX_CALLS = 3;
const EST_INPUT = 60000;
export const DEFAULT_THEME = "中小企業・個人事業主向けの「AI営業自動化テンプレート」を note で 4,980円で売る場合の、需要・競合商品・価格帯";

const SCORE_KEYS = ["demand", "competition", "price", "profit", "difficulty", "acquisition", "recurrence"] as const;

const IdeaSchema = z.object({
  name: z.string().min(1),
  target: z.string(),
  problem: z.string(),
  competitors: z.string(),
  price_hypothesis: z.string(),
  revenue_model: z.string(),
  dev_cost_note: z.string(),
  expected_profit_note: z.string(),
  risks: z.string(),
  scores: z.object(Object.fromEntries(SCORE_KEYS.map((k) => [k, z.number().int().min(0).max(100)])) as Record<(typeof SCORE_KEYS)[number], z.ZodNumber>),
  score_rationale: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string(), kind: z.enum(["fact", "estimate"]) })),
});
export const ResearchSchema = z.object({ summary: z.string(), ideas: z.array(IdeaSchema).min(1).max(3) });
export type Research = z.infer<typeof ResearchSchema>;

const s = { type: "string" } as const;
export const SAVE_TOOL: BetaTool = {
  name: "save_research",
  description: "調査の結果（事業アイデア1〜3件と情報源）を管理画面に保存する。調査が終わったら必ず最後に1回だけ呼ぶ。",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "ideas"],
    properties: {
      summary: s,
      ideas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "target", "problem", "competitors", "price_hypothesis", "revenue_model", "dev_cost_note", "expected_profit_note", "risks", "scores", "score_rationale", "sources"],
          properties: {
            name: s,
            target: s,
            problem: s,
            competitors: s,
            price_hypothesis: s,
            revenue_model: s,
            dev_cost_note: s,
            expected_profit_note: s,
            risks: s,
            scores: {
              type: "object",
              additionalProperties: false,
              required: [...SCORE_KEYS],
              properties: Object.fromEntries(SCORE_KEYS.map((k) => [k, { type: "integer" }])),
            },
            score_rationale: s,
            sources: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "url", "kind"],
                properties: { title: s, url: s, kind: { type: "string", enum: ["fact", "estimate"] } },
              },
            },
          },
        },
      },
    },
  },
};

export function researchSystemPrompt(today: string): string {
  const me = AGENTS.find((a) => a.id === "research")!;
  return [
    `あなたは AI CEO PROJECT の市場調査AIです。今日は ${today} です。日本市場を対象に、Web検索で調べて事業アイデアを評価します。`,
    "",
    "必ず守ること：",
    ...[...COMMON_AGENT_RULES, ...me.rules].map((r) => `- ${r}`),
    `- Web検索は最大${MAX_SEARCHES}回。調べた内容をもとに、事業アイデアを1〜3件にまとめる。`,
    "- 情報源（sources）には、実際に検索結果で開いたページのURLだけを書く。URLを推測して作らない。",
    "- sources の kind：ページに書かれている事実なら fact、そこから推し量ったことなら estimate。",
    "- 競合は「商品名・販売場所・価格」が分かる範囲で書く。他社の商品の中身を書き写さない。",
    "- 評価（scores）は0〜100の整数。demand=需要の大きさ、competition=競争の少なさ（競合が少ないほど高い）、price=価格の妥当性、profit=想定利益、difficulty=開発のしやすさ（簡単なほど高い）、acquisition=顧客獲得のしやすさ、recurrence=継続販売の可能性。",
    "- score_rationale に、各点数の根拠を短く書く。根拠が弱いものは「推測」と明記する。",
    "- 想定利益・市場規模などの数字は、情報源がある場合だけ書き、なければ「不明（情報源なし）」と書く。",
    "- 前提：運営は人間1人＋AI、月の運営予算は1〜3万円、販売は note から、商品はデジタル商品。",
    "- 最後に必ず save_research ツールを1回呼んで保存する。",
  ].join("\n");
}

/**
 * 応答の中で、検索結果として実際に出てきたURLの一覧。
 * 数えるのは「検索・ページ取得の結果」と「文章に付いた引用（citations）」だけ。
 * AIが自分で書いた文章やツールへの入力（保存の依頼など）に出てくるURLは数えない（作られたURLを通さないため）。
 */
export function seenUrls(messages: BetaMessage[]): Set<string> {
  const urls = new Set<string>();
  const add = (v: unknown) => {
    for (const u of JSON.stringify(v ?? null).match(/https?:\/\/[^\s"'<>\\)]+/g) ?? []) urls.add(u.replace(/[.,。、]+$/, ""));
  };
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use" || b.type === "server_tool_use") continue;
      if (b.type === "text") {
        add((b as { citations?: unknown }).citations);
        continue;
      }
      add(b);
    }
  }
  return urls;
}

export function verifySources(research: Research, seen: Set<string>): { research: Research; dropped: number } {
  let dropped = 0;
  const ideas = research.ideas.map((i) => {
    const sources = i.sources.filter((src) => {
      const ok = /^https?:\/\//.test(src.url) && [...seen].some((u) => u === src.url || u.startsWith(src.url) || src.url.startsWith(u));
      if (!ok) dropped++;
      return ok;
    });
    return { ...i, sources };
  });
  return { research: { ...research, ideas }, dropped };
}

export const marketResearchTask: TaskDef = {
  name: "research.ideas",
  agentId: "research",
  label: "市場調査・事業アイデア（市場調査AI）",
  usesAi: true,
  estimateJpy: (st) => maxCostEstimateJpy(DEFAULT_MODEL, EST_INPUT, MAX_TOKENS * 2, MAX_SEARCHES, repo.num(st, "usd_jpy", 155)),
  async run({ db, call, params }) {
    const theme = String(params.theme ?? "").trim().slice(0, 300) || DEFAULT_THEME;
    const today = jstDate();
    const tools: BetaToolUnion[] = [
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES, user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" } },
      SAVE_TOOL,
    ];
    const messages: BetaMessageParam[] = [{ role: "user", content: `調査テーマ：${theme}\n\n調べて、事業アイデアを1〜3件、save_research で保存してください。` }];
    const responses: BetaMessage[] = [];
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
    let model = DEFAULT_MODEL;
    let saved: unknown = null;
    let nudged = false;

    for (let i = 0; i < MAX_CALLS && saved === null; i++) {
      const msg = await call({ model: DEFAULT_MODEL, max_tokens: MAX_TOKENS, system: researchSystemPrompt(today), output_config: { effort: "medium" }, tools, messages });
      responses.push(msg);
      model = msg.model;
      const u = usageOf(msg);
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.webSearches += u.webSearches;
      if (msg.stop_reason === "refusal") throw new Error("AIが回答を断りました（refusal）");
      const tool = msg.content.find((b) => b.type === "tool_use" && b.name === SAVE_TOOL.name);
      if (tool && tool.type === "tool_use") {
        saved = tool.input;
        break;
      }
      if (msg.stop_reason === "pause_turn") {
        // 検索の途中で一時停止した：そのまま送り返すと続きから再開する
        messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        continue;
      }
      if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました（max_tokens）");
      if (!nudged) {
        nudged = true;
        messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        messages.push({ role: "user", content: "調査結果を save_research ツールで保存してください。" });
        continue;
      }
    }
    if (saved === null) throw new Error("AIが調査結果を保存しませんでした");

    const parsed = ResearchSchema.safeParse(saved);
    if (!parsed.success) throw new Error("AIの調査結果の形式が正しくありませんでした");
    const { research, dropped } = verifySources(parsed.data, seenUrls(responses));

    await batch(db, [
      ...research.ideas.map((idea) => {
        const scores = SCORE_KEYS.map((k) => idea.scores[k]);
        const total = totalIdeaScore(scores);
        const note = [
          "【AIによる評価。推測を含みます。採用する前に情報源を確認してください】",
          idea.score_rationale,
          dropped ? `（検索結果で確認できなかったURL ${dropped}件は情報源から除外しました）` : "",
          `調査テーマ：${theme}`,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          sql: `INSERT INTO business_ideas (name, target, problem, competitors, price_hypothesis, revenue_model, dev_cost_note, expected_profit_note,
                  risks, score_demand, score_competition, score_price, score_profit, score_difficulty, score_acquisition, score_recurrence,
                  total_score, evaluation_note, sources, origin, approval_status, data_kind)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'pending', 'actual')`,
          args: [
            idea.name.slice(0, 120),
            idea.target.slice(0, 300),
            idea.problem.slice(0, 1000),
            idea.competitors.slice(0, 1000),
            idea.price_hypothesis.slice(0, 200),
            idea.revenue_model.slice(0, 300),
            idea.dev_cost_note.slice(0, 300),
            idea.expected_profit_note.slice(0, 300),
            idea.risks.slice(0, 1000),
            ...scores,
            total,
            note.slice(0, 2000),
            JSON.stringify(idea.sources.map((src) => ({ ...src, accessed_at: today }))),
          ],
        };
      }),
      repo.auditStmt("ai:research", "ideas.created", theme.slice(0, 100), { ideas: research.ideas.length, dropped_sources: dropped }),
    ]);

    return {
      aiOutput: JSON.stringify(research),
      executionResult: `事業アイデアを ${research.ideas.length}件 登録しました（承認待ち）。Web検索 ${usage.webSearches}回${dropped ? `、確認できないURL ${dropped}件を除外` : ""}`,
      model,
      usage,
    };
  },
};
