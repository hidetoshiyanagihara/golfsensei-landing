"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { requireAuth, isConfigured } from "@/lib/security/auth";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearFailures,
  isLockedOut,
  passwordMatches,
  recordFailure,
  signSession,
} from "@/lib/security/session";
import { SAMPLE_COOKIE } from "@/lib/view";
import { canPassQa, canStartSelling, canTransitionContent, totalIdeaScore, type ContentStatus } from "@/lib/rules";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/finance/calc";
import { buildMeetingReport, saveMeeting } from "@/lib/analytics/meeting";
import { isYmd, jstDate } from "@/lib/time";

// ---------- 入力チェック ----------
class InputError extends Error {}

function str(fd: FormData, key: string, { max = 2000, required = false } = {}): string {
  const v = String(fd.get(key) ?? "").trim();
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
async function run(path: string, fn: () => string | void): Promise<never> {
  await requireAuth();
  // 同じURLに戻ると画面が更新されないことがあるため、毎回ちがうURLにする（t は表示には使わない）
  const back = (key: "ok" | "err", m: string) => `${path}?${key}=${encodeURIComponent(m)}&t=${Date.now().toString(36)}`;
  let msg: string;
  try {
    msg = fn() || "保存しました";
  } catch (e) {
    if (e instanceof InputError) redirect(back("err", e.message));
    console.error(e);
    redirect(back("err", "処理に失敗しました。入力内容を確認してください。"));
  }
  revalidatePath("/", "layout");
  redirect(back("ok", msg));
}

// ---------- ログイン ----------
export async function login(fd: FormData): Promise<void> {
  if (!isConfigured()) redirect("/login?e=setup");
  const h = await headers();
  const key = (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (isLockedOut(key)) redirect("/login?e=locked");
  const ok = await passwordMatches(String(fd.get("password") ?? ""), process.env.ADMIN_PASSWORD);
  const db = getDb();
  if (!ok) {
    recordFailure(key);
    repo.audit(db, "anonymous", "auth.login_failed", key);
    redirect("/login?e=invalid");
  }
  clearFailures(key);
  const token = await signSession(process.env.SESSION_SECRET!);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  repo.audit(db, "owner", "auth.login", key);
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
  c.set(SAMPLE_COOKIE, on ? "0" : "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  const back = String(fd.get("back") ?? "/dashboard");
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/dashboard");
}

// ---------- 事業開発 ----------
const SCORE_KEYS = ["demand", "competition", "price", "profit", "difficulty", "acquisition", "recurrence"] as const;

export async function createIdea(fd: FormData): Promise<void> {
  return run("/business", () => {
    const db = getDb();
    const name = str(fd, "name", { max: 120, required: true });
    db.prepare(
      `INSERT INTO business_ideas (business_id, name, target, problem, competitors, price_hypothesis, revenue_model, dev_cost_note,
         expected_profit_note, risks, origin, approval_status, data_kind)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'pending', 'actual')`,
    ).run(
      name,
      str(fd, "target", { max: 300 }),
      str(fd, "problem", { max: 1000 }),
      str(fd, "competitors", { max: 1000 }),
      str(fd, "price_hypothesis", { max: 200 }),
      str(fd, "revenue_model", { max: 300 }),
      str(fd, "dev_cost_note", { max: 300 }),
      str(fd, "expected_profit_note", { max: 300 }),
      str(fd, "risks", { max: 1000 }),
    );
    repo.audit(db, "owner", "idea.created", name);
    return "事業アイデアを登録しました";
  });
}

export async function scoreIdea(fd: FormData): Promise<void> {
  return run("/business", () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const scores = SCORE_KEYS.map((k) => int(fd, `score_${k}`, { min: 0, max: 100, optional: true }));
    const sourceUrl = str(fd, "source_url", { max: 500 });
    if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) throw new InputError("情報源のURLは http(s):// で始めてください");
    const note = str(fd, "evaluation_note", { max: 2000 });
    const total = totalIdeaScore(scores);
    const row = db.prepare("SELECT sources FROM business_ideas WHERE id = ?").get(id) as { sources: string } | undefined;
    if (!row) throw new InputError("アイデアが見つかりません");
    const sources = JSON.parse(row.sources) as unknown[];
    if (sourceUrl)
      sources.push({ title: str(fd, "source_title", { max: 200 }) || sourceUrl, url: sourceUrl, accessed_at: jstDate(), kind: str(fd, "source_kind") === "estimate" ? "estimate" : "fact" });
    db.prepare(
      `UPDATE business_ideas SET score_demand=?, score_competition=?, score_price=?, score_profit=?, score_difficulty=?,
         score_acquisition=?, score_recurrence=?, total_score=?, evaluation_note=?, sources=? WHERE id=?`,
    ).run(...scores, total, note, JSON.stringify(sources), id);
    repo.audit(db, "owner", "idea.scored", `idea:${id}`, { total });
    return total === null ? "評価を保存しました（未入力の項目があるため合計点は未算出）" : `評価を保存しました（${total}点）`;
  });
}

export async function decideIdea(fd: FormData): Promise<void> {
  return run("/business", () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const decision = oneOf(str(fd, "decision"), ["approved", "rejected", "on_hold", "pending"] as const, "判断");
    db.prepare("UPDATE business_ideas SET approval_status = ?, decided_at = datetime('now') WHERE id = ?").run(decision, id);
    repo.audit(db, "owner", "idea.decided", `idea:${id}`, decision);
    return "判断を記録しました";
  });
}

