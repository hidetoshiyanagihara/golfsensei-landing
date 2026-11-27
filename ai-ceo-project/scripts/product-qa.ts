/**
 * 商品の品質検査（GitHub Actions：.github/workflows/ai_ceo_product_qa.yml から手動で実行）
 *   構成品ごとに「試用→採点→改訂」をくり返し、いちばん点の高い版を残す（lib/ai/tasks/product-qa.ts）。
 *   AI社員の仕事として記録する（費用・予算の上限の確認は管理画面と同じ）。
 *   PRODUCT_ID … 商品の番号、ROUNDS … くり返す回数の上限（既定4）、INDEXES … 構成品の番号（1始まり、カンマ区切り。空なら全部）
 */
import { getDb } from "../lib/database/db";
import * as repo from "../lib/database/repo";
import { executeRun, queueRun } from "../lib/ai/runner";
import "../lib/ai/tasks/index";

async function main() {
  const productId = Number(process.env.PRODUCT_ID);
  const rounds = Number(process.env.ROUNDS || 4);
  if (!Number.isInteger(productId) || productId < 1) throw new Error("PRODUCT_ID が正しくありません");
  const db = await getDb();
  const product = await repo.getProduct(db, productId);
  if (!product) throw new Error("商品が見つかりません");
  const count = (JSON.parse(product.components) as unknown[]).length;
  const wanted = (process.env.INDEXES ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
  const indexes = wanted.length ? wanted.map((n) => n - 1) : [...Array(count).keys()];
  console.log(`商品「${product.name}」の品質検査：構成品 ${indexes.map((i) => i + 1).join("・")}（最大 ${rounds}回ずつ）`);
  let failed = 0;
  for (const index of indexes) {
    const q = await queueRun(db, "product.qa", { productId, index, rounds }, "manual");
    if (!q.ok) {
      console.log(`  ${index + 1}：実行できませんでした（${q.reason}）`);
      failed++;
      continue;
    }
    const r = await executeRun(db, q.runId);
    console.log(`  ${index + 1}：${r.message}`);
    if (!r.ok) failed++;
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
