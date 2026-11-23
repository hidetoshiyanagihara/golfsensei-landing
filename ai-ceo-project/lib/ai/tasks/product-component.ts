import { all, batch, get } from "../../database/db";
import * as repo from "../../database/repo";
import { AGENTS, COMMON_AGENT_RULES } from "../agents";
import { DEFAULT_MODEL, maxCostEstimateJpy } from "../models";
import { usageOf } from "../llm";
import { findUnsupportedNumbers } from "./ceo-meeting";
import type { TaskDef } from "../runner";

/**
 * 商品開発AI：商品の構成品を1つずつ下書きする（例：AI営業リサーチシステム）。
 * 中身は売り物なので、公開リポジトリではなくデータベース（product_docs）にだけ保存する。
 * できた下書きは「下書き」のまま。代表者が実際に使って確かめ、「確認済み」にする。
 */

const MAX_TOKENS = 16000;
const EST_INPUT = 6000;

export function productSystemPrompt(): string {
  const me = AGENTS.find((a) => a.id === "product")!;
  return [
    "あなたは AI CEO PROJECT の商品開発AIです。中小企業・個人事業主向けのデジタル商品（note の有料記事として販売）の中身を書きます。",
    "",
    "必ず守ること：",
    ...[...COMMON_AGENT_RULES, ...me.rules].map((r) => `- ${r}`),
    "- 他社の教材・記事・プロンプト集の文章を写さない。手順もプロンプトも自分で書く。",
    "- 「必ず成約」「売上◯倍」など効果を約束しない。効果の数字を書かない。",
    "- 記入例は架空の会社で書き、冒頭に「架空の例」と明記する（実在の会社名・人名を使わない）。",
    "- 顧客の個人情報・機密をAIに入れないための注意と、名前・社名を伏せる（匿名化する）具体的な手順を入れる。",
    "- ChatGPT でも Claude でも使えるように書く。特定の有料プランが必須の書き方をしない。",
    "",
    "書き方（Markdown）：",
    "- ## 見出し で章を分ける。章は次の順：",
    "  1. このテンプレートでできること（3行以内）",
    "  2. こんなときに使う",
    "  3. 準備するもの",
    "  4. 手順（ステップ1、2、3…。1ステップ1つの作業）",
    "  5. コピーして使うプロンプト（```で囲む。入れ替える部分は〔会社名〕のように〔〕で示す。2〜4個）",
    "  6. 記入例（架空の例：小規模BtoBの会社を1社決めて、入力と、AIの出力の例と、人が直す点を見せる）",
    "  7. よくある失敗と直し方",
    "  8. 使う前のチェックリスト（- [ ] の形）",
    "  9. 情報の扱いの注意（個人情報・機密・社外秘）",
    "- 3,000〜5,000字。読み手はAIに慣れていない人。専門用語には一言説明を付ける。",
  ].join("\n");
}

export const productComponentTask: TaskDef = {
  name: "product.component",
  agentId: "product",
  label: "商品の構成品の下書き（商品開発AI）",
  usesAi: true,
  estimateJpy: (s) => maxCostEstimateJpy(DEFAULT_MODEL, EST_INPUT, MAX_TOKENS, 0, repo.num(s, "usd_jpy", 155)),
  async run({ db, call, params }) {
    const productId = Number(params.productId);
    const index = Number(params.index);
    const product = await repo.getProduct(db, productId);
    if (!product || product.data_kind !== "actual") throw new Error("商品が見つかりません");
    const components = JSON.parse(product.components) as { name: string; status: string }[];
    const comp = components[index];
    if (!comp) throw new Error("構成品が見つかりません");
    // 市場調査AIの調査結果（承認待ち・承認済み）の要点を、差別化のヒントとして渡す
    const ideas = await all<{ name: string; competitors: string; evaluation_note: string; approval_status: string }>(
      db,
      "SELECT name, competitors, evaluation_note, approval_status FROM business_ideas WHERE origin = 'ai' AND data_kind = 'actual' AND approval_status <> 'rejected' ORDER BY id DESC LIMIT 3",
    );
    const input = {
      product: { name: product.name, description: product.description, price_jpy: product.price_jpy, channel: product.sales_channel },
      all_components: components.map((c, i) => `${i + 1}. ${c.name}`),
      this_component: { number: index + 1, name: comp.name },
      market_research: ideas.map((i) => ({ idea: i.name, competitors: i.competitors.slice(0, 600), note: i.evaluation_note.slice(0, 600), approval: i.approval_status })),
      positioning:
        "無料のプロンプト集は多いので、『自社の商材に当てはめて、営業の一連の流れ（リサーチ→トーク→メール→議事録→提案書）を回せる手順書＋記入例＋チェックリスト』で価値を出す。",
    };
    const user = [
      "# 作るもの",
      "```json",
      JSON.stringify(input, null, 1),
      "```",
      "",
      `「${comp.name}」の中身を書いてください。他の構成品と内容が重ならないようにし、必要なら「→ 構成品◯で詳しく」と案内してください。`,
    ].join("\n");
    const msg = await call({
      model: DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: productSystemPrompt(),
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: user }],
    });
    if (msg.stop_reason === "refusal") throw new Error("AIが回答を断りました（refusal）");
    if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました（max_tokens）");
    const body = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (body.length < 500) throw new Error("下書きが短すぎます");

    const warnings: string[] = [];
    if (/必ず|絶対に(売|成約)|確実に(売|成約)|倍増|保証/.test(body)) warnings.push("効果を約束するような言い方がないか確認してください（「必ず」「保証」など）");
    const nums = findUnsupportedNumbers([body.replace(/架空の例[\s\S]*?(?=\n## |$)/g, "")], user).slice(0, 8);
    if (nums.length) warnings.push(`根拠を確かめたい数字：${nums.join("、")}`);

    const existing = await get<{ version: number }>(db, "SELECT version FROM product_docs WHERE product_id = ? AND component_index = ?", [productId, index]);
    const next = components.map((c, i) => (i === index ? { ...c, status: "producing" } : c));
    await batch(db, [
      {
        sql: `INSERT INTO product_docs (product_id, component_index, title, body, status, version, review_note)
              VALUES (?, ?, ?, ?, 'draft', 1, ?)
              ON CONFLICT(product_id, component_index) DO UPDATE SET title = excluded.title, body = excluded.body,
                status = 'draft', version = product_docs.version + 1, review_note = excluded.review_note, updated_at = datetime('now')`,
        args: [productId, index, comp.name, body, warnings.join("\n") || null],
      },
      {
        sql: `UPDATE products SET components = ?, production_status = CASE WHEN production_status = 'planning' THEN 'producing' ELSE production_status END,
                updated_at = datetime('now') WHERE id = ?`,
        args: [JSON.stringify(next), productId],
      },
      repo.auditStmt("ai:product", "product.component_drafted", `product:${productId}`, { index, chars: body.length, version: (existing?.version ?? 0) + 1 }),
    ]);
    return {
      aiOutput: body.slice(0, 2000),
      executionResult: `「${comp.name}」の下書きを作りました（${body.length.toLocaleString("ja-JP")}字${warnings.length ? `・要確認 ${warnings.length}件` : ""}）`,
      model: msg.model,
      usage: usageOf(msg),
    };
  },
};
