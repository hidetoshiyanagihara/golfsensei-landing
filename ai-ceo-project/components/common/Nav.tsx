"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/dashboard", label: "ダッシュボード", en: "DASHBOARD" },
  { href: "/agents", label: "AI社員", en: "AI EMPLOYEES" },
  { href: "/business", label: "事業開発", en: "BUSINESS" },
  { href: "/products", label: "商品管理", en: "PRODUCTS" },
  { href: "/marketing", label: "コンテンツ", en: "CONTENT" },
  { href: "/finance", label: "財務", en: "FINANCE" },
  { href: "/reports", label: "経営会議", en: "MEETING" },
  { href: "/settings", label: "設定", en: "SETTINGS" },
];

export function Nav({ onNavigate }: { onNavigate?: boolean }) {
  const path = usePathname();
  return (
    <nav aria-label="メインメニュー">
      <ul className="flex flex-col gap-0.5">
        {NAV.map((n) => {
          const active = path === n.href || path.startsWith(n.href + "/");
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate ? (e) => (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open") : undefined}
                className={`flex items-baseline justify-between gap-2 rounded-md border-l-2 px-3 py-2 text-sm transition-colors ${
                  active ? "border-gold bg-navy-800 text-fg" : "border-transparent text-fg-muted hover:bg-navy-900 hover:text-fg"
                }`}
              >
                <span>{n.label}</span>
                <span className="text-[9px] tracking-[0.18em] text-fg-subtle">{n.en}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
