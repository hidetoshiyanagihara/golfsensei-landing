import { DataBadge, kindOf } from "../common/ui";

/**
 * 横棒グラフ（1系列）。色は検証済みのゴールド1色、値は文字色で直接表示。
 * 棒の上にマウスを置くと詳細が出る（title）。数値は常に見えるので表としても読める。
 */
export function BarList({
  rows,
  format,
  unit,
}: {
  rows: { label: string; value: number; detail?: string; kind?: string }[];
  format: (n: number) => string;
  unit: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3" aria-label={`${unit}のグラフ`}>
      {rows.map((r) => (
        <li key={r.label} className="group" title={`${r.label}：${format(r.value)}${r.detail ? `（${r.detail}）` : ""}`}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-fg-muted">{r.label}</span>
              {r.kind && kindOf(r.kind) !== "actual" && <DataBadge kind={kindOf(r.kind)} />}
            </span>
            <span className="num shrink-0 text-fg">{format(r.value)}</span>
          </div>
          <div className="h-2 w-full bg-navy-800">
            <div
              className="h-2 rounded-r-[4px] bg-gold-strong transition-[filter] group-hover:brightness-125"
              style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
