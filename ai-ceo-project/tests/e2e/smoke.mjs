/**
 * 通しテスト：本番ビルド（next start）を一時DBで起動し、ブラウザで実際に操作する。
 * 事前に `npm run build` が必要。実データのDB（data/）には触れない。
 *   npm run test:e2e
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Playwright は開発環境に入っているものを使う（無い場合は `npm i -D playwright && npx playwright install chromium`）
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "e2e-test-password-123";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-"));
const shots = path.join(process.cwd(), "tests", "e2e", "screenshots");
fs.mkdirSync(shots, { recursive: true });

const env = {
  ...process.env,
  DB_PATH: path.join(tmp, "e2e.db"),
  ADMIN_PASSWORD: PASSWORD,
  SESSION_SECRET: "e2e-secret-".padEnd(48, "x"),
  NODE_ENV: "production",
};

// 一時DBに実データ（自動投稿の結果）を取り込んでおく
await run("npx", ["tsx", "scripts/import-repo-data.ts"], env);

const server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓", msg);
  else {
    failures++;
    console.log("  ✗", msg);
  }
};

try {
  await waitFor(`${BASE}/login`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  console.log("認証");
  await page.goto(`${BASE}/dashboard`);
  check(page.url().endsWith("/login"), "未ログインはログイン画面に戻される");
  const r = await page.request.get(`${BASE}/finance`, { maxRedirects: 0 });
  check(r.status() === 307 || r.status() === 302, "未ログインのAPIアクセスもリダイレクト");
  await page.fill("#password", "wrong-password");
  await page.click("button[type=submit]");
  await page.waitForURL(/e=invalid/);
  check((await page.locator("p[role=alert]").textContent())?.includes("違います"), "間違ったパスワードは拒否");
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/dashboard");
  check(true, "正しいパスワードでログイン");
  const cookie = (await ctx.cookies()).find((c) => c.name === "cc_session");
  check(cookie?.httpOnly === true, "セッションCookieは httpOnly");

  console.log("全画面の表示");
  for (const p of ["/dashboard", "/agents", "/agents/ceo", "/business", "/products", "/marketing", "/finance", "/reports", "/settings"]) {
    const res = await page.goto(`${BASE}${p}`);
    const text = await page.textContent("body");
    check(res.status() === 200 && !text.includes("Application error") && !/[�]/.test(text), `${p} が表示できる（文字化けなし）`);
  }
  await page.goto(`${BASE}/dashboard`);
  check((await page.textContent("body")).includes("¥0"), "ダッシュボードの売上は実績0円");
  await page.goto(`${BASE}/finance`);
  check((await page.textContent("body")).includes("約¥722"), "note・カード決済の手数料の目安（4,980円→約722円）が出る");
  await page.goto(`${BASE}/dashboard`);
  check((await page.textContent("body")).includes("自動投稿の結果を取り込んだ実績"), "取り込んだ投稿実績が表示される");
  await page.screenshot({ path: path.join(shots, "dashboard-desktop.png"), fullPage: true });

  console.log("承認ルール");
  await page.goto(`${BASE}/products`);
  check(await page.locator("button[value=start_selling]").isDisabled(), "品質検査前は「販売開始」を押せない");
  check(await page.locator("button[value=qa_pass]").isDisabled(), "検査項目が残っている間は「合格」を押せない");
  await act(page, () => page.locator("form:has(input[value=qa_item]) button").first().click());
  check((await page.locator("button[aria-pressed=true]").count()) === 1, "品質チェック項目にチェックできる");

  console.log("財務：売上と利益");
  await page.goto(`${BASE}/finance`);
  await page.selectOption("#s-product", { index: 1 });
  await page.fill("#s-gross", "4980");
  await page.fill("#s-fee", "500");
  await act(page, () => page.click("form:has(#s-gross) button[type=submit]"));
  await page.fill("#e-amount", "1000");
  await page.selectOption("#e-cat", "tool");
  await act(page, () => page.click("form:has(#e-amount) button[type=submit]"));
  const fin = await page.textContent("body");
  check(fin.includes("¥4,480") && fin.includes("¥3,480"), "粗利益 4,480円・営業利益 3,480円が正しく計算される");
  await page.fill("#s-gross", "100");
  await page.fill("#s-refund", "500");
  await act(page, () => page.click("form:has(#s-gross) button[type=submit]"));
  check((await page.textContent("body")).includes("返金額が売上額を超えています"), "不正な入力（返金＞売上）は拒否");

  console.log("コンテンツ：承認フロー");
  await page.goto(`${BASE}/marketing`);
  await page.selectOption("#platform", "note");
  await page.fill("#title", "E2Eテストの下書き");
  await act(page, () => page.click("form:has(#title) button[type=submit]"));
  const queue = page.locator("li:has-text('E2Eテストの下書き')");
  check((await queue.locator("button[value=scheduled]").count()) === 0, "下書きから直接「予約」はできない");
  await act(page, () => queue.locator("button[value=pending_approval]").click());
  await act(page, () => page.locator("li:has-text('E2Eテストの下書き') button[value=approved]").click());
  const approvedText = await page.locator("li:has-text('E2Eテストの下書き')").allTextContents();
  check(approvedText.some((t) => t.includes("承認済み")), `承認依頼 → 承認ができる ${approvedText.join(" | ").slice(0, 200)}`);

  console.log("投稿した記録・新アカウント");
  await act(page, () => page.fill("li:has-text('E2Eテストの下書き') input[name=url]", "https://x.com/example/status/1").then(() =>
    page.click("li:has-text('E2Eテストの下書き') form:has(input[name=url]) button")));
  check((await page.locator("li:has-text('E2Eテストの下書き')").count()) === 0, "承認済みの投稿を「投稿した」と記録すると待ち行列から消える");
  const mk = await page.textContent("body");
  check(mk.includes("新アカウント開設") && mk.includes("@ai_ceo_project"), "新アカウント開設キットが表示される");
  check(mk.includes("X①：はじめまして"), "新アカウントの最初の下書きが待ち行列に入っている");
  await page.selectOption("#m-account", "ai-ceo");
  await page.selectOption("#m-platform", "x");
  await page.fill("#m-value", "0");
  await act(page, () => page.click("form:has(#m-value) button[type=submit]"));
  check((await page.textContent("details:has-text('X')")).includes("開設済み"), "フォロワー数（0でも可）を記録すると「開設済み」になる");

  console.log("X の予約（自動投稿）");
  await page.goto(`${BASE}/marketing`);
  const x1 = () => page.locator("li:has-text('X①：はじめまして')");
  await act(page, () => x1().locator("button[value=pending_approval]").click());
  await act(page, () => x1().locator("button[value=approved]").click());
  await act(page, () => x1().locator("button[value=scheduled]").click());
  check((await page.textContent("body")).includes("予約できません") && (await x1().textContent()).includes("承認済み"), "【 】が残っている X 投稿は予約できない");
  await x1().locator("summary").click();
  await x1().locator("textarea[name=body]").fill("はじめまして、HIDEです。人間1人とAI社員で事業を回せるか、本気で試します。売上は0円から、数字も失敗もそのまま書いていきます。");
  await act(page, () => x1().locator("form:has(textarea[name=body]) button[value=schedule]").click());
  check((await page.textContent("body")).includes("自動で投稿します") && (await x1().textContent()).includes("予約済み"), "書き換えると予約でき、自動投稿の予定になる");
  check((await x1().textContent()).includes("X に自動投稿"), "X の投稿には「X に自動投稿」と表示される");
  check((await page.locator("li:has-text('note①') summary").count()) === 1, "note の下書きがある");
  await page.locator("li:has-text('note①') summary").click();
  check((await page.locator("li:has-text('note①') button:has-text('書式つきでコピー')").count()) === 1 && (await page.locator("li:has-text('note①') a:has-text('note で書く')").count()) === 1, "note は「書式つきでコピー」「note で書く」で手で投稿する");
  const headerSrc = await page.locator("li:has-text('note①') img[alt^='見出し画像']").getAttribute("src");
  const imgRes = await page.request.get(`${BASE}${headerSrc}`);
  const png = await imgRes.body();
  check(imgRes.status() === 200 && imgRes.headers()["content-type"] === "image/png" && png.length > 5000, `note の見出し画像が作られる（${png.length} bytes）`);
  fs.writeFileSync(path.join(shots, "note-header.png"), png);
  const anon = await (await browser.newContext()).request.get(`${BASE}${headerSrc}`, { maxRedirects: 0 });
  check(anon.status() === 307 || anon.status() === 401, "ログインしていないと note の画像は見られない");
  await page.goto(`${BASE}/settings`);
  const st = await page.textContent("body");
  check(st.includes("X の自動投稿") && st.includes("未設定（Netlify の環境変数 X_API_KEY"), "設定画面に X の自動投稿と合鍵の状態が出る");

  console.log("経営会議");
  await page.goto(`${BASE}/reports`);
  await page.click("text=ルールで集計");
  await page.waitForURL(/\/reports\/\d+/);
  const rep = await page.textContent("body");
  check(rep.includes("1. 現状分析") && rep.includes("7. 翌日の行動計画"), "7項目の経営会議レポートが作られる");
  check(rep.includes("市場調査AIが未接続"), "未調査の項目は未調査と正直に書かれる");
  check(rep.includes("新アカウント（note・Instagram・YouTube）が未開設"), "未開設の新アカウントが問題点に挙がる（開設済みのXは除く）");
  await page.screenshot({ path: path.join(shots, "meeting-desktop.png"), fullPage: true });

  console.log("AI社員（APIキーなしの状態）");
  await page.goto(`${BASE}/reports`);
  check(await page.locator("button:has-text('AI CEO に会議を頼む')").isDisabled(), "APIキーがないときは「AI CEO に会議を頼む」を押せない");
  await page.goto(`${BASE}/agents/research`);
  const ra = await page.textContent("body");
  check(ra.includes("仕事を頼む") && ra.includes("費用の上限") && ra.includes("Web検索は最大5回"), "市場調査AIの画面に、頼める仕事と費用の上限が出る");
  check(await page.locator("form:has(input[value='research.ideas']) button").isDisabled(), "APIキーがないときは市場調査を実行できない");
  check(ra.includes("未接続") || ra.includes("APIのキーが未設定"), "APIキーがないことが表示される");

  console.log("サンプル表示");
  await page.goto(`${BASE}/dashboard`);
  await act(page, () => page.click("button[role=switch]"));
  check((await page.textContent("body")).includes("サンプルデータを含めて表示しています"), "サンプル表示ONで警告帯が出る");
  await act(page, () => page.click("button[role=switch]"));

  console.log("スマートフォン表示");
  const mobile = await browser.newContext({ ...devices["iPhone 13"], storageState: await ctx.storageState() });
  const mp = await mobile.newPage();
  for (const p of ["/dashboard", "/agents", "/business", "/products", "/marketing", "/finance", "/reports", "/settings"]) {
    await mp.goto(`${BASE}${p}`);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `${p} スマホで横にはみ出さない（${overflow}px）`);
  }
  await mp.goto(`${BASE}/dashboard`);
  await mp.screenshot({ path: path.join(shots, "dashboard-mobile.png"), fullPage: true });
  await mp.click("summary");
  await mp.click("details nav >> text=財務");
  await mp.waitForURL("**/finance");
  check(true, "スマホのメニューから移動できる");

  check(consoleErrors.length === 0, `ブラウザのエラーなし ${consoleErrors.join(" ")}`);

  console.log("ログアウト");
  await page.click("text=ログアウト");
  await page.waitForURL("**/login");
  await page.goto(`${BASE}/settings`);
  check(page.url().endsWith("/login"), "ログアウト後は管理画面を開けない");

  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
  console.error(serverLog.slice(-3000));
} finally {
  try {
    process.kill(-server.pid, "SIGTERM"); // npx の子プロセス（next）ごと止める
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nすべて合格" : `\n${failures}件 失敗`);
process.exit(failures === 0 ? 0 : 1);

/** Server Action を送信し、結果の画面に切り替わるまで待つ */
async function act(page, fn) {
  const res = page.waitForResponse((r) => r.request().method() === "POST" && r.headers()["x-action-redirect"] !== undefined);
  await fn();
  const r = await res;
  const target = r.headers()["x-action-redirect"].split(";")[0];
  await page.waitForFunction((t) => location.pathname + location.search === t, decodeURI(target) === target ? target : target, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed`))));
  });
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}