// ---------- 商品 ----------
export async function updateProduct(fd: FormData): Promise<void> {
  return run("/products", () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const op = str(fd, "op", { required: true });
    const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id) as repo.ProductRow | undefined;
    if (!p) throw new InputError("商品が見つかりません");
    const checklist = repo.parseChecklist(p.qa_checklist);
    const state = { ...p, qa_checklist: checklist };
    const set = (sql: string, ...args: unknown[]) =>
      db.prepare(`UPDATE products SET ${sql}, updated_at = datetime('now') WHERE id = ?`).run(...args, id);

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
        // 検査項目を変えたら、合格・承認はやり直し
        set("qa_checklist = ?, qa_status = CASE WHEN qa_status = 'passed' THEN 'in_progress' ELSE qa_status END, owner_approved_at = NULL", JSON.stringify(next));
        if (p.sales_status === "on_sale") set("sales_status = 'stopped'");
        break;
      }
      case "qa_pass": {
        const r = canPassQa(state);
        if (!r.ok) throw new InputError(r.reason!);
        set("qa_status = 'passed'");
        break;
      }
      case "qa_fail":
        set("qa_status = 'failed', owner_approved_at = NULL");
        break;
      case "approve": {
        if (p.qa_status !== "passed") throw new InputError("品質検査に合格してから承認してください");
        set("owner_approved_at = datetime('now'), sales_status = CASE WHEN sales_status = 'not_for_sale' THEN 'ready' ELSE sales_status END");
        break;
      }
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
        set("price_jpy = ?, price_is_tentative = ?", price, fd.get("tentative") ? 1 : 0);
        break;
      }
      default:
        throw new InputError("不明な操作です");
    }
    repo.audit(db, "owner", `product.${op}`, `product:${id}`, Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith("$"))));
    return "商品を更新しました";
  });
}

// ---------- 財務 ----------
export async function addSale(fd: FormData): Promise<void> {
  return run("/finance", () => {
    const db = getDb();
    const productId = int(fd, "product_id", { min: 1, optional: true });
    const gross = int(fd, "gross_jpy")!;
    const refund = int(fd, "refund_jpy", { optional: true }) ?? 0;
    if (refund > gross) throw new InputError("返金額が売上額を超えています");
    db.prepare(
      "INSERT INTO sales (product_id, sold_at, quantity, gross_jpy, payment_fee_jpy, refund_jpy, channel, note, data_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'actual')",
    ).run(
      productId,
      date(fd, "sold_at"),
      int(fd, "quantity", { min: 1, max: 10000, optional: true }) ?? 1,
      gross,
      int(fd, "payment_fee_jpy", { optional: true }) ?? 0,
      refund,
      str(fd, "channel", { max: 50 }),
      str(fd, "note", { max: 300 }),
    );
    repo.audit(db, "owner", "sale.added", `product:${productId ?? "-"}`, { gross, refund });
    return "売上を記録しました";
  });
}

