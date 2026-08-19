import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server to serve dev-only assets to phones/tablets on the LAN.
  // Hostnames only — no scheme or port.
  allowedDevOrigins: ["10.0.0.111"],
  turbopack: {
    root: __dirname,
  },
  async rewrites() {
    const api = (process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL || "http://localhost:8787").replace(/\/$/, "");
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
