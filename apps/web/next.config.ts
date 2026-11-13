import type { NextConfig } from "next";
import path from "node:path";
import packageJson from "./package.json";

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: blob: data:",
  "media-src 'self' https: blob: data:",
  "font-src 'self' https: data:",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version
  },
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  outputFileTracingExcludes: {
    "*": [
      "./node_modules/.pnpm/esbuild@*/**",
      "./node_modules/.pnpm/@esbuild+*/**",
      "./node_modules/.pnpm/sharp@*/**",
      "./node_modules/.pnpm/@img+*/**"
    ]
  },
  typedRoutes: true,
  transpilePackages: ["@soqaro/shared"],
  async headers() {
    return [
      {
        // PWA manifest 变更需要及时生效,只做短缓存。
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
          { key: "Content-Type", value: "application/manifest+json" }
        ]
      },
      {
        // 静态图标与房间封面走内容寻址/低频变更,可长缓存。
        source: "/:asset(icons|room-covers)/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" }]
      },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
        ]
      }
    ];
  },
  async redirects() {
    return [
      {
        source: "/",
        destination: "/app",
        permanent: false
      }
    ];
  }
};

export default nextConfig;