export async function addExpense(fd: FormData): Promise<void> {
  return run("/finance", () => {
    const db = getDb();
    const category = oneOf(str(fd, "category"), Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[], "費目");
    const amount = int(fd, "amount_jpy")!;
    db.prepare("INSERT INTO expenses (spent_at, category, vendor, amount_jpy, note, data_kind) VALUES (?, ?, ?, ?, ?, 'actual')").run(
      date(fd, "spent_at"),
      category,
      str(fd, "vendor", { max: 100 }),
      amount,
      str(fd, "note", { max: 300 }),
    );
    repo.audit(db, "owner", "expense.added", category, { amount });
    return "費用を記録しました";
  });
}

const DELETABLE = { sales: "/finance", expenses: "/finance", metrics: "/marketing", inquiries: "/marketing" } as const;

export async function deleteRecord(fd: FormData): Promise<void> {
  const table = oneOfSafe(String(fd.get("table") ?? ""));
  return run(DELETABLE[table], () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND data_kind = 'actual'`).get(id);
    if (!row) throw new InputError("記録が見つかりません");
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    repo.audit(db, "owner", `${table}.deleted`, `${table}:${id}`, row);
    return "記録を削除しました（削除内容は操作ログに残っています）";
  });
}

function oneOfSafe(t: string): keyof typeof DELETABLE {
  if (t in DELETABLE) return t as keyof typeof DELETABLE;
  redirect("/dashboard");
}

// ---------- コンテンツ・指標・問い合わせ ----------
const PLATFORMS = ["x", "instagram", "youtube", "note", "linkedin", "other"] as const;

export async function createDraft(fd: FormData): Promise<void> {
  return run("/marketing", () => {
    const db = getDb();
    const platform = oneOf(str(fd, "platform"), PLATFORMS, "投稿先");
    const scheduled = str(fd, "scheduled_at");
    if (scheduled && !isYmd(scheduled)) throw new InputError("予定日の形式が正しくありません");
    db.prepare(
      "INSERT INTO content_posts (business_id, platform, status, title, body, scheduled_at, source, data_kind) VALUES ('ai-business-lab', ?, 'draft', ?, ?, ?, 'manual', 'actual')",
    ).run(platform, str(fd, "title", { max: 200, required: true }), str(fd, "body", { max: 20000 }), scheduled || null);
    repo.audit(db, "owner", "content.draft_created", platform);
    return "下書きを保存しました";
  });
}

export async function transitionContent(fd: FormData): Promise<void> {
  return run("/marketing", () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const to = str(fd, "to") as ContentStatus;
    const row = db.prepare("SELECT status, scheduled_at FROM content_posts WHERE id = ?").get(id) as { status: ContentStatus; scheduled_at: string | null } | undefined;
    if (!row) throw new InputError("投稿が見つかりません");
    if (!canTransitionContent(row.status, to)) throw new InputError("この状態には変更できません（承認を飛ばすことはできません）");
    if (to === "scheduled" && !row.scheduled_at) throw new InputError("予定日が入っていない投稿は予約にできません");
    db.prepare("UPDATE content_posts SET status = ? WHERE id = ?").run(to, id);
    repo.audit(db, "owner", "content.status", `content:${id}`, { from: row.status, to });
    return to === "scheduled"
      ? "予約済みにしました（自動投稿の接続はPHASE 4。それまでは予定日に手動で投稿してください）"
      : "状態を更新しました";
  });
}

export async function addMetric(fd: FormData): Promise<void> {
  return run("/marketing", () => {
    const db = getDb();
    const metric = oneOf(str(fd, "metric"), ["followers", "article_views", "profile_visits", "link_clicks"] as const, "指標");
    const platform = oneOf(str(fd, "platform"), PLATFORMS, "SNS");
    const value = int(fd, "value", { min: 0, max: 1_000_000_000 })!;
    db.prepare(
      `INSERT INTO metrics (metric, platform, date, value, source, data_kind) VALUES (?, ?, ?, ?, 'manual', 'actual')
       ON CONFLICT(metric, platform, date, data_kind) DO UPDATE SET value = excluded.value`,
    ).run(metric, platform, date(fd, "date"), value);
    repo.audit(db, "owner", "metric.recorded", `${metric}:${platform}`, { value });
    return "数値を記録しました";
  });
}

export async function addInquiry(fd: FormData): Promise<void> {
  return run("/marketing", () => {
    const db = getDb();
    const category = oneOf(str(fd, "category"), ["purchase", "usage", "bug", "refund", "partnership", "other"] as const, "分類");
    // 返金の問い合わせは必ず代表者判断にする（PART 3：重要な判断は代表者に確認）
    const status = category === "refund" ? "needs_owner" : "new";
    db.prepare("INSERT INTO inquiries (received_at, channel, category, status, summary, data_kind) VALUES (?, ?, ?, ?, ?, 'actual')").run(
      date(fd, "received_at"),
      str(fd, "channel", { max: 50 }),
      category,
      status,
      str(fd, "summary", { max: 500 }),
    );
    repo.audit(db, "owner", "inquiry.added", category);
    return status === "needs_owner" ? "記録しました（返金の問い合わせのため「代表者判断」にしました）" : "問い合わせを記録しました";
  });
}

export async function updateInquiry(fd: FormData): Promise<void> {
  return run("/marketing", () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const status = oneOf(str(fd, "status"), ["new", "in_progress", "needs_owner", "closed"] as const, "状態");
    db.prepare("UPDATE inquiries SET status = ? WHERE id = ? AND data_kind = 'actual'").run(status, id);
    repo.audit(db, "owner", "inquiry.status", `inquiry:${id}`, status);
  });
}

// ---------- 経営会議・タスク ----------
export async function runMeeting(): Promise<void> {
  await requireAuth();
  const db = getDb();
  const id = saveMeeting(db, buildMeetingReport(db));
  revalidatePath("/", "layout");
  redirect(`/reports/${id}`);
}

export async function updateTask(fd: FormData): Promise<void> {
  const back = str(fd, "back") === "/dashboard" ? "/dashboard" : "/reports";
  return run(back, () => {
    const db = getDb();
    const id = int(fd, "id", { min: 1 })!;
    const status = oneOf(str(fd, "status"), ["todo", "doing", "done", "cancelled"] as const, "状態");
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
    repo.audit(db, "owner", "task.status", `task:${id}`, status);
    return "タスクを更新しました";
  });
}

export async function addTask(fd: FormData): Promise<void> {
  return run("/reports", () => {
    const db = getDb();
    const due = str(fd, "due_date");
    if (due && !isYmd(due)) throw new InputError("期限の形式が正しくありません");
    db.prepare("INSERT INTO tasks (title, detail, owner, due_date, source) VALUES (?, ?, 'owner', ?, 'manual')").run(
      str(fd, "title", { max: 200, required: true }),
      str(fd, "detail", { max: 1000 }),
      due || null,
    );
    repo.audit(db, "owner", "task.created");
    return "タスクを追加しました";
  });
}

// ---------- 設定 ----------
export async function updateSettings(fd: FormData): Promise<void> {
  return run("/settings", () => {
    const db = getDb();
    const before = repo.getSettings(db);
    const next: Record<string, string> = {
      monthly_budget_jpy: String(int(fd, "monthly_budget_jpy", { min: 0, max: 1_000_000 })),
      ai_api_monthly_cap_jpy: String(int(fd, "ai_api_monthly_cap_jpy", { min: 0, max: 1_000_000 })),
      usd_jpy: String(int(fd, "usd_jpy", { min: 50, max: 500 })),
    };
    const warn = Number(str(fd, "budget_warn_ratio"));
    if (!(warn >= 0.5 && warn <= 0.95)) throw new InputError("警告ラインは0.5〜0.95で入力してください");
    next.budget_warn_ratio = String(warn);
    if (Number(next.ai_api_monthly_cap_jpy) > Number(next.monthly_budget_jpy))
      throw new InputError("AI API の上限は月間運営予算以下にしてください");
    db.transaction(() => {
      for (const [k, v] of Object.entries(next)) repo.setSetting(db, k, v);
    })();
    repo.audit(db, "owner", "settings.updated", "", {
      before: Object.fromEntries(Object.keys(next).map((k) => [k, before[k]])),
      after: next,
    });
    return "設定を保存しました";
  });
}

export async function setAutomation(fd: FormData): Promise<void> {
  return run("/settings", () => {
    const db = getDb();
    const on = str(fd, "on") === "true";
    repo.setSetting(db, "automation_enabled", on ? "true" : "false");
    repo.audit(db, "owner", "automation.toggled", "", on ? "ON" : "OFF");
    return on ? "自動実行をONにしました（AI社員が未接続のため、現在は何も実行されません）" : "自動実行をOFFにしました";
  });
}
