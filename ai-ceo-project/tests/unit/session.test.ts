import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession, passwordMatches, isLockedOut, recordFailure, clearFailures, SESSION_TTL_SECONDS } from "../../lib/security/session";

const secret = "x".repeat(40);

test("署名したセッションは検証できる", async () => {
  const t = await signSession(secret, 1000);
  assert.ok(await verifySession(t, secret, 1001));
});

test("改ざん・別の鍵・期限切れ・形式違いは拒否", async () => {
  const t = await signSession(secret, 1000);
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "owner", iat: 1000, exp: 9e9 })).toString("base64url");
  assert.equal(await verifySession(`${forged}.${sig}`, secret, 1001), null);
  assert.equal(await verifySession(t, "y".repeat(40), 1001), null);
  assert.equal(await verifySession(t, secret, 1000 + SESSION_TTL_SECONDS + 1), null);
  assert.equal(await verifySession(`${body}.${sig}.x`, secret, 1001), null);
  assert.equal(await verifySession("garbage", secret), null);
  assert.equal(await verifySession(undefined, secret), null);
  assert.equal(await verifySession(t, "short"), null);
});

test("短すぎる鍵では署名しない", async () => {
  await assert.rejects(signSession("short"));
});

test("パスワード比較", async () => {
  assert.equal(await passwordMatches("correct-horse-1", "correct-horse-1"), true);
  assert.equal(await passwordMatches("wrong", "correct-horse-1"), false);
  assert.equal(await passwordMatches("", undefined), false);
  assert.equal(await passwordMatches("short", "short"), false); // 12文字未満の設定は無効
});

test("5回失敗でロック、15分で解除", () => {
  const k = "ip-test";
  clearFailures(k);
  for (let i = 0; i < 5; i++) recordFailure(k, 0);
  assert.equal(isLockedOut(k, 1000), true);
  assert.equal(isLockedOut(k, 16 * 60 * 1000), false);
});
