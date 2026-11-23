import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, get, run } from "../../lib/database/db";
import { publishNextShort, nextShortSource } from "../../lib/automation/yt-shorts";
import { extractCode, shortDescription, shortTitle, ytAuthUrl, ytUploadShort, ytCredentialsFromEnv } from "../../lib/social/youtube";
import { seal, unseal } from "../../lib/security/seal";
import { concatList, slideSeconds } from "../../lib/video/short-video";

const at = (s: string) => new Date(s + "+09:00");
const SLIDES = [{ heading: "売上0円の理由", text: "表紙" }, { heading: "中身", text: "説明" }];

async function setup(postedAt = "2026-11-25 07:00") {
  const db = await openDb(":memory:");
  const ins = await run(
    db,
    "INSERT INTO content_posts (business_id, platform, status, title, body, extra, posted_at, data_kind) VALUES ('ai-ceo-project','instagram','posted','IG②','キャプション #AI', ?, ?, 'actual')",
    [JSON.stringify({ slides: SLIDES }), postedAt],
  );
  return Object.assign(db, { igId: ins.lastId });
}
const okUpload = (calls: string[]) => async (_v: Uint8Array, m: { title: string }) => {
  calls.push(m.title);
  return { ok: true as const, value: "vid123" };
};
const fakeVideo = async () => new Uint8Array([1, 2, 3]);

test("YouTube：Instagram に投稿済みのカルーセルを1本ショートにし、二重に出さない", async () => {
  const db = await setup();
  const calls: string[] = [];
  const r = await publishNextShort(db, { makeVideo: fakeVideo, upload: okUpload(calls) }, at("2026-11-25T08:00"));
  assert.equal(r.status, "posted");
  assert.deepEqual(calls, ["売上0円の理由｜HIDE #Shorts"]);
  const row = await get<{ status: string; url: string; source_ref: string }>(db, "SELECT status, url, source_ref FROM content_posts WHERE source = 'auto-short'");
  assert.deepEqual(row, { status: "posted", url: "https://www.youtube.com/shorts/vid123", source_ref: `yt-short:ig:${db.igId}` });
  // 同じ Instagram 投稿は2回目は出さない
  const r2 = await publishNextShort(db, { makeVideo: fakeVideo, upload: okUpload(calls) }, at("2026-11-25T12:00"));
  assert.equal(r2.status, "nothing_due");
  assert.equal(calls.length, 1);
});

