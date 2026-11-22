"use client";

import { usePathname } from "next/navigation";
import { toggleSample } from "@/app/actions";

export function SampleToggle({ on }: { on: boolean }) {
  const path = usePathname();
  return (
    <form action={toggleSample}>
      <input type="hidden" name="back" value={path} />
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs ${on ? "border-warn/60 text-warn" : "border-navy-700 text-fg-muted hover:text-fg"}`}
        title="サンプルデータ（data_kind=sample）を画面に混ぜて表示します。実データの集計には影響しません。"
      >
        <span className={`inline-block h-3 w-6 rounded-full p-px ${on ? "bg-warn/70" : "bg-navy-700"}`}>
          <span className={`block h-2.5 w-2.5 rounded-full bg-fg transition-transform ${on ? "translate-x-3" : ""}`} />
        </span>
        サンプル表示
      </button>
    </form>
  );
}
