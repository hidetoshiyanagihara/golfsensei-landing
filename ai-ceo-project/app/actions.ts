"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { InStatement } from "@libsql/client";
import { batch, get, getDb, type DB } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { requireAuth, isConfigured } from "@/lib/security/auth";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, passwordMatches, resolveSessionSecret, signSession } from "@/lib/security/session";
import { SAMPLE_COOKIE } from "@/lib/view";
import { canPassQa, canStartSelling, canTransitionContent, totalIdeaScore, type ContentStatus } from "@/lib/rules";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/finance/calc";
import { buildMeetingReport, saveMeeting } from "@/lib/analytics/meeting";
import { importAutopostFromGitHub, AUTOPOST_SOURCE } from "@/lib/importers/autopost";
import { ACCOUNTS } from "@/lib/marketing/launch-kit";
import { checkXText } from "@/lib/automation/publisher";
import { whoAmI, xCredentialsFromEnv } from "@/lib/social/x";
import { checkInstagram, igMe } from "@/lib/social/instagram";
import { igToken } from "@/lib/automation/ig-publisher";
import { parseExtra } from "@/lib/marketing/note-format";
import { isYmd, jstDate } from "@/lib/time";
import { executeRun, queueRun } from "@/lib/ai/runner";
import { BACKGROUND_PATH, onNetlify, signDispatch } from "@/lib/ai/dispatch";
import "@/lib/ai/tasks/index";

// ---------- 入力チェック ----------
class InputError extends Error {}

function str(fd: FormData, key: string, { max = 2000, required = false } = {}): string {
  // ブラウザのフォームは改行を CR+LF（2文字）で送るため、1文字（LF）にそろえる（X の文字数がずれないように）
  const v = String(fd.get(key) ?? "").replace(/\r\n?/g, "\n").trim();
  if (required && !v) throw new InputError(`「${key}」を入力してください`);
  if (v.length > max) throw new InputError(`「${key}」は${max}文字以内で入力してください`);
  return v;
}

