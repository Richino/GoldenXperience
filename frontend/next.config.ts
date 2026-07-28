import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server to serve dev-only assets to phones/tablets on the LAN.
  // Hostnames only — no scheme or port.
  allowedDevOrigins: ["10.0.0.111"],
};

export default nextConfig;