test("YouTube：3時間以内・1日の上限・OFF・古い投稿は出さない", async () => {
  const db = await setup();
  await run(db, "INSERT INTO content_posts (business_id, platform, status, title, posted_at, source, source_ref, data_kind) VALUES ('ai-ceo-project','youtube','posted','前の', '2026-11-25 07:30', 'auto-short', 'yt-short:ig:999', 'actual')");
  const calls: string[] = [];
  assert.equal((await publishNextShort(db, { makeVideo: fakeVideo, upload: okUpload(calls) }, at("2026-11-25T09:00"))).status, "limited");
  await run(db, "INSERT INTO settings (key, value) VALUES ('yt_daily_limit', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  assert.match((await publishNextShort(db, { makeVideo: fakeVideo, upload: okUpload(calls) }, at("2026-11-25T20:00"))).detail, /1本/);
  await run(db, "INSERT INTO settings (key, value) VALUES ('yt_autopost_enabled', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  assert.equal((await publishNextShort(db, { makeVideo: fakeVideo, upload: okUpload(calls) }, at("2026-11-26T20:00"))).status, "disabled");
  assert.equal(calls.length, 0);
  // 8日前に Instagram に出たものは掘り起こさない
  const old = await setup("2026-11-10 07:00");
  assert.equal(await nextShortSource(old, at("2026-11-25T08:00")), null);
});

test("YouTube：失敗したら failed で残し、自動では再挑戦しない（DRY_RUN は何も書かない）", async () => {
  const db = await setup();
  const dry = await publishNextShort(db, { dryRun: true, makeVideo: fakeVideo, upload: async () => assert.fail("投稿してはいけない") }, at("2026-11-25T08:00"));
  assert.equal(dry.status, "dry_run");
  assert.equal(Number((await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM content_posts WHERE source = 'auto-short'"))!.n), 0);
  const r = await publishNextShort(db, { makeVideo: fakeVideo, upload: async () => ({ ok: false, error: "認証に失敗" }) }, at("2026-11-25T08:00"));
  assert.equal(r.status, "failed");
  const row = await get<{ status: string; error: string }>(db, "SELECT status, error FROM content_posts WHERE source = 'auto-short'");
  assert.deepEqual(row, { status: "failed", error: "認証に失敗" });
  assert.equal((await publishNextShort(db, { makeVideo: fakeVideo, upload: okUpload([]) }, at("2026-11-25T12:00"))).status, "nothing_due");
});

test("YouTube：アップロードは 準備（resumable）→ 本体 の順。公開・子ども向けではない", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: init?.body });
    if (url.includes("uploadType=resumable")) return new Response("", { status: 200, headers: { Location: "https://upload.example/session1" } });
    if (url === "https://upload.example/session1") return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const r = await ytUploadShort("tok", new Uint8Array([9]), { title: "t", description: "d", privacy: "public" }, fake);
  assert.deepEqual(r, { ok: true, value: "abc" });
  const meta = JSON.parse(String(seen[0].body));
  assert.equal(meta.status.privacyStatus, "public");
  assert.equal(meta.status.selfDeclaredMadeForKids, false);
  assert.equal(seen[1].url, "https://upload.example/session1");
});

test("YouTube：タイトル100字・説明に < > を入れない・秒数・合鍵の読み取り", () => {
  assert.ok([...shortTitle("あ".repeat(200))].length <= 100);
  assert.ok(shortTitle("見出し").endsWith("#Shorts"));
  assert.ok(!/[<>]/.test(shortDescription("a <b> c")));
  assert.deepEqual([1, 2, 3].map((n) => slideSeconds(n, 3)), [3, 4, 4.5]);
  assert.match(concatList(["/t/a.png", "/t/b.png"], 2), /file '\/t\/b.png'\nduration 4.5\nfile '\/t\/b.png'\n$/);
  assert.equal(ytCredentialsFromEnv({}), null);
  assert.deepEqual(ytCredentialsFromEnv({ YT_CLIENT_ID: "i", YT_CLIENT_SECRET: "s", HIDE_YT_REFRESH_TOKEN: "r", YT_REFRESH_TOKEN: "axion" }), { clientId: "i", clientSecret: "s", refreshToken: "r" });
  // AXION のチャンネルの合鍵（YT_REFRESH_TOKEN）は絶対に使わない
  assert.equal(ytCredentialsFromEnv({ YT_CLIENT_ID: "i", YT_CLIENT_SECRET: "s", YT_REFRESH_TOKEN: "axion" }), null);
  assert.deepEqual(ytCredentialsFromEnv({ YT_CLIENT_ID: "i", YT_CLIENT_SECRET: "s" }, "db"), { clientId: "i", clientSecret: "s", refreshToken: "db" });
});

test("YouTube：つなぐリンク・コードの取り出し・合鍵の暗号化", () => {
  const u = new URL(ytAuthUrl("cid.apps.googleusercontent.com"));
  assert.equal(u.searchParams.get("redirect_uri"), "https://developers.google.com/oauthplayground");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.match(u.searchParams.get("scope")!, /youtube\.upload/);
  assert.equal(extractCode("https://developers.google.com/oauthplayground/?code=4%2F0Abc&scope=x"), "4/0Abc");
  assert.equal(extractCode(" 4/0Abc "), "4/0Abc");
  assert.equal(extractCode(""), "");
  const s = seal("refresh-123", "secret-a", "p");
  assert.ok(!s.includes("refresh-123"));
  assert.equal(unseal(s, "secret-a", "p"), "refresh-123");
  assert.equal(unseal(s, "secret-b", "p"), null);
  assert.equal(unseal(s, "secret-a", "other"), null);
});
