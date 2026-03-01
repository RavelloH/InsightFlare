import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // typedRoutes disabled for [locale] dynamic routes
  // typedRoutes: true,
  experimental: {
    adapterPath: "@opennextjs/cloudflare",
  },
};

export default nextConfig;
