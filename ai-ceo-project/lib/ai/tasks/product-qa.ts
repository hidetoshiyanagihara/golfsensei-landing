import { z } from "zod";
import { batch, get } from "../../database/db";
import * as repo from "../../database/repo";
import { AGENTS, COMMON_AGENT_RULES } from "../agents";
import { DEFAULT_MODEL, maxCostEstimateJpy, type UsageTotals } from "../models";
import { usageOf, type LlmCall } from "../llm";
import type { TaskDef } from "../runner";

/**
 * 品質検査（商品開発AI）：商品の構成品1つを「試しに使う → 採点する → 直す」をくり返し、100点を目指す。
 *   1. 試用：AIに慣れていない人のつもりで、架空の商談で手順どおりに使い、各プロンプトに実際に答えさせる
 *   2. 採点：6つの観点（合計100点）で採点し、直すべき点を挙げる。機械的な確認（禁止表現・章立てなど）も減点に入れる
 *   3. 改訂：直すべき点を全部直した版を書く
 * いちばん点の高かった版を残す（直して悪くなったら戻す）。点数は AI の評価であり、売れることの保証ではない。
 * 最終の「合格」と「販売の承認」は代表者が行う。
 */

export const MAX_ROUNDS_DEFAULT = 4;
const MAX_TOKENS = 16000;

export const CRITERIA = [
  { key: "accuracy", label: "誤情報がない", max: 20 },
  { key: "clarity", label: "初めての人が読んで分かる", max: 20 },
  { key: "usable", label: "そのまま使える（試用でプロンプトが期待どおり動く）", max: 25 },
  { key: "solves", label: "顧客の問題を解決できる", max: 15 },
  { key: "rights", label: "権利・独自性（他社のコピーがない・架空の例の明示）", max: 10 },
  { key: "safety", label: "誇大表現がない・情報の扱いの注意がある", max: 10 },
] as const;
type CriterionKey = (typeof CRITERIA)[number]["key"];

const ReviewSchema = z.object({
  scores: z.object(Object.fromEntries(CRITERIA.map((c) => [c.key, z.number().int().min(0).max(c.max)])) as Record<CriterionKey, z.ZodNumber>),
  issues: z.array(z.object({ criterion: z.string(), where: z.string(), problem: z.string(), fix: z.string() })),
  summary: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

const s = { type: "string" } as const;
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "issues", "summary"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: CRITERIA.map((c) => c.key),
      properties: Object.fromEntries(CRITERIA.map((c) => [c.key, { type: "integer" }])),
    },
    issues: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["criterion", "where", "problem", "fix"], properties: { criterion: s, where: s, problem: s, fix: s } },
    },
    summary: s,
  },
};

const REQUIRED_SECTIONS = ["できること", "こんなときに使う", "準備", "手順", "プロンプト", "記入例", "失敗", "チェックリスト", "情報の扱い"];

