import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/security/session";

/**
 * ログインしていないアクセスを /login に戻す（入口のチェック）。
 * 各ページと Server Action でも requireAuth() で再確認する。
 */
export async function proxy(req: NextRequest) {
  const ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  if (!ok) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
