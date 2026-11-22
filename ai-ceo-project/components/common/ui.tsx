import type { ReactNode } from "react";

export function PageHeader({ title, en, description, actions }: { title: string; en: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-[0.28em] text-gold">{en}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Card({ title, children, className = "", aside }: { title?: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={`min-w-0 rounded-lg border border-line bg-navy-900 p-4 sm:p-5 ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export type Kind = "actual" | "sample" | "forecast" | "estimate" | "setting" | "none";

const KIND: Record<Kind, { label: string; cls: string }> = {
  actual: { label: "実データ", cls: "border-good/40 text-good" },
  sample: { label: "サンプル", cls: "border-warn/60 text-warn bg-warn/10" },
  forecast: { label: "予測", cls: "border-info/50 text-info" },
  estimate: { label: "推計", cls: "border-info/50 text-info" },
  setting: { label: "設定値", cls: "border-fg-subtle/50 text-fg-muted" },
  none: { label: "未計測", cls: "border-fg-subtle/40 text-fg-subtle" },
};

export function DataBadge({ kind }: { kind: Kind }) {
  const k = KIND[kind];
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] leading-4 font-medium ${k.cls}`}>{k.label}</span>;
}

/** 行の data_kind（actual/sample/...）から、サンプルを含むかどうかでバッジを選ぶ */
export function kindOf(kinds: string | null | undefined): Kind {
  if (!kinds) return "actual";
  if (kinds.includes("sample")) return "sample";
  if (kinds.includes("forecast")) return "forecast";
  return "actual";
}

export function StatTile({
  label,
  value,
  kind,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  kind: Kind;
  sub?: ReactNode;
  tone?: "good" | "warn" | "bad";
}) {
  const toneCls = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "good" ? "text-good" : "text-fg";
  return (
    <div className="min-w-0 rounded-lg border border-line bg-navy-900 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-fg-muted">{label}</p>
        <DataBadge kind={kind} />
      </div>
      <p className={`num mt-2 truncate text-2xl font-semibold tracking-tight ${toneCls}`}>{value}</p>
      {sub && <div className="mt-1 text-xs text-fg-subtle">{sub}</div>}
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  // AI社員
  not_connected: { label: "未接続", cls: "text-fg-subtle border-fg-subtle/40" },
  idle: { label: "待機中", cls: "text-good border-good/40" },
  running: { label: "実行中", cls: "text-info border-info/50" },
  paused: { label: "停止中", cls: "text-warn border-warn/50" },
  error: { label: "エラー", cls: "text-bad border-bad/50" },
  // 承認
  pending: { label: "承認待ち", cls: "text-warn border-warn/50" },
  approved: { label: "承認済み", cls: "text-good border-good/40" },
  rejected: { label: "却下", cls: "text-bad border-bad/50" },
  on_hold: { label: "保留", cls: "text-fg-muted border-fg-subtle/40" },
  // 商品
  planning: { label: "企画中", cls: "text-fg-muted border-fg-subtle/40" },
  producing: { label: "制作中", cls: "text-info border-info/50" },
  review: { label: "検査中", cls: "text-warn border-warn/50" },
  done: { label: "完成", cls: "text-good border-good/40" },
  not_started: { label: "未検査", cls: "text-fg-subtle border-fg-subtle/40" },
  in_progress: { label: "検査中", cls: "text-warn border-warn/50" },
  passed: { label: "合格", cls: "text-good border-good/40" },
  failed: { label: "不合格", cls: "text-bad border-bad/50" },
  not_for_sale: { label: "販売前", cls: "text-fg-subtle border-fg-subtle/40" },
  ready: { label: "販売準備OK", cls: "text-info border-info/50" },
  on_sale: { label: "販売中", cls: "text-good border-good/40" },
  stopped: { label: "販売停止", cls: "text-bad border-bad/50" },
  // コンテンツ
  draft: { label: "下書き", cls: "text-fg-muted border-fg-subtle/40" },
  pending_approval: { label: "承認待ち", cls: "text-warn border-warn/50" },
  scheduled: { label: "予約済み", cls: "text-info border-info/50" },
  posted: { label: "投稿済み", cls: "text-good border-good/40" },
  skipped: { label: "見送り", cls: "text-fg-subtle border-fg-subtle/40" },
  // 実行履歴
  success: { label: "成功", cls: "text-good border-good/40" },
  queued: { label: "受付", cls: "text-info border-info/50" },
  blocked_budget: { label: "予算で停止", cls: "text-bad border-bad/50" },
  // タスク
  todo: { label: "未着手", cls: "text-fg-muted border-fg-subtle/40" },
  doing: { label: "対応中", cls: "text-info border-info/50" },
  cancelled: { label: "中止", cls: "text-fg-subtle border-fg-subtle/40" },
  // 問い合わせ
  new: { label: "新規", cls: "text-info border-info/50" },
  needs_owner: { label: "代表者判断", cls: "text-warn border-warn/50" },
  closed: { label: "完了", cls: "text-fg-subtle border-fg-subtle/40" },
  open: { label: "未達成", cls: "text-fg-muted border-fg-subtle/40" },
  achieved: { label: "達成", cls: "text-good border-good/40" },
  missed: { label: "未達（期限切れ）", cls: "text-bad border-bad/50" },
};

export function statusLabel(s: string): string {
  return STATUS[s]?.label ?? s;
}

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "text-fg-muted border-fg-subtle/40" };
  return <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px] ${s.cls}`}>{s.label}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-navy-700 px-3 py-4 text-center text-sm text-fg-subtle">{children}</p>;
}

export function Button({
  children,
  variant = "primary",
  name,
  value,
  disabled,
  title,
}: {
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  name?: string;
  value?: string;
  disabled?: boolean;
  title?: string;
}) {
  const cls =
    variant === "primary"
      ? "bg-gold-strong text-ink hover:bg-gold"
      : variant === "danger"
        ? "border border-bad/50 text-bad hover:bg-bad/10"
        : "border border-navy-700 text-fg hover:border-gold-dim";
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

/** 横スクロールはテーブル内だけで起こし、ページ全体は横にはみ出さない */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">{children}</div>;
}

export const th = "whitespace-nowrap border-b border-line px-2 py-2 text-left text-xs font-medium text-fg-muted";
export const td = "border-b border-line/60 px-2 py-2 align-top text-sm";

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: ReactNode }) {
  const cls = tone === "bad" ? "border-bad/50 bg-bad/10" : tone === "warn" ? "border-warn/50 bg-warn/10" : "border-navy-700 bg-navy-800";
  const icon = tone === "bad" ? "■" : tone === "warn" ? "▲" : "●";
  const iconCls = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-gold";
  return (
    <div className={`flex gap-2 rounded-md border px-3 py-2 text-sm ${cls}`}>
      <span aria-hidden className={`${iconCls} text-xs leading-6`}>{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
