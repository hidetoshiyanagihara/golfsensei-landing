/**
 * AIモデルの料金表（Anthropic 公式の API 料金、1M トークンあたりの米ドル）。
 * 2026-11-03 時点の情報。料金は変わることがあるため、請求額は必ず Anthropic Console の実績で確認する。
 * ここで計算する金額は「トークン数からの推計」であり、請求額（実績）ではない。
 */
export const MODEL_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number; label: string }> = {
  "claude-opus-5-5": { input: 4, output: 20, label: "Claude Opus 5.5" },
  "claude-sonnet-5-5": { input: 2, output: 10, label: "Claude Sonnet 5.5" },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, label: "Claude Haiku 5.5" },
};

export const PRICING_AS_OF = "2026-11-03";
export const DEFAULT_MODEL = "claude-opus-5-5";

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING_USD_PER_MTOK[model];
  if (!p) throw new Error(`料金が登録されていないモデルです: ${model}`);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** 円換算は切り上げ（予算を少なく見積もらないため） */
export function usdToJpy(usd: number, usdJpy: number): number {
  return Math.ceil(usd * usdJpy);
}