/** 機械的に確かめられる点（AIの採点が甘くならないよう、見つかれば必ず減点する） */
export function mechanicalIssues(body: string): { criterion: CriterionKey; problem: string; penalty: number }[] {
  const out: { criterion: CriterionKey; problem: string; penalty: number }[] = [];
  const heads = body.split("\n").filter((l) => /^##\s/.test(l)).join("\n");
  for (const sec of REQUIRED_SECTIONS) if (!heads.includes(sec)) out.push({ criterion: "clarity", problem: `章「${sec}」が見出しにありません`, penalty: 3 });
  const blocks = (body.match(/```/g) ?? []).length / 2;
  if (blocks < 2) out.push({ criterion: "usable", problem: "コピーして使うプロンプト（``` で囲んだもの）が2個未満です", penalty: 5 });
  if (!body.includes("架空")) out.push({ criterion: "rights", problem: "記入例が架空であることが書かれていません", penalty: 5 });
  const hype = body.match(/必ず(売|成約|受注|取れ|上が)|絶対に|確実に(売|成約|受注)|倍増|保証(し|す)|誰でも稼げ/g);
  if (hype) out.push({ criterion: "safety", problem: `効果を約束する言い方があります：${[...new Set(hype)].join("、")}`, penalty: 5 });
  if (!/匿名|伏せ/.test(body)) out.push({ criterion: "safety", problem: "名前・社名を伏せる（匿名化する）手順がありません", penalty: 5 });
  const len = [...body].length;
  if (len < 3000) out.push({ criterion: "solves", problem: `短すぎます（${len}字。3,000字以上）`, penalty: 3 });
  if (len > 9000) out.push({ criterion: "clarity", problem: `長すぎます（${len}字。9,000字以内）`, penalty: 3 });
  return out;
}

export function totalScore(r: Review, mech: ReturnType<typeof mechanicalIssues>): { total: number; byKey: Record<CriterionKey, number> } {
  const byKey = Object.fromEntries(CRITERIA.map((c) => [c.key, Math.min(c.max, Math.max(0, r.scores[c.key]))])) as Record<CriterionKey, number>;
  for (const m of mech) byKey[m.criterion] = Math.max(0, byKey[m.criterion] - m.penalty);
  return { total: CRITERIA.reduce((a, c) => a + byKey[c.key], 0), byKey };
}

function system(role: "prep" | "review" | "revise"): string {
  const me = AGENTS.find((a) => a.id === "product")!;
  const common = ["必ず守ること：", ...[...COMMON_AGENT_RULES, ...me.rules].map((r) => `- ${r}`)];
  if (role === "prep")
    return [
      "あなたは、AIを使い慣れていない小さな会社の営業担当者です。渡されたテンプレート（手順書）だけを読んで、書いてあるとおりに試しに使う準備をします。",
      "- 架空の商談を1つ決める（実在の会社・人名は使わない。名前は手順どおりに伏せる）。",
      "- コピーして使うプロンプト（``` で囲まれたもの）を、出てくる順に、手順どおりに〔 〕を埋めた「そのまま AI に貼る文章」にする（最大4個）。前の手順の結果が必要な所は、架空の内容で埋める。",
      "- 読んでいて迷った所・意味が分からなかった所・やり方が書かれていなかった所を、正直に confusions に書く（なければ空）。",
      ...common,
    ].join("\n");
  if (role === "review")
    return [
      "あなたは、デジタル商品（note の有料記事・980円〜4,980円）の品質検査の担当です。厳しく、具体的に、そして毎回同じ基準で採点します。",
      "採点の観点（合計100点）：",
      ...CRITERIA.map((c) => `- ${c.key}（${c.max}点）：${c.label}`),
      "- 試用は、プロンプトを Claude（Anthropic の API）で実際に実行した結果です。ChatGPT での動作確認は代表者の確認事項なので、それを理由に減点しない。",
      "- 前回の指摘があれば、まず直っているかを1つずつ確かめる。直っていれば減点しない。",
      "- 新しい指摘は、販売してよいかに関わる実際の問題だけにする（好みの言い回しや、なくても困らない追記の提案は挙げない）。",
      "- 満点は直す点がないときだけ。直す点があれば、その観点は減点する。",
      "- issues には直すべき点を全部挙げる（どこを・何が問題で・どう直すか）。",
      "- 実在の会社名・人名、他社教材の文章の写し、根拠のない数字・効果の約束、確認していないサービスの仕様を事実のように書いた所は、必ず挙げる。",
      ...common,
    ].join("\n");
  return [
    "あなたは、デジタル商品の原稿を直す担当です。品質検査で挙がった点を、原稿の該当箇所だけを書き換えて直します。",
    "- 出力は「書き換え」の一覧。old は原稿からそのまま正確に写した一続きの文字列（1回だけ現れる長さにする）、new は置き換え後。",
    "- 挙がった点に関係のない所は変えない。章立て（## 見出し）は変えない。原稿を長くしすぎない。",
    "- 効果を約束しない。数字は根拠があるものだけ。サービスの仕様（無料かどうか等）は断定せず「公式ページで確認」と書く。記入例は架空と明記。名前・社名を伏せる手順を残す。",
    ...common,
  ].join("\n");
}

const PREP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenario", "confusions", "prompts"],
  properties: {
    scenario: s,
    confusions: { type: "array", items: { type: "object", additionalProperties: false, required: ["where", "problem"], properties: { where: s, problem: s } } },
    prompts: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "filled"], properties: { label: s, filled: s } } },
  },
};
const PrepSchema = z.object({
  scenario: z.string(),
  confusions: z.array(z.object({ where: z.string(), problem: z.string() })),
  prompts: z.array(z.object({ label: z.string(), filled: z.string() })),
});
const EDITS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["edits"],
  properties: { edits: { type: "array", items: { type: "object", additionalProperties: false, required: ["old", "new"], properties: { old: s, new: s } } } },
};
const EditsSchema = z.object({ edits: z.array(z.object({ old: z.string(), new: z.string() })) });

