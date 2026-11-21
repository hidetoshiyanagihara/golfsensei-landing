/**
 * 業務ルール（承認フロー）。画面からの操作はすべてここを通して判定する。
 */

export type QaItem = { key: string; label: string; done: boolean };

export type ProductState = {
  qa_status: string;
  production_status: string;
  owner_approved_at: string | null;
  qa_checklist: QaItem[];
};

/** 品質検査の合格：チェック項目がすべて完了していること */
export function canPassQa(p: Pick<ProductState, "qa_checklist" | "production_status">): { ok: boolean; reason?: string } {
  if (p.production_status !== "review" && p.production_status !== "done")
    return { ok: false, reason: "制作状況が「検査中」または「完成」になってから合格にできます" };
  const left = p.qa_checklist.filter((i) => !i.done);
  if (left.length > 0) return { ok: false, reason: `未確認の検査項目があります：${left.map((i) => i.label).join("／")}` };
  return { ok: true };
}

/** 販売開始：品質検査に合格し、代表者が承認していること（PART 2：品質確認が終わるまで販売しない） */
export function canStartSelling(p: ProductState): { ok: boolean; reason?: string } {
  if (p.qa_status !== "passed") return { ok: false, reason: "品質検査に合格していないため、販売を開始できません" };
  if (!p.owner_approved_at) return { ok: false, reason: "代表者の承認がないため、販売を開始できません" };
  return { ok: true };
}

export type ContentStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "posted" | "failed" | "skipped";

/**
 * 投稿のステータス遷移。承認を飛ばして予約・投稿済みにはできない。
 * 「posted」は外部の投稿ツールの結果を取り込むときだけ使い、画面から手で付けることはできない。
 */
const CONTENT_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["pending_approval", "skipped"],
  pending_approval: ["approved", "draft", "skipped"],
  approved: ["scheduled", "draft", "skipped"],
  scheduled: ["approved", "skipped"],
  posted: [],
  failed: ["draft"],
  skipped: ["draft"],
};

export function canTransitionContent(from: ContentStatus, to: ContentStatus): boolean {
  return CONTENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedContentTransitions(from: ContentStatus): ContentStatus[] {
  return CONTENT_TRANSITIONS[from] ?? [];
}

/** 事業アイデアの評価（7項目の平均、0〜100）。未評価の項目が1つでもあれば null（根拠なしに点数を作らない） */
export function totalIdeaScore(scores: (number | null | undefined)[]): number | null {
  if (scores.length === 0 || scores.some((s) => s === null || s === undefined)) return null;
  const nums = scores as number[];
  if (nums.some((s) => s < 0 || s > 100)) throw new Error("評価点は0〜100で入力してください");
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}
