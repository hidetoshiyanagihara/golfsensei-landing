/**
 * Instagram への投稿（公式の Instagram API・Instagram ログイン版。graph.instagram.com）。
 * カルーセル（複数枚の画像）：画像ごとの入れ物 → カルーセルの入れ物 → 公開、の順に作る。
 * 画像は Meta のサーバーが URL から取りに来る（JPEG のみ）。
 * 合鍵（アクセストークン）は60日で切れるため、週1回延長する。
 */
export const IG_API = "https://graph.instagram.com/v23.0";

export type IgResult<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean };
type F = typeof fetch;

async function call<T>(doFetch: F, url: string, init?: RequestInit): Promise<IgResult<T>> {
  try {
    const r = await doFetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const body = (await r.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
    if (r.ok && !body.error) return { ok: true, value: body };
    const m = body.error?.message ?? "";
    const reason =
      r.status === 401 || body.error?.code === 190 ? "Instagram の合鍵が無効か期限切れです"
      : r.status === 429 || body.error?.code === 4 || body.error?.code === 32 ? "Instagram の利用回数の制限に達しました"
      : `Instagram API のエラー（${r.status}）${m ? "：" + m.slice(0, 150) : ""}`;
    return { ok: false, error: reason, retryable: r.status === 429 || r.status >= 500 };
  } catch (e) {
    return { ok: false, error: `Instagram に接続できませんでした（${e instanceof Error ? e.message : "不明"}）`, retryable: true };
  }
}

export async function igMe(token: string, doFetch: F = fetch) {
  return call<{ user_id?: string; id?: string; username?: string }>(doFetch, `${IG_API}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
}

export async function igRefresh(token: string, doFetch: F = fetch) {
  return call<{ access_token: string; expires_in: number }>(
    doFetch,
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
}

function form(params: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() };
}

/** カルーセルを投稿する。成功したら投稿ID */
export async function igPublishCarousel(
  opts: { token: string; userId: string; imageUrls: string[]; caption: string; doFetch?: F; wait?: (ms: number) => Promise<void> },
): Promise<IgResult<{ id: string; permalink?: string }>> {
  const f = opts.doFetch ?? fetch;
  const wait = opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (opts.imageUrls.length < 2 || opts.imageUrls.length > 10) return { ok: false, error: "カルーセルの画像は2〜10枚です", retryable: false };
  const children: string[] = [];
  for (const url of opts.imageUrls) {
    const r = await call<{ id: string }>(f, `${IG_API}/${opts.userId}/media`, form({ image_url: url, is_carousel_item: "true", access_token: opts.token }));
    if (!r.ok) return r;
    children.push(r.value.id);
  }
  const ready = async (id: string): Promise<IgResult<true>> => {
    for (let i = 0; i < 20; i++) {
      const s = await call<{ status_code?: string }>(f, `${IG_API}/${id}?fields=status_code&access_token=${encodeURIComponent(opts.token)}`);
      if (!s.ok) return s;
      if (s.value.status_code === "FINISHED") return { ok: true, value: true };
      if (s.value.status_code === "ERROR" || s.value.status_code === "EXPIRED") return { ok: false, error: `画像の準備に失敗しました（${s.value.status_code}）`, retryable: false };
      await wait(3000);
    }
    return { ok: false, error: "画像の準備が時間内に終わりませんでした", retryable: true };
  };
  for (const c of children) {
    const r = await ready(c);
    if (!r.ok) return r;
  }
  const carousel = await call<{ id: string }>(f, `${IG_API}/${opts.userId}/media`, form({ media_type: "CAROUSEL", children: children.join(","), caption: opts.caption, access_token: opts.token }));
  if (!carousel.ok) return carousel;
  const r2 = await ready(carousel.value.id);
  if (!r2.ok) return r2;
  const pub = await call<{ id: string }>(f, `${IG_API}/${opts.userId}/media_publish`, form({ creation_id: carousel.value.id, access_token: opts.token }));
  if (!pub.ok) return pub;
  const link = await call<{ permalink?: string }>(f, `${IG_API}/${pub.value.id}?fields=permalink&access_token=${encodeURIComponent(opts.token)}`);
  return { ok: true, value: { id: pub.value.id, permalink: link.ok ? link.value.permalink : undefined } };
}

/** 投稿前の確認（キャプション） */
export function checkInstagram(caption: string, slides: { heading: string; text: string }[]): string | null {
  const c = caption.replace(/\r\n?/g, "\n");
  if (!c.trim()) return "キャプションが空です";
  if (/[【】]/.test(c) || slides.some((s) => /[【】]/.test(s.heading + s.text))) return "【 】の部分が残っています（ご自身の言葉に書き換えてから予約してください）";
  if ([...c].length > 2200) return "キャプションが長すぎます（2,200字まで）";
  if ((c.match(/#[^\s#]+/g) ?? []).length > 30) return "ハッシュタグが多すぎます（30個まで）";
  if (slides.length < 2 || slides.length > 10) return "スライドは2〜10枚にしてください";
  return null;
}
