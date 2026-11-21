import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession, passwordMatches, SESSION_TTL_SECONDS } from "../../lib/security/session";

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

import { resolveSessionSecret } from "../../lib/security/session";

test("署名の鍵：SESSION_SECRET 優先、なければパスワード＋Tursoトークンから作る", () => {
  const token = "t".repeat(40);
  assert.equal(resolveSessionSecret({ SESSION_SECRET: secret }), secret);
  assert.equal(resolveSessionSecret({ ADMIN_PASSWORD: "long-password-1", TURSO_AUTH_TOKEN: token }), `derived:v1:long-password-1:${token}`);
  assert.equal(resolveSessionSecret({ ADMIN_PASSWORD: "long-password-1" }), undefined); // トークンなしは作らない
  assert.equal(resolveSessionSecret({ ADMIN_PASSWORD: "short", TURSO_AUTH_TOKEN: token }), undefined);
  // パスワードを変えると鍵が変わる（今までのログインは無効になる）
  assert.notEqual(
    resolveSessionSecret({ ADMIN_PASSWORD: "long-password-1", TURSO_AUTH_TOKEN: token }),
    resolveSessionSecret({ ADMIN_PASSWORD: "long-password-2", TURSO_AUTH_TOKEN: token }),
  );
});
