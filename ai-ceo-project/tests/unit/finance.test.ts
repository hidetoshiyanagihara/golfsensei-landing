import { test } from "node:test";
import assert from "node:assert/strict";
import { computePnL, breakEvenUnits, yen } from "../../lib/finance/calc";

test("売上と利益を区別して計算する（返金・手数料・運営費・税金）", () => {
  const p = computePnL(
    [
      { gross_jpy: 4980, refund_jpy: 0, payment_fee_jpy: 747, quantity: 1 },
      { gross_jpy: 4980, refund_jpy: 4980, payment_fee_jpy: 747, quantity: 1 },
    ],
    [
      { category: "ai_api", amount_jpy: 1000 },
      { category: "tool", amount_jpy: 2000 },
      { category: "payment_fee", amount_jpy: 100 },
      { category: "tax", amount_jpy: 300 },
    ],
    500,
  );
  assert.equal(p.grossSales, 9960);
  assert.equal(p.refunds, 4980);
  assert.equal(p.netSales, 4980);
  assert.equal(p.paymentFees, 747 * 2 + 100);
  assert.equal(p.grossProfit, 4980 - 1594);
  assert.equal(p.operatingExpenses, 1000 + 500 + 2000); // 決済手数料・税金は運営費に入れない
  assert.equal(p.operatingProfit, 3386 - 3500);
  assert.equal(p.afterTax, -114 - 300);
  assert.equal(p.salesCount, 1); // 全額返金は販売件数に数えない
  assert.equal(p.byCategory.ai_api, 1500);
});

test("データがなければすべて0", () => {
  const p = computePnL([], []);
  assert.equal(p.netSales, 0);
  assert.equal(p.operatingProfit, 0);
  assert.equal(p.salesCount, 0);
});

test("損益分岐点", () => {
  assert.equal(breakEvenUnits(30000, 4980, 0.15), Math.ceil(30000 / (4980 - 747)));
  assert.equal(breakEvenUnits(30000, 100, 1), null);
});

test("円表示", () => {
  assert.equal(yen(1234567), "¥1,234,567");
  assert.equal(yen(-500), "−¥500");
  assert.equal(yen(null), "—");
});

import { noteFeeEstimate } from "../../lib/finance/calc";

test("note の手数料の目安（公式ヘルプの計算例：1,000円・カード決済で145円）", () => {
  const r = noteFeeEstimate(1000);
  assert.equal(r.fee, 145);
  assert.equal(r.net, 855);
  assert.ok(Math.abs(r.effectiveRate - 0.145) < 1e-9);
  assert.equal(noteFeeEstimate(4980).fee, 722);
});
