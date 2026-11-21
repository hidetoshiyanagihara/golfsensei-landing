import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "./session";

export function isConfigured(): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  return !!pw && pw.length >= 12 && !!secret && secret.length >= 32;
}

export async function isAuthenticated(): Promise<boolean> {
  const c = await cookies();
  return (await verifySession(c.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET)) !== null;
}

/** ページ・Server Action の先頭で必ず呼ぶ（proxy.ts だけに頼らない） */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}
