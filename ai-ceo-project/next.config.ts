import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 管理画面は外部に公開しない前提。検索エンジンに載らないようにする
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  poweredByHeader: false,
};

export default nextConfig;
