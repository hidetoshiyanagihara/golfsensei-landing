/**
 * YouTube（ショート）への投稿。公式の YouTube Data API v3 だけを使う。
 * 合鍵は Google の OAuth（クライアントID・シークレット・リフレッシュトークン）。値はコードに書かず、環境変数から読む。
 */
export type YtCredentials = { clientId: string; clientSecret: string; refreshToken: string };
export type YtResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Fetch = typeof fetch;

/**
 * HIDE のチャンネルの合鍵。YT_REFRESH_TOKEN（AXION のチャンネル）は使わない（別のチャンネルに出してしまうため）。
 * refreshToken は環境変数 HIDE_YT_REFRESH_TOKEN、なければ引数（データベースに暗号化して保存したもの）。
 */
export function ytCredentialsFromEnv(env: Record<string, string | undefined> = process.env, storedRefreshToken: string | null = null): YtCredentials | null {
  const clientId = env.YT_CLIENT_ID?.trim();
  const clientSecret = env.YT_CLIENT_SECRET?.trim();
  const refreshToken = env.HIDE_YT_REFRESH_TOKEN?.trim() || storedRefreshToken?.trim();
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

/** 許可を取るときの戻り先（AXION の OAuth クライアントに登録済みの OAuth Playground） */
export const YT_REDIRECT_URI = "https://developers.google.com/oauthplayground";
export const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

/** チャンネルの持ち主に開いてもらう「許可」のリンク（client_id は公開されても問題のない値） */
export function ytAuthUrl(clientId: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: YT_REDIRECT_URI,
    response_type: "code",
    scope: YT_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** 許可のあとに出る「コード」を、リフレッシュトークンに交換する（コードは1回きり・数分で切れる） */
export async function ytExchangeCode(clientId: string, clientSecret: string, code: string, f: Fetch = fetch): Promise<YtResult<string>> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: code.trim(), redirect_uri: YT_REDIRECT_URI, grant_type: "authorization_code" }),
  });
  if (!r.ok) return { ok: false, error: await errorText(r, "コードの交換（期限切れ・使用済みの可能性）") };
  const j = (await r.json()) as { refresh_token?: string };
  return j.refresh_token ? { ok: true, value: j.refresh_token } : { ok: false, error: "リフレッシュトークンが返りませんでした（もう一度リンクから許可してください）" };
}

/** 「?code=…」が付いた URL を丸ごと貼られても、コードだけ取り出す */
export function extractCode(input: string): string {
  const t = input.trim();
  try {
    const u = new URL(t);
    return u.searchParams.get("code") ?? t;
  } catch {
    return decodeURIComponent(t);
  }
}

async function errorText(r: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const j = (await r.json()) as { error?: { message?: string } | string; error_description?: string };
    detail = typeof j.error === "string" ? `${j.error} ${j.error_description ?? ""}` : j.error?.message ?? "";
  } catch {
    /* 本文なし */
  }
  return `${what}に失敗しました（HTTP ${r.status}）${detail ? `：${detail.trim().slice(0, 200)}` : ""}`;
}

export async function ytAccessToken(c: YtCredentials, f: Fetch = fetch): Promise<YtResult<string>> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
  });
  if (!r.ok) return { ok: false, error: await errorText(r, "YouTube の認証（リフレッシュトークン切れの可能性）") };
  const j = (await r.json()) as { access_token?: string };
  return j.access_token ? { ok: true, value: j.access_token } : { ok: false, error: "YouTube の認証で合鍵が返りませんでした" };
}

/** 合鍵がどのチャンネルのものか（投稿はしない） */
export async function ytChannel(token: string, f: Fetch = fetch): Promise<YtResult<{ id: string; title: string }>> {
  const r = await f("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { ok: false, error: await errorText(r, "チャンネルの確認") };
  const j = (await r.json()) as { items?: { id: string; snippet?: { title?: string } }[] };
  const ch = j.items?.[0];
  return ch ? { ok: true, value: { id: ch.id, title: ch.snippet?.title ?? "" } } : { ok: false, error: "この合鍵にはチャンネルがありません" };
}

export type ShortMeta = { title: string; description: string; privacy: "public" | "unlisted" | "private" };

/** 縦長・3分以内の動画はショートとして扱われる */
export async function ytUploadShort(token: string, video: Uint8Array, meta: ShortMeta, f: Fetch = fetch): Promise<YtResult<string>> {
  const init = await f("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(video.byteLength),
    },
    body: JSON.stringify({
      snippet: { title: meta.title, description: meta.description, categoryId: "22", defaultLanguage: "ja" },
      status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) return { ok: false, error: await errorText(init, "YouTube へのアップロード準備") };
  const location = init.headers.get("location");
  if (!location) return { ok: false, error: "YouTube のアップロード先が返りませんでした" };
  const put = await f(location, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: new Uint8Array(video) });
  if (!put.ok) return { ok: false, error: await errorText(put, "YouTube へのアップロード") };
  const j = (await put.json()) as { id?: string };
  return j.id ? { ok: true, value: j.id } : { ok: false, error: "YouTube から動画IDが返りませんでした" };
}

/** タイトル（100文字まで）。表紙の見出し＋発信名＋#Shorts */
export function shortTitle(heading: string): string {
  const tail = "｜HIDE #Shorts";
  const h = heading.replace(/\s+/g, " ").trim();
  return [...h].slice(0, 100 - [...tail].length).join("") + tail;
}

/** 説明文（5,000バイトまで。< > は使えない） */
export function shortDescription(caption: string): string {
  const d = `${caption.trim()}\n\n人間1人とAI社員で事業をつくる実験を、売上も失敗もそのまま公開しています。\n#Shorts`;
  const clean = d.replace(/[<>]/g, "");
  let out = "";
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch) > 4900) break;
    out += ch;
  }
  return out;
}
