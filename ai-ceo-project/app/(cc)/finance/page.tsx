import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { getView } from "@/lib/view";
import { addExpense, addSale, deleteRecord } from "@/app/actions";
import { breakEvenUnits, computePnL, EXPENSE_CATEGORY_LABELS, OPERATING_CATEGORIES, yen, type ExpenseCategory } from "@/lib/finance/calc";
import { evaluateBudget } from "@/lib/automation/budget";
import { jstDate, jstMonth } from "@/lib/time";
import { Button, Card, DataBadge, Empty, Notice, PageHeader, TableWrap, td, th } from "@/components/common/ui";
import { Flash } from "@/components/common/Flash";

export const metadata = { title: "財務" };

type SP = Promise<{ ok?: string; err?: string; month?: string; price?: string; fee?: string; fixed?: string }>;

function DeleteBtn({ table, id }: { table: string; id: number }) {
  return (
    <form action={deleteRecord}>
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="text-xs text-fg-subtle hover:text-bad">削除</button>
    </form>
  );
}

export default async function FinancePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = getDb();
  const view = await getView();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : jstMonth();
  const settings = repo.getSettings(db);
  const sales = repo.salesInMonth(db, month, view);
  const expenses = repo.expensesInMonth(db, month, view);
  const agentCost = repo.agentCostInMonth(db, month);
  const pnl = computePnL(sales, expenses, agentCost);
  const cap = repo.num(settings, "monthly_budget_jpy", 30000);
  const budget = evaluateBudget(cap, pnl.operatingExpenses, repo.num(settings, "budget_warn_ratio", 0.8));
  const products = repo.listProducts(db, repo.ACTUAL_ONLY);
  const hasSample = sales.some((s) => s.data_kind === "sample") || expenses.some((e) => e.data_kind === "sample");

  // 損益分岐点（入力値で試算。結果は予測ではなく計算）
  const price = Number(sp.price) > 0 ? Number(sp.price) : products[0]?.price_jpy ?? 4980;
  const fee = sp.fee !== undefined && Number(sp.fee) >= 0 && Number(sp.fee) < 1 ? Number(sp.fee) : 0.15;
  const fixed = Number(sp.fixed) >= 0 && sp.fixed ? Number(sp.fixed) : pnl.operatingExpenses || cap;
  const be = breakEvenUnits(fixed, price, fee);
  const today = jstDate();

  const rows: [string, number, string?][] = [
    ["売上総額", pnl.grossSales],
    ["− 返金", -pnl.refunds],
    ["＝ 純売上", pnl.netSales, "font-semibold"],
    ["− 決済手数料", -pnl.paymentFees],
    ["＝ 粗利益", pnl.grossProfit, "font-semibold"],
    ...OPERATING_CATEGORIES.map((c) => [`− ${EXPENSE_CATEGORY_LABELS[c]}${c === "ai_api" && agentCost ? `（うちAI社員の推計 ${yen(agentCost)}）` : ""}`, -pnl.byCategory[c]] as [string, number]),
    ["＝ 営業利益", pnl.operatingProfit, "font-semibold text-gold"],
    ["− 税金", -pnl.taxes],
    ["＝ 税引後の手残り", pnl.afterTax, "font-semibold"],
  ];

  return (
    <>
      <PageHeader
        title="財務"
        en="FINANCE"
        description="売上と利益を分けて管理します。返金・決済手数料・税金・外注費・API費用は別々に記録します。"
        actions={
          <form className="flex items-end gap-2">
            <div><label htmlFor="month">対象月</label><input id="month" name="month" type="month" defaultValue={month} className="w-auto" /></div>
            <Button variant="ghost">表示</Button>
          </form>
        }
      />
      <Flash ok={sp.ok} err={sp.err} />
      {hasSample && <div className="mb-4"><Notice tone="warn">この月の数字にはサンプル（架空）の記録が含まれています。</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`${month.replace("-", "年")}月の収支`} aside={<DataBadge kind={hasSample ? "sample" : "actual"} />}>
          <table className="w-full">
            <tbody>
              {rows.map(([label, v, cls]) => (
                <tr key={label} className={cls?.includes("font-semibold") ? "border-t border-line" : ""}>
                  <td className={`py-1.5 pr-2 text-sm ${cls ?? "text-fg-muted"}`}>{label}</td>
                  <td className={`num py-1.5 text-right text-sm ${cls ?? ""} ${v < 0 && cls?.includes("font-semibold") ? "text-bad" : ""}`}>{yen(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-fg-subtle">販売件数 {pnl.salesCount}件。運営費＝AI API・ツール・外注・広告・その他（決済手数料と税金は含めない）。</p>
        </Card>

        <div className="space-y-4">
          <Card title="月間予算">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-fg-muted">使用 {yen(budget.usedJpy)} ／ 予算 {yen(budget.capJpy)}<span className="ml-1 text-[11px] text-fg-subtle">（設定値）</span></span>
              <span className={`num font-semibold ${budget.level === "stop" ? "text-bad" : budget.level === "warn" ? "text-warn" : ""}`}>残り {yen(budget.remainingJpy)}</span>
            </div>
            <div className="mt-2 h-2 w-full bg-navy-800" role="meter" aria-valuemin={0} aria-valuemax={budget.capJpy} aria-valuenow={budget.usedJpy} aria-label="月間予算の使用額">
              <div className={`h-2 rounded-r-[4px] ${budget.level === "stop" ? "bg-bad" : budget.level === "warn" ? "bg-warn" : "bg-gold-strong"}`} style={{ width: `${Math.min(100, budget.ratio * 100)}%` }} />
            </div>
          </Card>

          <Card title="損益分岐点の試算">
            <form className="grid grid-cols-3 gap-2">
              <input type="hidden" name="month" value={month} />
              <div><label htmlFor="be-price">価格（円）</label><input id="be-price" name="price" inputMode="numeric" defaultValue={price} /></div>
              <div><label htmlFor="be-fee">手数料率</label><input id="be-fee" name="fee" inputMode="decimal" defaultValue={fee} /></div>
              <div><label htmlFor="be-fixed">月の固定費（円）</label><input id="be-fixed" name="fixed" inputMode="numeric" defaultValue={fixed} /></div>
              <div className="col-span-3"><Button variant="ghost">計算</Button></div>
            </form>
            <p className="mt-3 text-sm">
              {be === null ? "この条件では1件あたりの手残りが0円以下のため、黒字になりません。" : <>月 <span className="num text-lg font-semibold text-gold">{be}件</span> 売れると固定費をまかなえます。</>}
            </p>
            <p className="mt-1 text-xs text-fg-subtle">計算結果であり、売上の予測ではありません。手数料率の初期値 0.15 は仮定値です。販売先の実際の手数料を確認して入力してください。</p>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="売上を記録する（実データ）">
          <form action={addSale} className="grid grid-cols-2 gap-2">
            <div className="col-span-2"><label htmlFor="s-product">商品</label>
              <select id="s-product" name="product_id"><option value="">（指定なし）</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </div>
            <div><label htmlFor="s-date">販売日</label><input id="s-date" name="sold_at" type="date" defaultValue={today} /></div>
            <div><label htmlFor="s-qty">数量</label><input id="s-qty" name="quantity" inputMode="numeric" defaultValue={1} /></div>
            <div><label htmlFor="s-gross">売上額（税込・円）</label><input id="s-gross" name="gross_jpy" inputMode="numeric" required /></div>
            <div><label htmlFor="s-fee">決済手数料（円）</label><input id="s-fee" name="payment_fee_jpy" inputMode="numeric" defaultValue={0} /></div>
            <div><label htmlFor="s-refund">返金額（円）</label><input id="s-refund" name="refund_jpy" inputMode="numeric" defaultValue={0} /></div>
            <div><label htmlFor="s-ch">販売経路</label><input id="s-ch" name="channel" placeholder="note など" /></div>
            <div className="col-span-2"><label htmlFor="s-note">メモ（購入者の個人情報は書かない）</label><input id="s-note" name="note" /></div>
            <div className="col-span-2"><Button>売上を記録</Button></div>
          </form>
        </Card>
        <Card title="費用を記録する（実データ）">
          <form action={addExpense} className="grid grid-cols-2 gap-2">
            <div><label htmlFor="e-date">日付</label><input id="e-date" name="spent_at" type="date" defaultValue={today} /></div>
            <div><label htmlFor="e-cat">費目</label>
              <select id="e-cat" name="category">{(Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]).map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}</select>
            </div>
            <div><label htmlFor="e-vendor">支払先</label><input id="e-vendor" name="vendor" placeholder="Anthropic など" /></div>
            <div><label htmlFor="e-amount">金額（円）</label><input id="e-amount" name="amount_jpy" inputMode="numeric" required /></div>
            <div className="col-span-2"><label htmlFor="e-note">メモ</label><input id="e-note" name="note" /></div>
            <div className="col-span-2"><Button>費用を記録</Button></div>
          </form>
          <p className="mt-2 text-xs text-fg-subtle">AI API は請求書の金額を記録してください（既存の自動投稿の費用も含む）。Command Center 内のAI社員の費用は、実行時に推計値が自動で加算されます。</p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="売上の記録">
          {sales.length === 0 ? <Empty>この月の売上はありません。</Empty> : (
            <TableWrap>
              <table className="w-full min-w-[480px]">
                <thead><tr><th className={th}>日付</th><th className={th}>商品</th><th className={`${th} text-right`}>売上</th><th className={`${th} text-right`}>手数料</th><th className={`${th} text-right`}>返金</th><th className={th}></th></tr></thead>
                <tbody>
                  {sales.map((s) => (
                    <tr key={s.id}>
                      <td className={`${td} num whitespace-nowrap`}>{s.sold_at}</td>
                      <td className={td}>{s.product_name ?? "—"} {s.data_kind === "sample" && <DataBadge kind="sample" />}</td>
                      <td className={`${td} num text-right`}>{yen(s.gross_jpy)}</td>
                      <td className={`${td} num text-right`}>{yen(s.payment_fee_jpy)}</td>
                      <td className={`${td} num text-right`}>{yen(s.refund_jpy)}</td>
                      <td className={td}>{s.data_kind === "actual" && <DeleteBtn table="sales" id={s.id} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        <Card title="費用の記録">
          {expenses.length === 0 ? <Empty>この月の費用はまだ記録されていません。</Empty> : (
            <TableWrap>
              <table className="w-full min-w-[420px]">
                <thead><tr><th className={th}>日付</th><th className={th}>費目</th><th className={th}>支払先</th><th className={`${th} text-right`}>金額</th><th className={th}></th></tr></thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id}>
                      <td className={`${td} num whitespace-nowrap`}>{e.spent_at}</td>
                      <td className={td}>{EXPENSE_CATEGORY_LABELS[e.category]} {e.data_kind === "sample" && <DataBadge kind="sample" />}</td>
                      <td className={td}>{e.vendor}</td>
                      <td className={`${td} num text-right`}>{yen(e.amount_jpy)}</td>
                      <td className={td}>{e.data_kind === "actual" && <DeleteBtn table="expenses" id={e.id} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}
