import { z } from "zod";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { batch } from "../../database/db";
import * as repo from "../../database/repo";
import { AGENTS, COMMON_AGENT_RULES } from "../agents";
import { DEFAULT_MODEL, maxCostEstimateJpy, type UsageTotals } from "../models";
import { usageOf } from "../llm";
import { seenUrls } from "./market-research";
import { jstDate } from "../../time";
import type { TaskDef } from "../runner";

/**
 * 競合研究（市場調査AI）：同じテーマで伸びている発信者・アカウントを Web 検索で調べ、
 * 「投稿の型」（書き出し・構成・見せ方・頻度）だけを抜き出して「手本帳」にまとめる。
 * 他人の文章・画像は写さない。手本帳はマーケティングAIが下書きを作るときに参考にする。
 */

const MAX_TOKENS = 16000;
const MAX_SEARCHES = 6;
const MAX_CALLS = 3;
const EST_INPUT = 60000;
export const DEFAULT_COMPETITOR_THEME =
  "日本で「AIで会社・事業をつくる」「AI社員」「ひとり起業×AI」「Claude/ChatGPTで業務自動化」を発信して伸びている個人（X・Instagram・YouTube・note）";

const PatternSchema = z.object({ name: z.string(), platform: z.enum(["x", "instagram", "youtube", "note", "all"]), structure: z.string(), why: z.string() });
export const PlaybookSchema = z.object({
  summary: z.string(),
  accounts: z.array(z.object({ name: z.string(), platform: z.string(), strengths: z.string(), source_url: z.string() })),
  patterns: z.array(PatternSchema),
  hooks: z.array(z.string()),
  cadence: z.string(),
  differentiation: z.string(),
  avoid: z.array(z.string()),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

const s = { type: "string" } as const;
const arr = (items: object) => ({ type: "array", items });
export const SAVE_PLAYBOOK_TOOL: BetaTool = {
  name: "save_playbook",
  description: "研究の結果（投稿の型の手本帳）を保存する。研究が終わったら必ず最後に1回だけ呼ぶ。",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "accounts", "patterns", "hooks", "cadence", "differentiation", "avoid"],
    properties: {
      summary: s,
      accounts: arr({
        type: "object",
        additionalProperties: false,
        required: ["name", "platform", "strengths", "source_url"],
        properties: { name: s, platform: s, strengths: s, source_url: s },
      }),
      patterns: arr({
        type: "object",
        additionalProperties: false,
        required: ["name", "platform", "structure", "why"],
        properties: { name: s, platform: { type: "string", enum: ["x", "instagram", "youtube", "note", "all"] }, structure: s, why: s },
      }),
      hooks: arr(s),
      cadence: s,
      differentiation: s,
      avoid: arr(s),
    },
  },
};

export function competitorSystemPrompt(today: string): string {
  const me = AGENTS.find((a) => a.id === "research")!;
  return [
    `あなたは AI CEO PROJECT の市場調査AIです。今日は ${today} です。発信名 HIDE（人間1人とAI社員で事業をつくる実験を、売上・失敗ごと公開する）の SNS を伸ばすため、同じテーマで伸びている発信者を研究します。`,
    "",
    "必ず守ること：",
    ...[...COMMON_AGENT_RULES, ...me.rules].map((r) => `- ${r}`),
    `- Web検索は最大${MAX_SEARCHES}回。`,
    "- 抜き出すのは「型」だけ：書き出しの型、構成、1投稿の長さ、画像・カルーセルの見せ方、動画の尺と流れ、投稿の頻度と時間帯、シリーズ化の仕方。",
    "- 他人の投稿の文章・キャッチコピー・画像・動画をそのまま書かない（引用もしない）。structure には型を自分の言葉で書き、例を書くときは HIDE の話として新しく書く。",
    "- フォロワー数・売上などの数字は、検索結果で確認できたものだけを書き、確認できなければ書かない。",
    "- accounts の source_url には、検索結果で実際に見たページのURLだけを書く。",
    "- hooks は「型」として書く（例：『〜した結果、◯◯だった』のように、空欄つきのひな形）。10〜20個。",
    "- differentiation：HIDE が真似ではなく勝てる点（実データの公開・AI社員の実験の過程など）。",
    "- avoid：伸びていても HIDE がやってはいけないこと（誇大な収益報告、根拠のない数字、煽り、他人の悪口など）。",
    "- 最後に必ず save_playbook を1回呼ぶ。",
  ].join("\n");
}