function int(fd: FormData, key: string, { min = 0, max = 100_000_000, optional = false } = {}): number | null {
  const raw = String(fd.get(key) ?? "").replace(/[,，円¥\s]/g, "");
  if (!raw) {
    if (optional) return null;
    throw new InputError(`「${key}」を入力してください`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`「${key}」は${min}〜${max}の整数で入力してください`);
  return n;
}

function date(fd: FormData, key: string): string {
  const v = str(fd, key) || jstDate();
  if (!isYmd(v)) throw new InputError("日付の形式が正しくありません");
  return v;
}

function oneOf<T extends string>(v: string, list: readonly T[], label: string): T {
  if (!(list as readonly string[]).includes(v)) throw new InputError(`${label}の値が正しくありません`);
  return v as T;
}

/** 操作後は元の画面に戻り、結果をメッセージで表示する */
async function act(path: string, fn: (db: DB) => Promise<string | void>): Promise<never> {
  await requireAuth();
  // 同じURLに戻ると画面が更新されないことがあるため、毎回ちがうURLにする（t は表示には使わない）
  const back = (key: "ok" | "err", m: string) => `${path}?${key}=${encodeURIComponent(m)}&t=${Date.now().toString(36)}`;
  let msg: string;
  try {
    msg = (await fn(await getDb())) || "保存しました";
  } catch (e) {
    if (e instanceof InputError) redirect(back("err", e.message));
    console.error(e);
    redirect(back("err", "処理に失敗しました。入力内容を確認してください。"));
  }
  revalidatePath("/", "layout");
  redirect(back("ok", msg));
}

// ---------- ログイン ----------
async function clientKey(): Promise<string> {
  const h = await headers();
  // Netlify は接続元IPを x-nf-client-connection-ip に入れる。なければ x-forwarded-for の先頭
  return (h.get("x-nf-client-connection-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? "local").trim().slice(0, 64);
}

export async function login(fd: FormData): Promise<void> {
  if (!isConfigured()) redirect("/login?e=setup");
  const db = await getDb();
  const key = await clientKey();
  if (await repo.loginLocked(db, key)) redirect("/login?e=locked");
  const ok = await passwordMatches(String(fd.get("password") ?? ""), process.env.ADMIN_PASSWORD);
  if (!ok) {
    await repo.recordLoginFailure(db, key);
    await repo.audit(db, "anonymous", "auth.login_failed", key);
    redirect("/login?e=invalid");
  }
  await repo.clearLoginFailures(db, key);
  const token = await signSession(resolveSessionSecret()!);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  await repo.audit(db, "owner", "auth.login", key);
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function toggleSample(fd: FormData): Promise<void> {
  await requireAuth();
  const c = await cookies();
  const on = c.get(SAMPLE_COOKIE)?.value === "1";
  c.set(SAMPLE_COOKIE, on ? "0" : "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  const back = String(fd.get("back") ?? "/dashboard");
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/dashboard");
}

// ---------- 事業開発 ----------
const SCORE_KEYS = ["demand", "competition", "price", "profit", "difficulty", "acquisition", "recurrence"] as const;

export async function createIdea(fd: FormData): Promise<void> {
  return act("/business", async (db) => {
    const name = str(fd, "name", { max: 120, required: true });
    await batch(db, [
      {
        sql: `INSERT INTO business_ideas (business_id, name, target, problem, competitors, price_hypothesis, revenue_model, dev_cost_note,
                expected_profit_note, risks, origin, approval_status, data_kind)
              VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'pending', 'actual')`,
        args: [
          name,
          str(fd, "target", { max: 300 }),
          str(fd, "problem", { max: 1000 }),
          str(fd, "competitors", { max: 1000 }),
          str(fd, "price_hypothesis", { max: 200 }),
          str(fd, "revenue_model", { max: 300 }),
          str(fd, "dev_cost_note", { max: 300 }),
          str(fd, "expected_profit_note", { max: 300 }),
          str(fd, "risks", { max: 1000 }),
        ],
      },
      repo.auditStmt("owner", "idea.created", name),
    ]);
    return "事業アイデアを登録しました";
  });
}

export async function scoreIdea(fd: FormData): Promise<void> {
  return act("/business", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const scores = SCORE_KEYS.map((k) => int(fd, `score_${k}`, { min: 0, max: 100, optional: true }));
    const sourceUrl = str(fd, "source_url", { max: 500 });
    if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) throw new InputError("情報源のURLは http(s):// で始めてください");
    const note = str(fd, "evaluation_note", { max: 2000 });
    const total = totalIdeaScore(scores);
    const row = await get<{ sources: string }>(db, "SELECT sources FROM business_ideas WHERE id = ? AND data_kind = 'actual'", [id]);
    if (!row) throw new InputError("アイデアが見つかりません");
    const sources = JSON.parse(row.sources) as unknown[];
    if (sourceUrl)
      sources.push({
        title: str(fd, "source_title", { max: 200 }) || sourceUrl,
        url: sourceUrl,
        accessed_at: jstDate(),
        kind: str(fd, "source_kind") === "estimate" ? "estimate" : "fact",
      });
    await batch(db, [
      {
        sql: `UPDATE business_ideas SET score_demand=?, score_competition=?, score_price=?, score_profit=?, score_difficulty=?,
                score_acquisition=?, score_recurrence=?, total_score=?, evaluation_note=?, sources=? WHERE id=?`,
        args: [...scores, total, note, JSON.stringify(sources), id],
      },
      repo.auditStmt("owner", "idea.scored", `idea:${id}`, { total }),
    ]);
    return total === null ? "評価を保存しました（未入力の項目があるため合計点は未算出）" : `評価を保存しました（${total}点）`;
  });
}

export async function decideIdea(fd: FormData): Promise<void> {
  return act("/business", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const decision = oneOf(str(fd, "decision"), ["approved", "rejected", "on_hold", "pending"] as const, "判断");
    await batch(db, [
      { sql: "UPDATE business_ideas SET approval_status = ?, decided_at = datetime('now') WHERE id = ? AND data_kind = 'actual'", args: [decision, id] },
      repo.auditStmt("owner", "idea.decided", `idea:${id}`, decision),
    ]);
    return "判断を記録しました";
  });
}

// ---------- 商品 ----------
export async function updateProduct(fd: FormData): Promise<void> {
  return act("/products", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const op = str(fd, "op", { required: true });
    const p = await repo.getProduct(db, id);
    if (!p || p.data_kind !== "actual") throw new InputError("商品が見つかりません");
    const checklist = repo.parseChecklist(p.qa_checklist);
    const state = { ...p, qa_checklist: checklist };
    const stmts: InStatement[] = [];
    const set = (sql: string, ...args: (string | number | null)[]) =>
      stmts.push({ sql: `UPDATE products SET ${sql}, updated_at = datetime('now') WHERE id = ?`, args: [...args, id] });

    switch (op) {
      case "production": {
        const v = oneOf(str(fd, "value"), ["planning", "producing", "review", "done"] as const, "制作状況");
        set("production_status = ?", v);
        if (v === "review" && p.qa_status === "not_started") set("qa_status = 'in_progress'");
        break;
      }
      case "qa_item": {
        const key = str(fd, "key", { required: true });
        const next = checklist.map((i) => (i.key === key ? { ...i, done: !i.done } : i));
        // 検査項目を変えたら、合格・承認はやり直し。販売中なら止める
        set(
          "qa_checklist = ?, qa_status = CASE WHEN qa_status = 'passed' THEN 'in_progress' ELSE qa_status END, owner_approved_at = NULL, sales_status = CASE WHEN sales_status = 'on_sale' THEN 'stopped' ELSE sales_status END",
          JSON.stringify(next),
        );
        break;
      }
      case "qa_pass": {
        const r = canPassQa(state);
        if (!r.ok) throw new InputError(r.reason!);
        set("qa_status = 'passed'");
        break;
      }
      case "qa_fail":
        set("qa_status = 'failed', owner_approved_at = NULL, sales_status = CASE WHEN sales_status = 'on_sale' THEN 'stopped' ELSE sales_status END");
        break;
      case "approve":
        if (p.qa_status !== "passed") throw new InputError("品質検査に合格してから承認してください");
        set("owner_approved_at = datetime('now'), sales_status = CASE WHEN sales_status = 'not_for_sale' THEN 'ready' ELSE sales_status END");
        break;
      case "start_selling": {
        const r = canStartSelling(state);
        if (!r.ok) throw new InputError(r.reason!);
        set("sales_status = 'on_sale'");
        break;
      }
      case "stop_selling":
        set("sales_status = 'stopped'");
        break;
      case "price": {
        const price = int(fd, "price_jpy", { min: 0, max: 10_000_000 })!;
        set("price_is_tentative = ?, price_jpy = ?", fd.get("tentative") ? 1 : 0, price);
        break;
      }
      default:
        throw new InputError("不明な操作です");
    }
    const detail = Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
    stmts.push(repo.auditStmt("owner", `product.${op}`, `product:${id}`, detail));
    await batch(db, stmts);
    return "商品を更新しました";
  });
}

// ---------- 財務 ----------
export async function addSale(fd: FormData): Promise<void> {
  return act("/finance", async (db) => {
    const productId = int(fd, "product_id", { min: 1, optional: true });
    const gross = int(fd, "gross_jpy")!;
    const refund = int(fd, "refund_jpy", { optional: true }) ?? 0;
    if (refund > gross) throw new InputError("返金額が売上額を超えています");
    await batch(db, [
      {
        sql: "INSERT INTO sales (product_id, sold_at, quantity, gross_jpy, payment_fee_jpy, refund_jpy, channel, note, data_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'actual')",
        args: [
          productId,
          date(fd, "sold_at"),
          int(fd, "quantity", { min: 1, max: 10000, optional: true }) ?? 1,
          gross,
          int(fd, "payment_fee_jpy", { optional: true }) ?? 0,
          refund,
          str(fd, "channel", { max: 50 }),
          str(fd, "note", { max: 300 }),
        ],
      },
      repo.auditStmt("owner", "sale.added", `product:${productId ?? "-"}`, { gross, refund }),
    ]);
    return "売上を記録しました";
  });
}

export async function addExpense(fd: FormData): Promise<void> {
  return act("/finance", async (db) => {
    const category = oneOf(str(fd, "category"), Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[], "費目");
    const amount = int(fd, "amount_jpy")!;
    await batch(db, [
      {
        sql: "INSERT INTO expenses (spent_at, category, vendor, amount_jpy, note, data_kind) VALUES (?, ?, ?, ?, ?, 'actual')",
        args: [date(fd, "spent_at"), category, str(fd, "vendor", { max: 100 }), amount, str(fd, "note", { max: 300 })],
      },
      repo.auditStmt("owner", "expense.added", category, { amount }),
    ]);
    return "費用を記録しました";
  });
}

const DELETABLE = { sales: "/finance", expenses: "/finance", metrics: "/marketing", inquiries: "/marketing" } as const;

export async function deleteRecord(fd: FormData): Promise<void> {
  const t = String(fd.get("table") ?? "");
  if (!(t in DELETABLE)) redirect("/dashboard");
  const table = t as keyof typeof DELETABLE;
  return act(DELETABLE[table], async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const row = await get(db, `SELECT * FROM ${table} WHERE id = ? AND data_kind = 'actual'`, [id]);
    if (!row) throw new InputError("記録が見つかりません");
    await batch(db, [{ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] }, repo.auditStmt("owner", `${table}.deleted`, `${table}:${id}`, row)]);
    return "記録を削除しました（削除内容は操作ログに残っています）";
  });
}

