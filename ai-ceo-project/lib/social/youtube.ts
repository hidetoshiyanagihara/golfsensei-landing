/**
 * YouTube（ショート）への投稿。公式の YouTube Data API v3 だけを使う。
 * 合鍵は Google の OAuth（クライアントID・シークレット・リフレッシュトークン）。値はコードに書かず、環境変数から読む。
 */
export type YtCredentials = { clientId: string; clientSecret: string; refreshToken: string };
export type YtResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Fetch = typeof fetch;

export function ytCredentialsFromEnv(env: Record<string, string | undefined> = process.env): YtCredentials | null {
  const clientId = env.YT_CLIENT_ID?.trim();
  const clientSecret = env.YT_CLIENT_SECRET?.trim();
  const refreshToken = (env.HIDE_YT_REFRESH_TOKEN || env.YT_REFRESH_TOKEN)?.trim();
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
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