export const competitorResearchTask: TaskDef = {
  name: "research.competitors",
  agentId: "research",
  label: "競合研究・投稿の型の手本帳（市場調査AI）",
  usesAi: true,
  estimateJpy: (st) => maxCostEstimateJpy(DEFAULT_MODEL, EST_INPUT, MAX_TOKENS * 2, MAX_SEARCHES, repo.num(st, "usd_jpy", 155)),
  async run({ db, call, params }) {
    const theme = String(params.theme ?? "").trim().slice(0, 300) || DEFAULT_COMPETITOR_THEME;
    const today = jstDate();
    const tools: BetaToolUnion[] = [
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES, user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" } },
      SAVE_PLAYBOOK_TOOL,
    ];
    const messages: BetaMessageParam[] = [{ role: "user", content: `研究テーマ：${theme}\n\n研究して、save_playbook で手本帳を保存してください。` }];
    const responses: BetaMessage[] = [];
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
    let model = DEFAULT_MODEL;
    let saved: unknown = null;
    let nudged = false;
    for (let i = 0; i < MAX_CALLS && saved === null; i++) {
      const msg = await call({ model: DEFAULT_MODEL, max_tokens: MAX_TOKENS, system: competitorSystemPrompt(today), output_config: { effort: "medium" }, tools, messages });
      responses.push(msg);
      model = msg.model;
      const u = usageOf(msg);
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.webSearches += u.webSearches;
      if (msg.stop_reason === "refusal") throw new Error("AIが回答を断りました（refusal）");
      const tool = msg.content.find((b) => b.type === "tool_use" && b.name === SAVE_PLAYBOOK_TOOL.name);
      if (tool && tool.type === "tool_use") {
        saved = tool.input;
        break;
      }
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        continue;
      }
      if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました（max_tokens）");
      if (!nudged) {
        nudged = true;
        messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        messages.push({ role: "user", content: "研究結果を save_playbook ツールで保存してください。" });
      }
    }
    if (saved === null) throw new Error("AIが研究結果を保存しませんでした");
    const parsed = PlaybookSchema.safeParse(saved);
    if (!parsed.success) throw new Error("AIの研究結果の形式が正しくありませんでした");
    // 検索結果で確認できないURLの発信者は外す（AIが作ったURLを残さない）
    const seen = seenUrls(responses);
    const ok = (u: string) => /^https?:\/\//.test(u) && [...seen].some((x) => x === u || x.startsWith(u) || u.startsWith(x));
    const accounts = parsed.data.accounts.filter((a) => ok(a.source_url));
    const dropped = parsed.data.accounts.length - accounts.length;
    const playbook: Playbook = { ...parsed.data, accounts };
    await batch(db, [
      { sql: "INSERT INTO playbooks (kind, theme, content) VALUES ('competitors', ?, ?)", args: [theme, JSON.stringify({ ...playbook, dropped_accounts: dropped, researched_at: today })] },
      repo.auditStmt("ai:research", "playbook.created", theme.slice(0, 100), { accounts: accounts.length, patterns: playbook.patterns.length, dropped }),
    ]);
    return {
      aiOutput: JSON.stringify(playbook),
      executionResult: `投稿の型の手本帳を作りました（発信者 ${accounts.length}件・型 ${playbook.patterns.length}個・書き出し ${playbook.hooks.length}個）。Web検索 ${usage.webSearches}回${dropped ? `、確認できないURLの発信者 ${dropped}件を除外` : ""}`,
      model,
      usage,
    };
  },
};