// ---------- コンテンツ・指標・問い合わせ ----------
const PLATFORMS = ["x", "instagram", "youtube", "note", "linkedin", "other"] as const;

export async function createDraft(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const platform = oneOf(str(fd, "platform"), PLATFORMS, "投稿先");
    const business = oneOf(str(fd, "business") || "ai-ceo-project", ["ai-ceo-project", "ai-business-lab", "axion-sales", "copipe-ai"] as const, "アカウント");
    const scheduled = str(fd, "scheduled_at");
    if (scheduled && !isYmd(scheduled)) throw new InputError("予定日の形式が正しくありません");
    const time = postTime(fd);
    await batch(db, [
      {
        sql: "INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, post_time, source, data_kind) VALUES (?, ?, 'draft', ?, ?, ?, ?, 'manual', 'actual')",
        args: [business, platform, str(fd, "title", { max: 200, required: true }), str(fd, "body", { max: 20000 }), scheduled || null, time],
      },
      repo.auditStmt("owner", "content.draft_created", platform),
    ]);
    return "下書きを保存しました";
  });
}

export async function transitionContent(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const to = str(fd, "to") as ContentStatus;
    const row = await get<{ status: ContentStatus; scheduled_at: string | null; platform: string; business_id: string | null; body: string }>(
      db,
      "SELECT status, scheduled_at, platform, business_id, body FROM content_posts WHERE id = ? AND data_kind = 'actual'",
      [id],
    );
    if (!row) throw new InputError("投稿が見つかりません");
    if (!canTransitionContent(row.status, to)) throw new InputError("この状態には変更できません（承認を飛ばすことはできません）");
    if (to === "scheduled" && !row.scheduled_at) throw new InputError("予定日が入っていない投稿は予約にできません");
    const autoX = row.platform === "x" && row.business_id === "ai-ceo-project";
    const autoIg = row.platform === "instagram" && row.business_id === "ai-ceo-project";
    if (to === "scheduled" && autoX) {
      const problem = checkXText(row.body);
      if (problem) throw new InputError(`予約できません：${problem}`);
    }
    if (to === "scheduled" && autoIg) {
      const ex = await get<{ extra: string | null }>(db, "SELECT extra FROM content_posts WHERE id = ?", [id]);
      const problem = checkInstagram(row.body, parseExtra(ex?.extra).slides ?? []);
      if (problem) throw new InputError(`予約できません：${problem}`);
    }
    await batch(db, [
      { sql: "UPDATE content_posts SET status = ? WHERE id = ?", args: [to, id] },
      repo.auditStmt("owner", "content.status", `content:${id}`, { from: row.status, to }),
    ]);
    if (to === "scheduled")
      return autoX ? "予約しました。予定の時刻になったら X に自動で投稿します"
        : autoIg ? "予約しました。予定の時刻になったら Instagram に自動で投稿します"
        : "予約済みにしました（この投稿先は自動投稿しないため、予定日に手で投稿してください）";
    return "状態を更新しました";
  });
}

