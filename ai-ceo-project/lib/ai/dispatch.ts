import { resolveSessionSecret } from "../security/session";

/**
 * 受付けた仕事を、Netlify のバックグラウンド関数（最大15分）に渡すための署名。
 * 署名がない・古い（5分以上前）・改ざんされた依頼は実行しない。
 */
const enc = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(`agent-dispatch:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signDispatch(runId: number, ts = Date.now(), secret = resolveSessionSecret()): Promise<{ runId: number; ts: number; sig: string }> {
  if (!secret) throw new Error("署名の鍵がありません");
  const sig = hex(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`${runId}.${ts}`)));
  return { runId, ts, sig };
}

export async function verifyDispatch(body: unknown, now = Date.now(), secret = resolveSessionSecret()): Promise<number | null> {
  if (!secret || !body || typeof body !== "object") return null;
  const { runId, ts, sig } = body as Record<string, unknown>;
  if (typeof runId !== "number" || typeof ts !== "number" || typeof sig !== "string") return null;
  if (Math.abs(now - ts) > 5 * 60 * 1000) return null;
  const expected = (await signDispatch(runId, ts, secret)).sig;
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? runId : null;
}

export const BACKGROUND_PATH = "/.netlify/functions/agent-run-background";

/** Netlify の上で動いているか（パソコンでは仕事をその場で実行する） */
export function onNetlify(): boolean {
  return !!(process.env.SITE_ID || process.env.NETLIFY || process.env.NETLIFY_LOCAL);
}

/** 用途つきの署名（例：Instagram の投稿を裏側で実行する依頼） */
export async function signPurpose(purpose: string, ts = Date.now(), secret = resolveSessionSecret()): Promise<{ purpose: string; ts: number; sig: string }> {
  if (!secret) throw new Error("署名の鍵がありません");
  const sig = hex(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`purpose:${purpose}.${ts}`)));
  return { purpose, ts, sig };
}

export async function verifyPurpose(body: unknown, purpose: string, now = Date.now(), secret = resolveSessionSecret()): Promise<boolean> {
  if (!secret || !body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.purpose !== purpose || typeof b.ts !== "number" || typeof b.sig !== "string" || Math.abs(now - b.ts) > 5 * 60 * 1000) return false;
  const expected = (await signPurpose(purpose, b.ts, secret)).sig;
  if (expected.length !== b.sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ b.sig.charCodeAt(i);
  return diff === 0;
}
