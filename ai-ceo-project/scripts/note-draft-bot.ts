/**
 * note の下書き保存ロボット（GitHub Actions から1時間ごとに実行）。
 * 管理画面で「note に下書き保存を頼む」を押した記事だけを、note の公式の編集画面を人と同じように操作して「下書き」に保存する。
 * 公開はしない（公開は代表者が note で行う）。
 *
 * 必要な環境変数（GitHub の Secrets）：NOTE_EMAIL / NOTE_PASSWORD / TURSO_AUTH_TOKEN（と TURSO_DATABASE_URL）
 * このリポジトリは公開されているため、ログにメールアドレス・パスワード・記事の本文を出さない。
 *
 * 使い方：
 *   npx tsx scripts/note-draft-bot.ts            … 頼まれた記事を保存する
 *   npx tsx scripts/note-draft-bot.ts --explore  … ログインして編集画面のボタン名などを調べるだけ（保存しない）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb, all, run, type DB } from "../lib/database/db";
import { markdownToHtml } from "../lib/marketing/note-format";
import { signNoteImage } from "../lib/marketing/note-image-sign";

// playwright は GitHub Actions の中でだけ入れる（このプロジェクトの依存には入れない）ため、型は最小限
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: any };

const APP = process.env.APP_URL ?? "https://ai-ceo-command.netlify.app";
const MAX_PER_RUN = 2;
const explore = process.argv.includes("--explore");

function log(msg: string) {
  // 個人情報や本文は出さない
  console.log(`[note-bot] ${msg}`);
}

async function setDraft(db: DB, id: number, state: Record<string, unknown>) {
  const row = (await all<{ extra: string | null }>(db, "SELECT extra FROM content_posts WHERE id = ?", [id]))[0];
  const extra = row?.extra ? JSON.parse(row.extra) : {};
  extra.note_draft = { ...state, at: new Date().toISOString() };
  await run(db, "UPDATE content_posts SET extra = ? WHERE id = ?", [JSON.stringify(extra), id]);
  await run(db, "INSERT INTO audit_log (actor, action, target, detail) VALUES ('bot:note', ?, ?, ?)", [`note.draft_${state.status}`, `content:${id}`, String(state.message ?? "")]);
}

async function describe(page: Page, label: string) {
  // 画面の部品の名前だけを記録する（入力された値は出さない）
  const info = await page.evaluate(() => {
    const t = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return {
      url: location.hostname + location.pathname.replace(/\/[a-z0-9]{10,}/gi, "/:id"),
      buttons: [...document.querySelectorAll("button")].map((b) => t(b.getAttribute("aria-label") || b.textContent)).filter(Boolean).slice(0, 40),
      inputs: [...document.querySelectorAll("input,textarea,[contenteditable=true]")].map((e) => `${e.tagName.toLowerCase()}[${t(e.getAttribute("placeholder") || e.getAttribute("aria-label") || e.getAttribute("type") || e.className.toString().slice(0, 30))}]`).slice(0, 20),
    };
  });
  log(`${label}: ${JSON.stringify(info)}`);
}

async function login(page: Page) {
  await page.goto("https://note.com/login", { waitUntil: "domcontentloaded" });
  await page.locator("input[name=login]").fill(process.env.NOTE_EMAIL ?? "");
  await page.locator("input[name=password]").fill(process.env.NOTE_PASSWORD ?? "");
  // Google・X・Apple でのログインボタンもあるため、メールでのログイン（送信ボタン）を押す
  await page.locator("button[type=submit]").filter({ hasText: "ログイン" }).first().click();
  await page.waitForURL((u: URL) => !u.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
  if (new URL(page.url()).pathname.startsWith("/login")) {
    await describe(page, "login-failed");
    throw new Error("note にログインできませんでした（メール・パスワード、または確認メールを確認してください）");
  }
  log("logged in");
}

async function openEditor(page: Page) {
  await page.goto("https://note.com/notes/new", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForSelector("[contenteditable=true], textarea", { timeout: 30000 });
}

async function fillTitle(page: Page, title: string) {
  const candidates = [
    page.locator("textarea[placeholder*='タイトル']"),
    page.locator("input[placeholder*='タイトル']"),
    page.locator("[contenteditable=true][data-placeholder*='タイトル']"),
    page.locator("textarea").first(),
  ];
  for (const c of candidates) {
    if ((await c.count()) > 0) {
      await c.first().click();
      await c.first().fill(title);
      return;
    }
  }
  throw new Error("タイトルの入力欄が見つかりませんでした");
}

async function pasteBody(page: Page, html: string, plain: string) {
  const body = page.locator(".ProseMirror[contenteditable=true], [contenteditable=true]").last();
  await body.click();
  // 編集欄に「HTMLを貼り付けた」ことにする（クリップボードは使わない）
  await body.evaluate(
    (el: HTMLElement, data: { html: string; plain: string }) => {
      const dt = new DataTransfer();
      dt.setData("text/html", data.html);
      dt.setData("text/plain", data.plain);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { html, plain },
  );
  await page.waitForTimeout(1500);
  const len = await body.evaluate((el: HTMLElement) => (el.textContent ?? "").length);
  if (len < Math.min(50, plain.length / 2)) throw new Error("本文を貼り付けられませんでした");
}

async function setHeaderImage(page: Page, file: string): Promise<boolean> {
  const tries = [
    page.getByRole("button", { name: /見出し画像|画像を追加|カバー/ }),
    page.locator("button[aria-label*='画像']"),
  ];
  for (const t of tries) {
    if ((await t.count()) === 0) continue;
    try {
      const chooserP = page.waitForEvent("filechooser", { timeout: 8000 });
      await t.first().click();
      const chooser = await chooserP;
      await chooser.setFiles(file);
      // 切り抜きの確認が出たら決定する
      const ok = page.getByRole("button", { name: /保存|決定|完了|OK/ });
      await ok.first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
      return true;
    } catch {
      // 次の候補を試す
    }
  }
  return false;
}

async function saveDraft(page: Page): Promise<string> {
  const btn = page.getByRole("button", { name: /下書き保存/ });
  if ((await btn.count()) > 0) await btn.first().click();
  await page.waitForTimeout(3000);
  return page.url();
}

async function downloadHeader(id: number): Promise<string | null> {
  const q = signNoteImage(id, "header", 0, 600);
  if (!q) return null;
  const r = await fetch(`${APP}/api/note-image/${id}?kind=header&${q}`);
  if (!r.ok) return null;
  const file = path.join(os.tmpdir(), `note-header-${id}.png`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

async function main() {
  if (!process.env.NOTE_EMAIL || !process.env.NOTE_PASSWORD) throw new Error("NOTE_EMAIL / NOTE_PASSWORD が設定されていません");
  const db = await openDb();
  const jobs = explore
    ? []
    : await all<{ id: number; title: string; body: string; extra: string | null }>(
        db,
        `SELECT id, title, body, extra FROM content_posts
         WHERE platform = 'note' AND data_kind = 'actual' AND status IN ('approved','scheduled')
           AND json_extract(extra, '$.note_draft.status') = 'requested'
         ORDER BY id LIMIT ?`,
        [MAX_PER_RUN],
      );
  if (!explore && jobs.length === 0) {
    log("頼まれた記事はありません");
    return;
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1280, height: 900 } });
  // tsx（esbuild）が関数に付ける __name をブラウザ側でも使えるようにする（page.evaluate のエラー対策）
  await ctx.addInitScript({ content: "window.__name = (f) => f;" });
  const page = await ctx.newPage();
  try {
    await login(page);
    if (explore) {
      await openEditor(page);
      await describe(page, "editor");
      log("explore: 保存はしていません");
      return;
    }
    for (const j of jobs) {
      log(`content:${j.id} を保存します`);
      await setDraft(db, j.id, { status: "saving" });
      try {
        await openEditor(page);
        const title = j.title.replace(/^note[①-⑩\d]*[：:]\s*/, "");
        await fillTitle(page, title);
        const header = await downloadHeader(j.id);
        const headerOk = header ? await setHeaderImage(page, header) : false;
        await pasteBody(page, markdownToHtml(j.body), j.body);
        const url = await saveDraft(page);
        const editUrl = /note\.com/.test(url) ? url : undefined;
        await setDraft(db, j.id, {
          status: "saved",
          url: editUrl,
          message: headerOk ? "図解は「▼ここに図◯」の場所に手で入れてください" : "見出し画像は入れられなかったので、手で設定してください。図解も手で入れてください",
        });
        log(`content:${j.id} 保存しました（見出し画像：${headerOk ? "あり" : "なし"}）`);
      } catch (e) {
        await describe(page, "error-screen").catch(() => {});
        const message = e instanceof Error ? e.message.slice(0, 200) : "不明なエラー";
        await setDraft(db, j.id, { status: "error", message });
        log(`content:${j.id} 失敗：${message}`);
      }
    }
  } finally {
    await browser.close();
    db.close();
  }
}

main().catch((e) => {
  console.error(`[note-bot] ${e instanceof Error ? e.message : "error"}`);
  process.exit(1);
});