function postTime(fd: FormData): string | null {
  const t = str(fd, "post_time");
  if (!t) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new InputError("時刻の形式が正しくありません（例 08:00）");
  return t;
}

function autoXRow(r: { platform: string; business_id: string | null }): boolean {
  return r.platform === "x" && r.business_id === "ai-ceo-project";
}

export async function updateContent(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const row = await get<{ status: string; platform: string; business_id: string | null }>(
      db,
      "SELECT status, platform, business_id FROM content_posts WHERE id = ? AND data_kind = 'actual'",
      [id],
    );
    if (!row) throw new InputError("投稿が見つかりません");
    if (!["draft", "pending_approval", "approved", "scheduled", "failed"].includes(row.status)) throw new InputError("投稿済みのものは編集できません");
    const body = str(fd, "body", { max: 20000 });
    const scheduled = str(fd, "scheduled_at");
    if (scheduled && !isYmd(scheduled)) throw new InputError("予定日の形式が正しくありません");
    // 予約中のXを書き換えたら、投稿前の確認をもう一度通す
    if (row.status === "scheduled" && autoXRow(row)) {
      const problem = checkXText(body);
      if (problem) throw new InputError(`保存できません：${problem}`);
    }
    // Instagram：スライドの文字も直せる
    let extraUpdate: string | null = null;
    if (row.platform === "instagram") {
      const cur = await get<{ extra: string | null }>(db, "SELECT extra FROM content_posts WHERE id = ?", [id]);
      const ex = parseExtra(cur?.extra);
      const slides = (ex.slides ?? []).map((sl, i) => ({
        heading: fd.has(`slide_heading_${i}`) ? str(fd, `slide_heading_${i}`, { max: 40 }) : sl.heading,
        text: fd.has(`slide_text_${i}`) ? str(fd, `slide_text_${i}`, { max: 160 }) : sl.text,
      }));
      extraUpdate = JSON.stringify({ ...ex, slides });
    }
    // 失敗したものを直したら、承認済みに戻す（もう一度「予約」を押すと投稿される）
    let nextStatus = row.status === "failed" ? "approved" : row.status;
    // 「保存して予約」：承認済み（または予約済み）のものだけ。承認は飛ばさない
    const thenSchedule = str(fd, "then") === "schedule";
    const autoX = row.platform === "x" && row.business_id === "ai-ceo-project";
    if (thenSchedule) {
      if (nextStatus !== "approved" && nextStatus !== "scheduled") throw new InputError("承認してから予約してください");
      if (!scheduled) throw new InputError("予定日を入れてください");
      if (autoX) {
        const problem = checkXText(body);
        if (problem) throw new InputError(`予約できません（本文は保存していません）：${problem}`);
      }
      if (row.platform === "instagram" && row.business_id === "ai-ceo-project") {
        const problem = checkInstagram(body, parseExtra(extraUpdate).slides ?? []);
        if (problem) throw new InputError(`予約できません（本文は保存していません）：${problem}`);
      }
      nextStatus = "scheduled";
    }
    await batch(db, [
      ...(extraUpdate ? [{ sql: "UPDATE content_posts SET extra = ? WHERE id = ?", args: [extraUpdate, id] }] : []),
      {
        // 【 】を書き換えたら、その注意書きは消す
        sql: `UPDATE content_posts SET title = ?, body = ?, scheduled_at = ?, post_time = ?, status = ?, error = NULL,
                review_note = CASE WHEN ? THEN replace(replace(review_note, char(10) || '【 】を書き換えると投稿できます', ''), '【 】を書き換えると投稿できます', '') ELSE review_note END
              WHERE id = ?`,
        args: [str(fd, "title", { max: 200, required: true }), body, scheduled || null, postTime(fd), nextStatus, /[【】]/.test(body + (extraUpdate ?? "")) ? 0 : 1, id],
      },
      repo.auditStmt("owner", thenSchedule ? "content.edited_scheduled" : "content.edited", `content:${id}`),
    ]);
    if (thenSchedule)
      return autoX ? "保存して予約しました。予定の時刻に X へ自動で投稿します"
        : row.platform === "instagram" && row.business_id === "ai-ceo-project" ? "保存して予約しました。予定の時刻に Instagram へ自動で投稿します"
        : "保存して予約しました（この投稿先は手で投稿してください）";
    return "保存しました";
  });
}

