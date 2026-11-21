import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { getView } from "@/lib/view";
import { updateProduct } from "@/app/actions";
import { canPassQa, canStartSelling } from "@/lib/rules";
import { yen } from "@/lib/finance/calc";
import { formatDateTimeJst } from "@/lib/time";
import { Button, Card, DataBadge, Empty, Notice, PageHeader, StatusPill } from "@/components/common/ui";
import { Flash, type FlashParams } from "@/components/common/Flash";

export const metadata = { title: "商品管理" };

const PRODUCTION = [
  ["planning", "企画中"],
  ["producing", "制作中"],
  ["review", "検査中"],
  ["done", "完成"],
] as const;

export default async function ProductsPage({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const db = getDb();
  const view = await getView();
  const products = repo.listProducts(db, view);

  return (
    <>
      <PageHeader title="商品管理" en="PRODUCTS" description="制作 → 品質検査 → 代表者承認 → 販売開始。品質検査に合格するまで販売できません。" />
      <Flash {...sp} />
      {products.length === 0 && <Empty>商品はまだありません。</Empty>}
      <div className="space-y-4">
        {products.map((p) => {
          const checklist = repo.parseChecklist(p.qa_checklist);
          const components = JSON.parse(p.components) as { name: string; status: string }[];
          const qa = canPassQa({ ...p, qa_checklist: checklist });
          const sell = canStartSelling({ ...p, qa_checklist: checklist });
          const sample = p.data_kind === "sample";
          const profit = p.net_sales - p.payment_fees;
          return (
            <Card key={p.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{p.name}</h2>
                    <DataBadge kind={sample ? "sample" : "actual"} />
                  </div>
                  <p className="mt-1 text-sm text-fg-muted">{p.description}</p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="text-fg-subtle">制作</span><StatusPill status={p.production_status} />
                    <span className="text-fg-subtle">品質</span><StatusPill status={p.qa_status} />
                    <span className="text-fg-subtle">販売</span><StatusPill status={p.sales_status} />
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-right text-sm sm:grid-cols-1">
                  <div><p className="text-[11px] text-fg-subtle">価格{p.price_is_tentative ? "（仮）" : ""}</p><p className="num text-lg font-semibold">{yen(p.price_jpy)}</p></div>
                  <div><p className="text-[11px] text-fg-subtle">売上（純売上・累計）</p><p className="num">{yen(p.net_sales)}</p></div>
                  <div><p className="text-[11px] text-fg-subtle">粗利益（手数料差引・累計）</p><p className="num">{yen(profit)}</p></div>
                  <div><p className="text-[11px] text-fg-subtle">購入者数</p><p className="num">{p.buyers}人</p></div>
                </div>
              </div>

              {components.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1 text-[11px] text-fg-subtle">商品構成</p>
                  <ul className="grid gap-1 text-sm sm:grid-cols-2">
                    {components.map((c, n) => (
                      <li key={c.name} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1">
                        <span className="min-w-0 truncate"><span className="num mr-1.5 text-fg-subtle">{n + 1}</span>{c.name}</span>
                        <StatusPill status={c.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!sample && (
                <div className="mt-4 grid gap-4 border-t border-line pt-4 lg:grid-cols-2">
                  <div>
                    <p className="mb-2 text-sm font-medium">品質チェック</p>
                    <ul className="space-y-1">
                      {checklist.map((i) => (
                        <li key={i.key}>
                          <form action={updateProduct}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="op" value="qa_item" />
                            <input type="hidden" name="key" value={i.key} />
                            <button type="submit" className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-navy-800" aria-pressed={i.done}>
                              <span className={`mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] ${i.done ? "border-good bg-good/20 text-good" : "border-navy-700"}`}>{i.done ? "✓" : ""}</span>
                              <span className={i.done ? "text-fg" : "text-fg-muted"}>{i.label}</span>
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="space-y-3">
                    <form action={updateProduct} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="op" value="production" />
                      <div className="min-w-40 flex-1">
                        <label htmlFor={`prod-${p.id}`}>制作状況</label>
                        <select id={`prod-${p.id}`} name="value" defaultValue={p.production_status}>
                          {PRODUCTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <Button variant="ghost">変更</Button>
                    </form>
                    <form action={updateProduct} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="op" value="price" />
                      <div className="min-w-32 flex-1"><label htmlFor={`price-${p.id}`}>価格（円）</label><input id={`price-${p.id}`} name="price_jpy" inputMode="numeric" defaultValue={p.price_jpy} /></div>
                      <label className="flex items-center gap-1.5 pb-2 text-xs"><input type="checkbox" name="tentative" defaultChecked={!!p.price_is_tentative} className="w-auto" />仮</label>
                      <Button variant="ghost">価格を保存</Button>
                    </form>
                    <form action={updateProduct} className="flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <Button name="op" value="qa_pass" disabled={!qa.ok || p.qa_status === "passed"} title={qa.reason}>品質検査に合格</Button>
                      <Button name="op" value="qa_fail" variant="danger">不合格</Button>
                      <Button name="op" value="approve" variant="ghost" disabled={p.qa_status !== "passed" || !!p.owner_approved_at}>代表者として承認</Button>
                      {p.sales_status === "on_sale" ? (
                        <Button name="op" value="stop_selling" variant="danger">販売を停止</Button>
                      ) : (
                        <Button name="op" value="start_selling" disabled={!sell.ok} title={sell.reason}>販売開始</Button>
                      )}
                    </form>
                    {!sell.ok && <Notice tone="warn">{sell.reason}</Notice>}
                    {p.owner_approved_at && <p className="text-xs text-fg-subtle">代表者承認：{formatDateTimeJst(p.owner_approved_at)}</p>}
                    <p className="text-xs text-fg-subtle">販売先：{p.sales_channel || "未定"}（販売ページの公開・決済の設定は代表者が行います）</p>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
