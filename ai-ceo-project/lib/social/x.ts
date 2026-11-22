import crypto from "node:crypto";

/**
 * X（旧Twitter）への投稿。公式の X API v2（POST /2/tweets）を OAuth 1.0a（ユーザーの合鍵）で呼ぶ。
 * 料金は従量課金（2026年：投稿1件 約0.015ドル、URL入りは約0.20ドル）。
 * 合鍵は Netlify の環境変数（秘密の値）にだけ置く：X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
 */

export type XCredentials = { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string };

export function xCredentialsFromEnv(env: Record<string, string | undefined> = process.env): XCredentials | null {
  const c = { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessTokenSecret: env.X_ACCESS_TOKEN_SECRET };
  return c.apiKey && c.apiSecret && c.accessToken && c.accessTokenSecret ? (c as XCredentials) : null;
}

/** RFC 3986 のパーセントエンコード（OAuth 1.0a の決まり） */
export function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** OAuth 1.0a の署名（HMAC-SHA1）。params には oauth_* とクエリ・フォームの値を入れる（JSON本文は含めない） */
export function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret: string): string {
  const norm = Object.keys(params)
    .map((k) => [pct(k), pct(params[k])] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(norm)].join("&");
  return crypto.createHmac("sha1", `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest("base64");
}

export function oauthHeader(method: string, url: string, c: XCredentials, nonce = crypto.randomBytes(16).toString("hex"), ts = Math.floor(Date.now() / 1000)): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(ts),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature(method, url, oauth, c.apiSecret, c.accessTokenSecret);
  return "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");
}

/**
 * X の文字数（重み付き）。日本語などの全角は2、半角英数は1、URLは23として数える。上限は280（全角なら140字）。
 */
export function xWeightedLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    const light = (cp >= 0x0 && cp <= 0x10ff) || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

export const X_MAX_WEIGHT = 280;

export function hasUrl(text: string): boolean {
  return /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|jp|net|app|io|co)\b/i.test(text);
}

export type PostResult = { ok: true; id: string } | { ok: false; error: string; retryable: boolean };
export type XPoster = (text: string) => Promise<PostResult>;

export const TWEETS_URL = "https://api.x.com/2/tweets";

export function makeXPoster(c: XCredentials, doFetch: typeof fetch = fetch): XPoster {
  return async (text) => {
    try {
      const r = await doFetch(TWEETS_URL, {
        method: "POST",
        headers: { Authorization: oauthHeader("POST", TWEETS_URL, c), "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await r.json().catch(() => ({}))) as { data?: { id?: string }; detail?: string; title?: string; errors?: { message?: string }[] };
      if (r.ok && body.data?.id) return { ok: true, id: body.data.id };
      const detail = body.detail ?? body.errors?.[0]?.message ?? body.title ?? "";
      const reason =
        r.status === 401 ? "X の合鍵が無効です（401）"
        : r.status === 402 ? "X API のクレジット（残高）が足りません（402）"
        : r.status === 403 ? `X に投稿を拒否されました（403）${detail ? "：" + detail : ""}`
        : r.status === 429 ? "X の投稿回数の制限に達しました（429）"
        : `X API のエラー（${r.status}）${detail ? "：" + detail : ""}`;
      return { ok: false, error: reason.slice(0, 300), retryable: r.status === 429 || r.status >= 500 };
    } catch (e) {
      return { ok: false, error: `X に接続できませんでした（${e instanceof Error ? e.message : "不明"}）`, retryable: true };
    }
  };
}