export async function setXAutopost(fd: FormData): Promise<void> {
  return act("/settings", async (db) => {
    const on = str(fd, "on") === "true";
    const limit = int(fd, "x_daily_limit", { min: 1, max: 10, optional: true });
    await batch(db, [
      repo.setSettingStmt("x_autopost_enabled", on ? "true" : "false"),
      ...(limit ? [repo.setSettingStmt("x_daily_limit", String(limit))] : []),
      repo.auditStmt("owner", "x.autopost_toggled", "", { on, limit }),
    ]);
    return on ? "X の自動投稿をONにしました（承認して予約した投稿だけが、予定の時刻に投稿されます）" : "X の自動投稿をOFFにしました";
  });
}

export async function markPostedManually(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const url = str(fd, "url", { max: 500 });
    if (url && !/^https:\/\//.test(url)) throw new InputError("投稿のURLは https:// で始めてください");
    const row = await get<{ status: string }>(db, "SELECT status FROM content_posts WHERE id = ? AND data_kind = 'actual'", [id]);
    if (!row) throw new InputError("投稿が見つかりません");
    // 承認済み・予約済みのものだけ「投稿した」と記録できる（承認なしの投稿を記録させない）
    if (row.status !== "approved" && row.status !== "scheduled") throw new InputError("承認済みの投稿だけ「投稿した」と記録できます");
    await batch(db, [
      { sql: "UPDATE content_posts SET status = 'posted', posted_at = ?, url = ? WHERE id = ?", args: [jstDate(), url || null, id] },
      repo.auditStmt("owner", "content.posted_manually", `content:${id}`, url),
    ]);
    return "投稿済みとして記録しました";
  });
}