/** 書き換えを当てる。old が原稿に1回だけ現れるものだけ当てる */
export function applyEdits(body: string, edits: { old: string; new: string }[]): { body: string; applied: number; skipped: number } {
  let out = body;
  let applied = 0;
  let skipped = 0;
  for (const e of edits) {
    if (!e.old || e.old === e.new) { skipped++; continue; }
    const first = out.indexOf(e.old);
    if (first < 0 || out.indexOf(e.old, first + 1) >= 0) { skipped++; continue; }
    out = out.slice(0, first) + e.new + out.slice(first + e.old.length);
    applied++;
  }
  return { body: out, applied, skipped };
}

/** 途中で失敗しても、それまでにかかった費用を記録できるようにする */
export class UsageError extends Error {
  constructor(message: string, public usage: UsageTotals, public model: string) {
    super(message);
  }
}

export type QaRound = { round: number; total: number; byKey: Record<CriterionKey, number>; issues: string[]; summary: string; applied?: number };

/** 1つの構成品を、試用（Claude で実際に実行）→採点→部分修正 でくり返す。いちばん点の高い版を返す */
export async function qaLoop(
  call: LlmCall,
  doc: { title: string; body: string; product: string; components: string[] },
  maxRounds = MAX_ROUNDS_DEFAULT,
): Promise<{ best: { body: string; total: number; byKey: Record<CriterionKey, number>; round: number; summary: string }; rounds: QaRound[]; usage: UsageTotals; model: string }> {
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
  let model = DEFAULT_MODEL;
  const text = (m: Awaited<ReturnType<LlmCall>>, allowCut = false) => {
    const u = usageOf(m);
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    model = m.model;
    if (m.stop_reason === "refusal") throw new UsageError("AIが回答を断りました（refusal）", usage, model);
    if (m.stop_reason === "max_tokens" && !allowCut) throw new UsageError("出力が長すぎて途中で切れました（max_tokens）", usage, model);
    return m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  };
  const json = <T,>(raw: string, schema: z.ZodType<T>, what: string): T => {
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      throw new UsageError(`${what}の結果を読み取れませんでした（形式が不正）`, usage, model);
    }
  };
  const ctx = `商品：${doc.product}\n構成品：${doc.components.map((c, i) => `${i + 1}. ${c}`).join(" / ")}\nこの原稿：「${doc.title}」`;
  let body = doc.body;
  let best: { body: string; total: number; byKey: Record<CriterionKey, number>; round: number; summary: string } | null = null;
  const rounds: QaRound[] = [];
  let prevIssues: string[] = [];
  let scenario = "";

  try {
    for (let round = 1; round <= maxRounds; round++) {
      // 1. 試用の準備（迷った所と、〔 〕を埋めたプロンプト）
      const prep = json(
        text(
          await call({
            model: DEFAULT_MODEL,
            max_tokens: 12000,
            system: system("prep"),
            output_config: { effort: "medium", format: { type: "json_schema", schema: PREP_SCHEMA } },
            messages: [
              {
                role: "user",
                content: `${ctx}\n\n# テンプレート\n${body}\n\n${scenario ? `前回と同じ架空の商談で試してください（直した所の効果を比べるため）：\n${scenario}\n\n` : ""}試しに使う準備をしてください。`,
              },
            ],
          }),
        ),
        PrepSchema,
        "試用の準備",
      );
      // 2. 試用：埋めたプロンプトを、そのまま Claude に貼って実際に実行する
      if (!scenario) scenario = prep.scenario.slice(0, 3000);
      const runs: string[] = [];
      for (const pr of prep.prompts.slice(0, 4)) {
        const out = text(await call({ model: DEFAULT_MODEL, max_tokens: 4000, messages: [{ role: "user", content: pr.filled.slice(0, 12000) }] }), true);
        runs.push(`## ${pr.label}\n### 貼った文章\n${pr.filled.slice(0, 4000)}\n### Claude の実際の出力\n${out.slice(0, 5000)}`);
      }
      const trial = [
        `架空の商談：${prep.scenario}`,
        `迷った所：${prep.confusions.length ? prep.confusions.map((c) => `\n- ${c.where}：${c.problem}`).join("") : "なし"}`,
        ...runs,
      ].join("\n\n");
      // 3. 採点（前回の指摘が直ったかも確かめる）
      const review = json(
        text(
          await call({
            model: DEFAULT_MODEL,
            max_tokens: 12000,
            system: system("review"),
            output_config: { effort: "high", format: { type: "json_schema", schema: REVIEW_JSON_SCHEMA } },
            messages: [
              {
                role: "user",
                content: `${ctx}\n\n# 原稿\n${body}\n\n# 試用の記録\n${trial.slice(0, 30000)}\n\n# 前回の指摘\n${prevIssues.length ? prevIssues.map((i) => `- ${i}`).join("\n") : "なし（初回）"}\n\n採点してください。`,
              },
            ],
          }),
        ),
        ReviewSchema,
        "採点",
      );
      const mech = mechanicalIssues(body);
      const { total, byKey } = totalScore(review, mech);
      const issues = [...mech.map((m) => `［${m.criterion}］${m.problem}`), ...review.issues.map((i) => `［${i.criterion}］${i.where}：${i.problem} → ${i.fix}`)];
      rounds.push({ round, total, byKey, issues, summary: review.summary });
      if (!best || total > best.total) best = { body, total, byKey, round, summary: review.summary };
      if (total >= 100 && issues.length === 0) break;
      // 2回続けて点が上がらなければ打ち切る（同じ所を回り続けない）
      if (rounds.length >= 3 && rounds[rounds.length - 1].total <= rounds[rounds.length - 3].total) break;
      if (round === maxRounds) break;
      // 4. 部分修正：挙がった点の箇所だけを書き換える（全体を書き直して崩さない）
      const { edits } = json(
        text(
          await call({
            model: DEFAULT_MODEL,
            max_tokens: 16000,
            system: system("revise"),
            output_config: { effort: "medium", format: { type: "json_schema", schema: EDITS_SCHEMA } },
            messages: [
              {
                role: "user",
                content: `${ctx}\n\n# 原稿\n${body}\n\n# 直すべき点\n${issues.map((i) => `- ${i}`).join("\n")}\n\n# 試用の記録（参考）\n${trial.slice(0, 12000)}\n\n書き換えの一覧を出してください。`,
              },
            ],
          }),
        ),
        EditsSchema,
        "修正",
      );
      const r = applyEdits(body, edits);
      rounds[rounds.length - 1].applied = r.applied;
      if (r.applied === 0) break;
      body = r.body;
      prevIssues = issues;
    }
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(e instanceof Error ? e.message : String(e), usage, model);
  }
  return { best: best!, rounds, usage, model };
}

