import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Claude API の呼び出し口。テストでは偽物（お金がかからない）に差し替える。
 * - キーはサーバー側の環境変数 ANTHROPIC_API_KEY だけから読む（ブラウザには出さない）
 * - 断られた（refusal）ときは、サーバー側で別モデルに自動で切り替える（fallbacks: "default"）
 */
export type LlmParams = Omit<MessageCreateParamsNonStreaming, "betas" | "fallbacks" | "stream">;
export type LlmCall = (params: LlmParams) => Promise<BetaMessage>;

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;

export const anthropicCall: LlmCall = async (params) => {
  if (!hasApiKey()) throw new Error("ANTHROPIC_API_KEY が設定されていません");
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 10 * 60 * 1000 });
  return client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
};

/** エラーを、秘密情報を含まない短い説明にする */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "APIキーが無効です（401）";
  if (e instanceof Anthropic.PermissionDeniedError) return "APIキーにこの操作の権限がありません（403）";
  if (e instanceof Anthropic.RateLimitError) return "利用回数の制限に達しました（429）。時間をおいて再実行してください";
  if (e instanceof Anthropic.BadRequestError) return `リクエストが不正です（400）：${e.message.slice(0, 200)}`;
  if (e instanceof Anthropic.APIError) return `Claude API のエラー（${e.status ?? "?"}）`;
  if (e instanceof Error) return e.message.slice(0, 300);
  return "不明なエラー";
}

/** 応答の使用量（複数回の呼び出しを合計できる形） */
export function usageOf(m: BetaMessage): { inputTokens: number; outputTokens: number; webSearches: number } {
  const u = m.usage;
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
  };
}