export async function addMetric(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const metric = oneOf(str(fd, "metric"), ["followers", "article_views", "profile_visits", "link_clicks"] as const, "指標");
    const account = oneOf(str(fd, "account"), ACCOUNTS.map((a) => a.id), "アカウント");
    const platform = oneOf(str(fd, "platform"), PLATFORMS, "SNS");
    const value = int(fd, "value", { min: 0, max: 1_000_000_000 })!;
    await batch(db, [
      {
        sql: `INSERT INTO metrics (metric, account, platform, date, value, source, data_kind) VALUES (?, ?, ?, ?, ?, 'manual', 'actual')
              ON CONFLICT(metric, account, platform, date, data_kind) DO UPDATE SET value = excluded.value`,
        args: [metric, account, platform, date(fd, "date"), value],
      },
      repo.auditStmt("owner", "metric.recorded", `${metric}:${account}:${platform}`, { value }),
    ]);
    return "数値を記録しました";
  });
}

export async function addInquiry(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const category = oneOf(str(fd, "category"), ["purchase", "usage", "bug", "refund", "partnership", "other"] as const, "分類");
    // 返金の問い合わせは必ず代表者判断にする（PART 3：重要な判断は代表者に確認）
    const status = category === "refund" ? "needs_owner" : "new";
    await batch(db, [
      {
        sql: "INSERT INTO inquiries (received_at, channel, category, status, summary, data_kind) VALUES (?, ?, ?, ?, ?, 'actual')",
        args: [date(fd, "received_at"), str(fd, "channel", { max: 50 }), category, status, str(fd, "summary", { max: 500 })],
      },
      repo.auditStmt("owner", "inquiry.added", category),
    ]);
    return status === "needs_owner" ? "記録しました（返金の問い合わせのため「代表者判断」にしました）" : "問い合わせを記録しました";
  });
}

export async function updateInquiry(fd: FormData): Promise<void> {
  return act("/marketing", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const status = oneOf(str(fd, "status"), ["new", "in_progress", "needs_owner", "closed"] as const, "状態");
    await batch(db, [
      { sql: "UPDATE inquiries SET status = ? WHERE id = ? AND data_kind = 'actual'", args: [status, id] },
      repo.auditStmt("owner", "inquiry.status", `inquiry:${id}`, status),
    ]);
  });
}

export async function importAutopostNow(): Promise<void> {
  return act("/marketing", async (db) => {
    const since = await repo.lastImportedDate(db, AUTOPOST_SOURCE);
    const r = await importAutopostFromGitHub(db, { since });
    return `自動投稿の結果を取り込みました（${r.checkedDays}日分を確認：新規 ${r.inserted}件／更新 ${r.updated}件）`;
  });
}

// ---------- 経営会議・タスク ----------
export async function runMeeting(): Promise<void> {
  await requireAuth();
  const db = await getDb();
  const id = await saveMeeting(db, await buildMeetingReport(db));
  revalidatePath("/", "layout");
  redirect(`/reports/${id}`);
}

export async function updateTask(fd: FormData): Promise<void> {
  return act("/reports", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const status = oneOf(str(fd, "status"), ["todo", "doing", "done", "cancelled"] as const, "状態");
    await batch(db, [{ sql: "UPDATE tasks SET status = ? WHERE id = ?", args: [status, id] }, repo.auditStmt("owner", "task.status", `task:${id}`, status)]);
    return "タスクを更新しました";
  });
}

