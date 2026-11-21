/**
 * 財務の計算ルール（売上と利益を混同しないための定義）。
 *
 *   売上総額（gross）     = 販売した金額の合計
 *   純売上（net sales）   = 売上総額 − 返金
 *   粗利益（gross profit）= 純売上 − 決済手数料
 *   営業利益              = 粗利益 − 運営費（AI API・ツール・外注・広告・その他）
 *   税引後の手残り        = 営業利益 − 税金
 *
 * 決済手数料は「売上の記録に付けた手数料」と「費用として記録した手数料」の両方を合計する。
 */

export type ExpenseCategory = "ai_api" | "tool" | "payment_fee" | "outsourcing" | "advertising" | "tax" | "other";

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  ai_api: "AI API利用料",
  tool: "ツール利用料",
  payment_fee: "決済手数料",
  outsourcing: "外注費",
  advertising: "広告費",
  tax: "税金",
  other: "その他",
};

/** 月間運営予算の対象になる費用（売上に連動する決済手数料と税金は含めない） */
export const OPERATING_CATEGORIES: ExpenseCategory[] = ["ai_api", "tool", "outsourcing", "advertising", "other"];

export type SaleRow = { gross_jpy: number; refund_jpy: number; payment_fee_jpy: number; quantity: number };
export type ExpenseRow = { category: ExpenseCategory; amount_jpy: number };

export type PnL = {
  grossSales: number;
  refunds: number;
  netSales: number;
  paymentFees: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingProfit: number;
  taxes: number;
  afterTax: number;
  salesCount: number;
  byCategory: Record<ExpenseCategory, number>;
};

export function computePnL(sales: SaleRow[], expenses: ExpenseRow[], extraAiCostJpy = 0): PnL {
  const byCategory = Object.fromEntries(
    (Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]).map((k) => [k, 0]),
  ) as Record<ExpenseCategory, number>;
  for (const e of expenses) byCategory[e.category] += e.amount_jpy;
  byCategory.ai_api += extraAiCostJpy;

  const grossSales = sum(sales.map((s) => s.gross_jpy));
  const refunds = sum(sales.map((s) => s.refund_jpy));
  const netSales = grossSales - refunds;
  const paymentFees = sum(sales.map((s) => s.payment_fee_jpy)) + byCategory.payment_fee;
  const grossProfit = netSales - paymentFees;
  const operatingExpenses = sum(OPERATING_CATEGORIES.map((c) => byCategory[c]));
  const operatingProfit = grossProfit - operatingExpenses;
  const taxes = byCategory.tax;
  return {
    grossSales,
    refunds,
    netSales,
    paymentFees,
    grossProfit,
    operatingExpenses,
    operatingProfit,
    taxes,
    afterTax: operatingProfit - taxes,
    // 全額返金した販売は「販売件数」に数えない
    salesCount: sum(sales.filter((s) => s.refund_jpy < s.gross_jpy || s.gross_jpy === 0).map((s) => s.quantity)),
    byCategory,
  };
}

/**
 * 損益分岐点：固定の運営費をまかなうのに必要な販売数。
 * 1件あたりの手残り（価格 − 決済手数料）が 0 以下なら、何件売っても黒字にならないので null。
 */
export function breakEvenUnits(fixedCostJpy: number, priceJpy: number, feeRate: number, feeFixedJpy = 0): number | null {
  const perUnit = priceJpy - Math.ceil(priceJpy * feeRate) - feeFixedJpy;
  if (perUnit <= 0) return null;
  return Math.ceil(fixedCostJpy / perUnit);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function yen(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return (n < 0 ? "−" : "") + "¥" + Math.abs(Math.round(n)).toLocaleString("ja-JP");
}
