/**
 * ログインセッション（署名付き Cookie）。Web Crypto だけを使うので proxy.ts とサーバーの両方で動く。
 * トークン形式：  base64url(payload JSON) + "." + base64url(HMAC-SHA256)
 */

export const SESSION_COOKIE = "cc_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7日

export type SessionPayload = { sub: "owner"; iat: number; exp: number };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET が未設定か短すぎます（32文字以上）");
}

export async function signSession(secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  assertSecret(secret);
  const payload: SessionPayload = { sub: "owner", iat: nowSec, exp: nowSec + SESSION_TTL_SECONDS };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(
  token: string | undefined,
  secret: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  if (!token || !secret || secret.length < 32) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (payload.sub !== "owner" || typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

/** パスワード比較（長さや内容で処理時間が変わらないよう、ハッシュ同士を比べる） */
export async function passwordMatches(input: string, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 12) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(input)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** ログイン試行の制限：15分で5回失敗したら、その15分はログインできない（プロセス内で管理） */
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

export function isLockedOut(key: string, now = Date.now()): boolean {
  const a = attempts.get(key);
  if (!a) return false;
  if (now - a.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return a.count >= MAX_FAILS;
}

export function recordFailure(key: string, now = Date.now()): void {
  const a = attempts.get(key);
  if (!a || now - a.first > WINDOW_MS) attempts.set(key, { count: 1, first: now });
  else a.count++;
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}