export async function addTask(fd: FormData): Promise<void> {
  return act("/reports", async (db) => {
    const due = str(fd, "due_date");
    if (due && !isYmd(due)) throw new InputError("期限の形式が正しくありません");
    await batch(db, [
      {
        sql: "INSERT INTO tasks (title, detail, owner, due_date, source) VALUES (?, ?, 'owner', ?, 'manual')",
        args: [str(fd, "title", { max: 200, required: true }), str(fd, "detail", { max: 1000 }), due || null],
      },
      repo.auditStmt("owner", "task.created"),
    ]);
    return "タスクを追加しました";
  });
}

// ---------- 設定 ----------
export async function updateSettings(fd: FormData): Promise<void> {
  return act("/settings", async (db) => {
    const before = await repo.getSettings(db);
    const next: Record<string, string> = {
      monthly_budget_jpy: String(int(fd, "monthly_budget_jpy", { min: 0, max: 1_000_000 })),
      ai_api_monthly_cap_jpy: String(int(fd, "ai_api_monthly_cap_jpy", { min: 0, max: 1_000_000 })),
      usd_jpy: String(int(fd, "usd_jpy", { min: 50, max: 500 })),
    };
    const warn = Number(str(fd, "budget_warn_ratio"));
    if (!(warn >= 0.5 && warn <= 0.95)) throw new InputError("警告ラインは0.5〜0.95で入力してください");
    next.budget_warn_ratio = String(warn);
    if (Number(next.ai_api_monthly_cap_jpy) > Number(next.monthly_budget_jpy)) throw new InputError("AI API の上限は月間運営予算以下にしてください");
    await batch(db, [
      ...Object.entries(next).map(([k, v]) => repo.setSettingStmt(k, v)),
      repo.auditStmt("owner", "settings.updated", "", {
        before: Object.fromEntries(Object.keys(next).map((k) => [k, before[k]])),
        after: next,
      }),
    ]);
    return "設定を保存しました";
  });
}

export async function setAutomation(fd: FormData): Promise<void> {
  return act("/settings", async (db) => {
    const on = str(fd, "on") === "true";
    await batch(db, [repo.setSettingStmt("automation_enabled", on ? "true" : "false"), repo.auditStmt("owner", "automation.toggled", "", on ? "ON" : "OFF")]);
    return on ? "自動実行をONにしました（AI社員が未接続のため、現在は何も実行されません）" : "自動実行をOFFにしました";
  });
}

// ---------- AI社員の実行 ----------
const RUNNABLE: Record<string, string> = { "ceo.meeting": "ceo", "research.ideas": "research", "marketing.drafts": "marketing", "product.component": "product", "research.competitors": "research", "system.ping": "ceo" };

