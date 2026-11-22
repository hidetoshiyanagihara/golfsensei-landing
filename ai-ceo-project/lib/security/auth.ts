import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, resolveSessionSecret, verifySession } from "./session";

export function isConfigured(): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && pw.length >= 12 && !!resolveSessionSecret();
}

export async function isAuthenticated(): Promise<boolean> {
  const c = await cookies();
  return (await verifySession(c.get(SESSION_COOKIE)?.value, resolveSessionSecret())) !== null;
}

/** ページ・Server Action の先頭で必ず呼ぶ（proxy.ts だけに頼らない） */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}
