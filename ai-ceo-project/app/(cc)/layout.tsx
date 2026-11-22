import { requireAuth } from "@/lib/security/auth";
import { getView } from "@/lib/view";
import { Nav } from "@/components/common/Nav";
import { SampleToggle } from "@/components/common/SampleToggle";
import { logout } from "../actions";

export const dynamic = "force-dynamic";

function Brand() {
  return (
    <div className="px-3">
      <p className="text-[10px] tracking-[0.36em] text-gold">AI CEO PROJECT</p>
      <p className="mt-0.5 text-sm font-semibold tracking-[0.14em]">COMMAND CENTER</p>
    </div>
  );
}

export default async function CommandCenterLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  const view = await getView();
  return (
    <div className="min-h-dvh lg:flex">
      {/* PC：左のメニュー */}
      <aside className="hidden w-60 shrink-0 border-r border-line bg-ink lg:block">
        <div className="sticky top-0 flex h-dvh flex-col justify-between py-6">
        <div className="space-y-8">
          <Brand />
          <div className="px-2">
            <Nav />
          </div>
        </div>
        <p className="px-5 text-[10px] leading-5 tracking-[0.2em] text-fg-subtle">
          ONE HUMAN.
          <br />
          MANY AI EMPLOYEES.
        </p>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* 上部バー（スマホではメニューもここ） */}
        <div className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-line bg-navy-950/95 px-4 py-2.5 backdrop-blur sm:px-6">
          <details className="relative lg:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-navy-700 px-2.5 py-1 text-xs [&::-webkit-details-marker]:hidden">
              <span aria-hidden>☰</span> メニュー
            </summary>
            <div className="absolute left-0 mt-2 w-64 rounded-lg border border-line bg-ink p-2 shadow-xl">
              <div className="py-2">
                <Brand />
              </div>
              <Nav onNavigate />
            </div>
          </details>
          <p className="hidden text-xs text-fg-subtle lg:block">代表：柳原</p>
          <div className="flex items-center gap-2">
            <SampleToggle on={view.showSample} />
            <form action={logout}>
              <button type="submit" className="rounded-md px-2 py-1 text-xs text-fg-muted hover:text-fg">
                ログアウト
              </button>
            </form>
          </div>
        </div>

        {view.showSample && (
          <div className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn sm:px-6">
            ▲ サンプルデータを含めて表示しています。「サンプル」と表示された数字は架空です。実績の判断には使わないでください。
          </div>
        )}

        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
