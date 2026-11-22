/**
 * AIモデルの料金表（Anthropic 公式の API 料金、1M トークンあたりの米ドル）。
 * 2026-11-03 時点の情報。料金は変わることがあるため、請求額は必ず Anthropic Console の実績で確認する。
 * ここで計算する金額は「トークン数からの推計」であり、請求額（実績）ではない。
 */
export const MODEL_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number; label: string }> = {
  "claude-opus-5-5": { input: 4, output: 20, label: "Claude Opus 5.5" },
  "claude-sonnet-5-5": { input: 2, output: 10, label: "Claude Sonnet 5.5" },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, label: "Claude Haiku 5.5" },
  // 断られたときの自動切り替え先（fallbacks: "default"）になりうるモデル。料金が高い方で見積もる
  "claude-opus-5": { input: 5, output: 25, label: "Claude Opus 5" },
  "claude-opus-4-8": { input: 5, output: 25, label: "Claude Opus 4.8" },
};

/** Web検索の料金（1,000回あたり 10ドル） */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/** 表にないモデルで返ってきたときは、表の中で一番高い料金で計算する（少なく見積もらないため） */
function priceOf(model: string) {
  const p = MODEL_PRICING_USD_PER_MTOK[model];
  if (p) return p;
  const all = Object.values(MODEL_PRICING_USD_PER_MTOK);
  return { input: Math.max(...all.map((x) => x.input)), output: Math.max(...all.map((x) => x.output)), label: model };
}

export type UsageTotals = { inputTokens: number; outputTokens: number; webSearches: number };

/** 実際の使用量から費用を計算（キャッシュ読み込みも通常の入力料金で数える＝多めに見積もる） */
export function costFromUsage(model: string, u: UsageTotals): number {
  const p = priceOf(model);
  return (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000 + u.webSearches * WEB_SEARCH_USD_PER_REQUEST;
}

/** 実行前の見積もり（上限）。出力は max_tokens まで使い切った場合で計算する */
export function maxCostEstimateJpy(model: string, estInputTokens: number, maxOutputTokens: number, maxSearches: number, usdJpy: number): number {
  return usdToJpy(costFromUsage(model, { inputTokens: estInputTokens, outputTokens: maxOutputTokens, webSearches: maxSearches }), usdJpy);
}

export const PRICING_AS_OF = "2026-11-03";
export const DEFAULT_MODEL = "claude-opus-5-5";

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (!MODEL_PRICING_USD_PER_MTOK[model]) throw new Error(`料金が登録されていないモデルです: ${model}`);
  return costFromUsage(model, { inputTokens, outputTokens, webSearches: 0 });
}

/** 円換算は切り上げ（予算を少なく見積もらないため） */
export function usdToJpy(usd: number, usdJpy: number): number {
  return Math.ceil(usd * usdJpy);
}