/** 受付けた仕事を裏側（Netlify のバックグラウンド関数）に渡す。パソコンではその場で実行する */
async function dispatchRun(db: DB, runId: number): Promise<void> {
  if (!onNetlify()) {
    await executeRun(db, runId);
    return;
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  try {
    const r = await fetch(`${proto}://${host}${BACKGROUND_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await signDispatch(runId)),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual", // 転送（ログイン画面など）を成功と勘違いしない
    });
    // バックグラウンド関数は受け付けると 202 を返す。それ以外は失敗
    if (r.status !== 202) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    await batch(db, [
      {
        sql: "UPDATE agent_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ? AND status = 'queued'",
        args: [new Date().toISOString(), `裏側の実行を開始できませんでした（${e instanceof Error ? e.message : "不明"}）`, runId],
      },
    ]);
    throw new InputError("裏側の実行を開始できませんでした。時間をおいてもう一度押してください");
  }
}

export async function runAgentTask(fd: FormData): Promise<void> {
  const task = String(fd.get("task") ?? "");
  const agentId = RUNNABLE[task];
  if (!agentId) redirect("/agents");
  return act(task === "product.component" ? "/products" : `/agents/${agentId}`, async (db) => {
    const params: Record<string, unknown> = {};
    if (task === "research.ideas" || task === "research.competitors") params.theme = str(fd, "theme", { max: 300 });
    if (task === "system.ping") params.seconds = int(fd, "seconds", { min: 0, max: 120, optional: true }) ?? 0;
    if (task === "product.component") {
      params.productId = int(fd, "productId", { min: 1 });
      params.index = int(fd, "index", { min: 0, max: 20 });
    }
    const q = await queueRun(db, task, params, "manual");
    if (!q.ok) throw new InputError(q.reason);
    await dispatchRun(db, q.runId);
    return onNetlify()
      ? `受付けました（#${q.runId}）。終わるまで数十秒〜数分かかります。この画面は自動で更新されます`
      : `実行しました（#${q.runId}）`;
  });
}

/** X の合鍵がどのアカウントのものかを確認する（投稿はしない。X API の読み取り1回分の費用） */
export async function checkXAccount(): Promise<void> {
  return act("/settings", async (db) => {
    const cred = xCredentialsFromEnv();
    if (!cred) throw new InputError("X の合鍵が設定されていません");
    const r = await whoAmI(cred);
    if (!r.ok) {
      await batch(db, [repo.auditStmt("owner", "x.verify_failed", "", r.error)]);
      throw new InputError(`確認できませんでした：${r.error}`);
    }
    await batch(db, [repo.setSettingStmt("x_account", `@${r.username}（${r.name}）`), repo.auditStmt("owner", "x.verified", r.username)]);
    return `X の合鍵は @${r.username}（${r.name}）のものです`;
  });
}


/** 商品の構成品の本文を直す・確認済みにする（中身はデータベースにだけ保存） */
export async function updateProductDoc(fd: FormData): Promise<void> {
  return act("/products", async (db) => {
    const id = int(fd, "id", { min: 1 })!;
    const doc = await get<{ product_id: number; component_index: number; status: string }>(db, "SELECT product_id, component_index, status FROM product_docs WHERE id = ?", [id]);
    if (!doc) throw new InputError("構成品が見つかりません");
    const op = str(fd, "op");
    const body = str(fd, "body", { max: 60000 });
    const reviewed = op === "review";
    const product = await repo.getProduct(db, doc.product_id);
    const comps = product ? (JSON.parse(product.components) as { name: string; status: string }[]) : [];
    if (comps[doc.component_index]) comps[doc.component_index].status = reviewed ? "done" : "producing";
    await batch(db, [
      { sql: "UPDATE product_docs SET body = ?, status = ?, updated_at = datetime('now') WHERE id = ?", args: [body, reviewed ? "reviewed" : "draft", id] },
      { sql: "UPDATE products SET components = ?, updated_at = datetime('now') WHERE id = ?", args: [JSON.stringify(comps), doc.product_id] },
      repo.auditStmt("owner", reviewed ? "product.component_reviewed" : "product.component_edited", `product_doc:${id}`),
    ]);
    return reviewed ? "確認済みにしました" : "保存しました";
  });
}

export async function setIgAutopost(fd: FormData): Promise<void> {
  return act("/settings", async (db) => {
    const on = str(fd, "on") === "true";
    const limit = int(fd, "ig_daily_limit", { min: 1, max: 5, optional: true });
    await batch(db, [
      repo.setSettingStmt("ig_autopost_enabled", on ? "true" : "false"),
      ...(limit ? [repo.setSettingStmt("ig_daily_limit", String(limit))] : []),
      repo.auditStmt("owner", "ig.autopost_toggled", "", { on, limit }),
    ]);
    return on ? "Instagram の自動投稿をONにしました（承認して予約したカルーセルだけが、予定の時刻に投稿されます）" : "Instagram の自動投稿をOFFにしました";
  });
}

/** Instagram の合鍵がどのアカウントのものかを確認する（投稿はしない・無料） */
export async function checkIgAccount(): Promise<void> {
  return act("/settings", async (db) => {
    const token = await igToken(db);
    if (!token) throw new InputError("Instagram の合鍵が設定されていません");
    const r = await igMe(token);
    if (!r.ok) {
      await batch(db, [repo.auditStmt("owner", "ig.verify_failed", "", r.error)]);
      throw new InputError(`確認できませんでした：${r.error}`);
    }
    const userId = r.value.user_id ?? r.value.id ?? "";
    await batch(db, [
      repo.setSettingStmt("ig_account", `@${r.value.username ?? "?"}`),
      repo.setSettingStmt("ig_user_id", userId),
      repo.auditStmt("owner", "ig.verified", r.value.username ?? ""),
    ]);
    return `Instagram の合鍵は @${r.value.username} のものです`;
  });
}
