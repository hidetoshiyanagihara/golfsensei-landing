import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, resolveSessionSecret, verifySession } from "./lib/security/session";

/**
 * ログインしていないアクセスを /login に戻す（入口のチェック）。
 * 各ページと Server Action でも requireAuth() で再確認する。
 */
export async function proxy(req: NextRequest) {
  // 投稿用画像の署名付きリンク（Instagram 投稿時に Meta が取りに来る）は、画像を作る側で署名を確かめる
  if (req.nextUrl.pathname.startsWith("/api/note-image/") && req.nextUrl.searchParams.has("sig")) return NextResponse.next();
  const ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, resolveSessionSecret());
  if (!ok) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // .netlify/functions は裏側の実行用（依頼は署名で確認するので、ここでは止めない）
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico|icon.svg|\\.netlify/).*)"],
};
