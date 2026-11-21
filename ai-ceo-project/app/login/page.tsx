import { redirect } from "next/navigation";
import { login } from "../actions";
import { isAuthenticated, isConfigured } from "@/lib/security/auth";

export const metadata = { title: "ログイン" };

const ERRORS: Record<string, string> = {
  invalid: "パスワードが違います。",
  locked: "失敗が続いたため、15分間ログインできません。",
  setup: "初期設定がまだです。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await isAuthenticated()) redirect("/dashboard");
  const { e } = await searchParams;
  const configured = isConfigured();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-[11px] tracking-[0.4em] text-gold">AI CEO PROJECT</p>
          <h1 className="mt-2 text-xl font-semibold tracking-[0.12em]">COMMAND CENTER</h1>
          <p className="mt-2 text-xs tracking-[0.2em] text-fg-subtle">ONE HUMAN. MANY AI EMPLOYEES.</p>
        </div>
        <div className="rounded-lg border border-line bg-navy-900 p-6">
          {!configured ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium text-warn">初期設定が必要です</p>
              <p className="text-fg-muted">
                ターミナルで <code className="rounded bg-navy-800 px-1.5 py-0.5 text-gold">npm run setup</code> を実行するとパスワードが発行されます。そのあと開発サーバーを起動し直してください。
              </p>
            </div>
          ) : (
            <form action={login} className="space-y-4">
              <div>
                <label htmlFor="password">パスワード</label>
                <input id="password" name="password" type="password" autoComplete="current-password" required className="mt-1" autoFocus />
              </div>
              {e && ERRORS[e] && (
                <p role="alert" className="text-sm text-bad">
                  {ERRORS[e]}
                </p>
              )}
              <button type="submit" className="w-full rounded-md bg-gold-strong py-2 text-sm font-semibold text-ink hover:bg-gold">
                ログイン
              </button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-[11px] text-fg-subtle">代表者専用の管理画面です</p>
      </div>
    </main>
  );
}
