import Link from "next/link";
export default function NotFound() {
  return (
    <div className="py-20 text-center">
      <p className="text-[11px] tracking-[0.3em] text-gold">404</p>
      <p className="mt-2 text-lg">ページが見つかりません</p>
      <Link href="/dashboard" className="mt-4 inline-block text-sm text-gold hover:underline">ダッシュボードへ</Link>
    </div>
  );
}