export function reviewNote(best: { total: number; byKey: Record<CriterionKey, number>; round: number; summary: string }, rounds: QaRound[], date: string): string {
  const bestRound = rounds.find((r) => r.round === best.round)!;
  return [
    `品質検査（AI・${date}）：${best.total}点／100（${rounds.length}回 試用→採点→修正。採用したのは${best.round}回目の版）`,
    `点数の推移：${rounds.map((r) => r.total).join(" → ")}`,
    `内訳：${CRITERIA.map((c) => `${c.label} ${best.byKey[c.key]}/${c.max}`).join("、")}`,
    bestRound.issues.length ? `残っている課題：\n${bestRound.issues.slice(0, 8).map((i) => `- ${i}`).join("\n")}` : "残っている課題：なし",
    `所見：${(best.summary || "").slice(0, 300)}`,
    "※試用は Claude で実際にプロンプトを実行し、採点は AI が行いました。ChatGPT での動作と、売れること・効果は保証しません。代表者が実際に使って確かめてください。",
  ].join("\n");
}

export const productQaTask: TaskDef = {
  name: "product.qa",
  agentId: "product",
  label: "品質検査（試用→採点→改訂をくり返す・商品開発AI）",
  usesAi: true,
  estimateJpy: (st) => maxCostEstimateJpy(DEFAULT_MODEL, 20000 * 3 * MAX_ROUNDS_DEFAULT, MAX_TOKENS * 2 * MAX_ROUNDS_DEFAULT, 0, repo.num(st, "usd_jpy", 155)),
  async run({ db, call, params }) {
    const productId = Number(params.productId);
    const index = Number(params.index);
    const maxRounds = Math.min(Math.max(Number(params.rounds ?? MAX_ROUNDS_DEFAULT), 1), 6);
    const product = await repo.getProduct(db, productId);
    if (!product || product.data_kind !== "actual") throw new Error("商品が見つかりません");
    const components = (JSON.parse(product.components) as { name: string }[]).map((c) => c.name);
    const doc = await get<{ title: string; body: string }>(db, "SELECT title, body FROM product_docs WHERE product_id = ? AND component_index = ?", [productId, index]);
    if (!doc) throw new Error("この構成品の下書きがまだありません");

    const { best, rounds, usage, model } = await qaLoop(call, { title: doc.title, body: doc.body, product: product.name, components }, maxRounds);
    const today = new Date().toISOString().slice(0, 10);
    const note = reviewNote(best, rounds, today);
    const changed = best.body !== doc.body;
    await batch(db, [
      {
        sql: `UPDATE product_docs SET body = ?, review_note = ?, version = version + ?, status = 'draft', updated_at = datetime('now')
              WHERE product_id = ? AND component_index = ?`,
        args: [best.body, note, changed ? 1 : 0, productId, index],
      },
      repo.setSettingStmt(`qa_score:${productId}:${index}`, JSON.stringify({ total: best.total, byKey: best.byKey, at: today })),
      repo.auditStmt("ai:product", "product.qa_component", `product:${productId}`, { index, total: best.total, rounds: rounds.map((r) => r.total) }),
    ]);
    await applyChecklist(db, productId, components.length);
    return {
      aiOutput: JSON.stringify(rounds).slice(0, 8000),
      executionResult: `「${doc.title}」の品質検査：${best.total}点（${rounds.map((r) => r.total).join("→")}）${changed ? "・直した版を保存" : ""}`,
      model,
      usage,
    };
  },
};

