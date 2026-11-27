/**
 * 承認済みの事業アイデアから、商品を1つ登録する（GitHub Actions：.github/workflows/ai_ceo_product_from_idea.yml から手動で実行）
 *   IDEA_ID    … 事業アイデアの番号（承認済みのものだけ）
 *   NAME       … 商品名（空ならアイデア名）
 *   COMPONENTS … 構成品を「|」で区切って（例：議事録|メール|提案メモ）
 *   PRICE      … 価格（円・仮）
 * 同じアイデアの商品がすでにあれば何もしない。価格は「仮」で登録し、販売開始は管理画面で代表者が行う。
 */
import { batch, get, getDb } from "../lib/database/db";
import * as repo from "../lib/database/repo";
import { DEFAULT_QA_CHECKLIST } from "../lib/database/seed";

export function parseComponents(s: string): string[] {
  return s
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((x) => x.slice(0, 60));
}

async function main() {
  const ideaId = Number(process.env.IDEA_ID);
  const price = Number(process.env.PRICE);
  const components = parseComponents(process.env.COMPONENTS ?? "");
  if (!Number.isInteger(ideaId) || ideaId < 1) throw new Error("IDEA_ID が正しくありません");
  if (!Number.isInteger(price) || price < 0 || price > 1_000_000) throw new Error("PRICE が正しくありません");
  if (!components.length) throw new Error("COMPONENTS を1つ以上入れてください");

  const db = await getDb();
  const idea = await get<{ name: string; business_id: string | null; approval_status: string; problem: string }>(
    db,
    "SELECT name, business_id, approval_status, problem FROM business_ideas WHERE id = ? AND data_kind = 'actual'",
    [ideaId],
  );
  if (!idea) throw new Error(`事業アイデア #${ideaId} が見つかりません`);
  if (idea.approval_status !== "approved") throw new Error("代表者が承認したアイデアだけ商品にできます");
  const existing = await get<{ id: number; name: string }>(db, "SELECT id, name FROM products WHERE idea_id = ? AND data_kind = 'actual'", [ideaId]);
  if (existing) {
    console.log(`すでに商品があります：#${existing.id} ${existing.name}（何もしません）`);
    return;
  }
  const name = (process.env.NAME?.trim() || idea.name).slice(0, 120);
  await batch(db, [
    {
      sql: `INSERT INTO products (business_id, idea_id, name, description, price_jpy, price_is_tentative, components, qa_checklist, sales_channel, data_kind)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'note（有料記事）', 'actual')`,
      args: [
        idea.business_id ?? "ai-business-lab",
        ideaId,
        name,
        idea.problem.slice(0, 1000),
        price,
        JSON.stringify(components.map((n) => ({ name: n, status: "planning" }))),
        JSON.stringify(DEFAULT_QA_CHECKLIST),
      ],
    },
    repo.auditStmt("owner", "product.created", `idea:${ideaId}`, { name, price, components }),
  ]);
  console.log(`商品を登録しました：${name}（${price}円・仮、構成品 ${components.length}個）`);
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
