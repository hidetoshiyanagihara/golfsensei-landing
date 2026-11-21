import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AI CEO COMMAND CENTER", template: "%s｜AI CEO COMMAND CENTER" },
  description: "AI CEO PROJECT の管理画面",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#080d1a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