/** 全部の構成品が満点の観点だけ、検査項目にチェックを入れる。販売ページの項目（claims）は、ページができるまで入れない */
export async function applyChecklist(db: Parameters<TaskDef["run"]>[0]["db"], productId: number, count: number): Promise<void> {
  const settings = await repo.getSettings(db);
  const scores: (Record<CriterionKey, number> | null)[] = [];
  for (let i = 0; i < count; i++) {
    const raw = settings[`qa_score:${productId}:${i}`];
    scores.push(raw ? (JSON.parse(raw).byKey as Record<CriterionKey, number>) : null);
  }
  const full = (k: CriterionKey) => scores.every((s) => s && s[k] === CRITERIA.find((c) => c.key === k)!.max);
  const map: Record<string, boolean> = {
    accuracy: full("accuracy"),
    clarity: full("clarity"),
    usable: full("usable"),
    solves: full("solves"),
    rights: full("rights"),
  };
  const product = await repo.getProduct(db, productId);
  if (!product) return;
  const checklist = repo.parseChecklist(product.qa_checklist).map((i) => (i.key in map ? { ...i, done: map[i.key] } : i));
  await batch(db, [
    {
      // 検査項目が変わったら、合格・承認はやり直し（販売中なら止める）
      sql: `UPDATE products SET qa_checklist = ?, qa_status = CASE WHEN qa_status = 'not_started' OR (qa_status = 'passed' AND qa_checklist <> ?) THEN 'in_progress' ELSE qa_status END,
              owner_approved_at = CASE WHEN qa_checklist = ? THEN owner_approved_at ELSE NULL END,
              sales_status = CASE WHEN qa_checklist <> ? AND sales_status = 'on_sale' THEN 'stopped' ELSE sales_status END,
              production_status = CASE WHEN production_status IN ('planning','producing') THEN 'review' ELSE production_status END,
              updated_at = datetime('now') WHERE id = ?`,
      args: [JSON.stringify(checklist), JSON.stringify(checklist), JSON.stringify(checklist), JSON.stringify(checklist), productId],
    },
  ]);
}
